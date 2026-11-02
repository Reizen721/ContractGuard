import ts from 'typescript';
import { canonicalJson } from '@contractguard/core';
import type { CallerReplayOutcome, CallerResponse, CallerScenario, JsonValue } from './types.js';
import { CALLER_LIMITS, jsonValue, safeKey } from './validate.js';
import { type ParsedFile, type Site, unwrap, REPLAY_BUILTINS } from './source.js';

interface Origin { siteId: string; path: string[] }
interface Value { kind: 'value'; value: unknown; origin?: Origin }
interface Token { kind: 'fetch' | 'axios' | 'fetch-response' | 'axios-response'; site?: Site }
type Runtime = Value | Token;
type Environment = Map<string, Runtime>;
export interface ObservedRead { siteId: string; path: string[]; node: ts.PropertyAccessExpression | ts.ElementAccessExpression; key: string; start: number; end: number; before: string }
export interface ReplayResult { outcome: CallerReplayOutcome; reads: ObservedRead[]; siteIds: string[] }
class Unsupported extends Error { constructor(message: string) { super(message); } }
class Returned { constructor(readonly value: Runtime) {} }
class Broken {}
function value(input: unknown, origin?: Origin): Value {
  // Charge expanded structure before serialization, including repeated aliases.
  // A tiny expression can otherwise construct an exponentially large JSON tree.
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]; let nodes = 0; let size = 0;
  while (pending.length) {
    const item = pending.pop()!; if (++nodes > 20_000 || item.depth > CALLER_LIMITS.depth) throw new Unsupported('Runtime value exceeds its node/depth budget.');
    size += typeof item.value === 'string' ? item.value.length * 2 : 8;
    if (size > 128 * 1024) throw new Unsupported('Runtime value exceeds its 128 KiB size budget.');
    if (item.value !== null && typeof item.value === 'object') {
      for (const key of Object.keys(item.value)) { size += key.length * 2; pending.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 }); }
      if (pending.length > 20_000) throw new Unsupported('Runtime value exceeds its node budget.');
    }
  }
  return { kind: 'value', value: input, ...(origin ? { origin } : {}) };
}
function raw(input: Runtime): unknown { if (input.kind !== 'value') throw new Unsupported('A network response handle cannot be used as a JSON value.'); return input.value; }
function string(input: Runtime): string { const result = raw(input); if (typeof result !== 'string') throw new Error('Expected a string value.'); return result; }
function scalar(input: Runtime): string | number | boolean | null | undefined {
  const result = raw(input); if (result !== null && result !== undefined && !['string', 'number', 'boolean'].includes(typeof result)) throw new Unsupported('Only primitive conversion is supported.'); return result as string | number | boolean | null | undefined;
}
export function replay(parsed: ParsedFile, scenario: CallerScenario, response: CallerResponse): ReplayResult {
  let steps = 0; let requests = 0; let depth = 0; let bodyReads = 0;
  const reads: ObservedRead[] = []; const siteIds = new Set<string>();
  const charge = (): void => { if (++steps > CALLER_LIMITS.steps) throw new Unsupported('Replay step budget exceeded.'); };
  function requireAwait(node: ts.CallExpression): void {
    let parent: ts.Node = node.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) parent = parent.parent;
    if (!ts.isAwaitExpression(parent)) throw new Unsupported('Network and response.json calls require an explicit await in this replay profile.');
  }
  function access(receiver: Runtime, key: string, node: ts.PropertyAccessExpression | ts.ElementAccessExpression): Runtime {
    if (!safeKey(key)) throw new Unsupported('Prototype-sensitive property access is not supported.');
    if (receiver.kind === 'fetch-response' || receiver.kind === 'axios-response') {
      if (key === 'status') return value(response.status);
      if (key === 'ok' && receiver.kind === 'fetch-response') return value(response.status >= 200 && response.status < 300);
      if (key === 'data' && receiver.kind === 'axios-response') return value(response.body, { siteId: receiver.site!.report.id, path: [] });
      throw new Unsupported(`Response property ${key} is outside the replay profile.`);
    }
    const input = raw(receiver);
    if (input === null || input === undefined) throw new Error(`Cannot read property ${key} of ${input === null ? 'null' : 'undefined'}.`);
    if (receiver.kind === 'value' && receiver.origin) {
      const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression!;
      reads.push({ siteId: receiver.origin.siteId, path: [...receiver.origin.path, key], node, key, start: nameNode.getStart(parsed.source), end: nameNode.end, before: nameNode.getText(parsed.source) });
    }
    let output: unknown;
    if (typeof input === 'string' && key === 'length') output = input.length;
    else if (Array.isArray(input) && key === 'length') output = input.length;
    else if ((typeof input === 'object' || typeof input === 'string') && Object.hasOwn(Object(input) as object, key)) output = (input as Record<string, unknown>)[key];
    else output = undefined;
    return value(output, receiver.kind === 'value' && receiver.origin ? { siteId: receiver.origin.siteId, path: [...receiver.origin.path, key] } : undefined);
  }
  function request(node: ts.CallExpression, client: 'fetch' | 'axios', method: string, args: Runtime[]): Runtime {
    requireAwait(node);
    const site = parsed.sites.find((item) => item.node === node);
    if (!site || site.report.status !== 'resolved') throw new Unsupported(site?.report.reason ?? 'Request is not statically attributable.');
    const url = string(args[0]!);
    if (!url || site.report.method !== method || method !== scenario.operation.method || site.report.path !== scenario.operation.path) throw new Unsupported('Scenario operation does not match the source request.');
    if (++requests > 1) throw new Unsupported('A replay scenario supports exactly one request; multi-request workflows remain unknown.');
    siteIds.add(site.report.id);
    if (client === 'axios' && (response.status < 200 || response.status >= 300)) throw new Error(`Axios request rejected with status ${response.status}.`);
    return { kind: client === 'fetch' ? 'fetch-response' : 'axios-response', site };
  }
  function call(node: ts.CallExpression, env: Environment): Runtime {
    const target = unwrap(node.expression);
    if (node.arguments.some(ts.isSpreadElement)) throw new Unsupported('Spread call arguments are not supported.');
    if (ts.isIdentifier(target)) {
      const bound = env.get(target.text);
      if (bound?.kind === 'fetch') {
        const args = node.arguments.map((arg) => expression(arg, env));
        let method = 'GET';
        if (args.length > 2) throw new Unsupported('Extra fetch arguments are outside the replay profile.');
        if (args[1]) { const options = raw(args[1]); if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Unsupported('fetch options must be an object.'); if (Object.keys(options).some((key) => key !== 'method')) throw new Unsupported('Only the fetch method option is supported; headers/body/transport options require separate verification.'); const selected = (options as Record<string, unknown>).method; if (selected !== undefined) { if (typeof selected !== 'string') throw new Unsupported('HTTP method must be a string.'); method = selected.toUpperCase(); } }
        return request(node, 'fetch', method, args);
      }
      if (['String', 'Number', 'Boolean'].includes(target.text) && !env.has(target.text)) {
        if (node.arguments.length !== 1) throw new Unsupported('Conversions require exactly one argument.'); const input = scalar(expression(node.arguments[0]!, env));
        const output = target.text === 'String' ? String(input) : target.text === 'Number' ? Number(input) : Boolean(input);
        if (typeof output === 'number' && !Number.isFinite(output)) throw new Error('Conversion produced a nonfinite number.'); return value(output);
      }
      throw new Unsupported(`Function ${target.text} is not on the replay allowlist.`);
    }
    if (ts.isPropertyAccessExpression(target)) {
      const receiver = expression(target.expression, env); const method = target.name.text;
      if (!safeKey(method)) throw new Unsupported('Prototype-sensitive method access is not supported.');
      if (receiver.kind === 'axios' && /^(get|post|put|patch|delete|head|options)$/.test(method)) { if (node.arguments.length !== 1) throw new Unsupported('Axios body/config arguments are outside the replay profile.'); return request(node, 'axios', method.toUpperCase(), node.arguments.map((arg) => expression(arg, env))); }
      if (receiver.kind === 'fetch-response' && method === 'json' && node.arguments.length === 0) { requireAwait(node); if (++bodyReads > 1) throw new Unsupported('Repeated response body consumption is outside the replay profile.'); return value(response.body, { siteId: receiver.site!.report.id, path: [] }); }
      if (receiver.kind !== 'value') throw new Unsupported('This network response method is not supported.');
      if (target.questionDotToken && (receiver.value === undefined || receiver.value === null)) return value(undefined);
      if (receiver.value === undefined || receiver.value === null) throw new Error(`Cannot call ${method} on ${receiver.value === null ? 'null' : 'undefined'}.`);
      const args = node.arguments.map((arg) => expression(arg, env));
      if (typeof receiver.value === 'string') {
        const input = receiver.value;
        if (['toUpperCase', 'toLowerCase', 'trim'].includes(method) && args.length === 0) return value(method === 'toUpperCase' ? input.toUpperCase() : method === 'toLowerCase' ? input.toLowerCase() : input.trim());
        if (['includes', 'startsWith', 'endsWith'].includes(method) && args.length === 1) { const needle = string(args[0]!); return value(method === 'includes' ? input.includes(needle) : method === 'startsWith' ? input.startsWith(needle) : input.endsWith(needle)); }
        if (method === 'slice' && args.length >= 1 && args.length <= 2) { const start = raw(args[0]!); const end = args[1] ? raw(args[1]) : undefined; if (typeof start !== 'number' || !Number.isInteger(start) || (end !== undefined && (typeof end !== 'number' || !Number.isInteger(end)))) throw new Unsupported('slice indices must be integers.'); return value(input.slice(start, end as number | undefined)); }
        throw new Unsupported(`String method ${method} is not supported.`);
      }
      if (Array.isArray(receiver.value) && method === 'join' && args.length <= 1 && receiver.value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) { const separator = args[0] ? string(args[0]) : ','; if (receiver.value.reduce((size, item) => size + String(item ?? '').length, 0) + separator.length * receiver.value.length > 64 * 1024) throw new Unsupported('String join exceeds its output budget.'); return value(receiver.value.join(separator)); }
      if (['toUpperCase', 'toLowerCase', 'trim', 'slice', 'includes', 'startsWith', 'endsWith', 'join'].includes(method) && !Array.isArray(receiver.value)) throw new Error(`Value does not support method ${method}.`);
      throw new Unsupported(`Method ${method} is outside the replay profile.`);
    }
    throw new Unsupported('Dynamic method calls are not supported.');
  }
  function expression(node: ts.Expression, env: Environment): Runtime {
    charge(); if (++depth > CALLER_LIMITS.depth) { depth--; throw new Unsupported('Replay expression depth budget exceeded.'); }
    try {
      node = unwrap(node);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && (node.flags & ts.NodeFlags.OptionalChain)) throw new Unsupported('Optional chaining is outside the replay profile; use explicit null checks.');
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return value(node.text);
      if (ts.isNumericLiteral(node)) return value(Number(node.text));
      if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return value(node.kind === ts.SyntaxKind.TrueKeyword);
      if (node.kind === ts.SyntaxKind.NullKeyword) return value(null);
      if (ts.isIdentifier(node)) { if (node.text === 'undefined') return value(undefined); const result = env.get(node.text); if (!result) throw new Unsupported(`Unknown binding ${node.text}; external modules and globals are not executed.`); return result; }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const receiver = expression(node.expression, env);
        if (node.questionDotToken && receiver.kind === 'value' && (receiver.value === null || receiver.value === undefined)) return value(undefined);
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : scalar(expression(node.argumentExpression, env));
        if (typeof key !== 'string' && typeof key !== 'number') throw new Unsupported('Property key must be a string or number.');
        return access(receiver, String(key), node);
      }
      if (ts.isCallExpression(node)) return call(node, env);
      if (ts.isArrayLiteralExpression(node)) { if (node.elements.some((item) => ts.isSpreadElement(item) || ts.isOmittedExpression(item))) throw new Unsupported('Array spread/holes are unsupported.'); return value(node.elements.map((item) => raw(expression(item as ts.Expression, env)))); }
      if (ts.isObjectLiteralExpression(node)) {
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const property of node.properties) {
          if (ts.isShorthandPropertyAssignment(property)) { if (!safeKey(property.name.text)) throw new Unsupported('Unsafe object key.'); result[property.name.text] = raw(expression(property.name, env)); }
          else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) { if (!safeKey(property.name.text)) throw new Unsupported('Unsafe object key.'); result[property.name.text] = raw(expression(property.initializer, env)); }
          else throw new Unsupported('Computed object fields, methods, accessors and spread are unsupported.');
        }
        return value(result);
      }
      if (ts.isConditionalExpression(node)) return expression(raw(expression(node.condition, env)) ? node.whenTrue : node.whenFalse, env);
      if (ts.isTemplateExpression(node)) { let output = node.head.text; for (const span of node.templateSpans) { output += String(scalar(expression(span.expression, env))) + span.literal.text; if (output.length > 64 * 1024) throw new Unsupported('String output budget exceeded.'); } return value(output); }
      if (ts.isTypeOfExpression(node)) return value(typeof raw(expression(node.expression, env)));
      if (ts.isPrefixUnaryExpression(node)) { const input = scalar(expression(node.operand, env)); if (node.operator === ts.SyntaxKind.ExclamationToken) return value(!input); if (node.operator === ts.SyntaxKind.MinusToken && typeof input === 'number') return value(-input); if (node.operator === ts.SyntaxKind.PlusToken && typeof input === 'number') return value(input); throw new Unsupported('Unary operator is unsupported.'); }
      if (ts.isBinaryExpression(node)) {
        const left = expression(node.left, env); const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) return raw(left) ? expression(node.right, env) : left;
        if (op === ts.SyntaxKind.BarBarToken) return raw(left) ? left : expression(node.right, env);
        if (op === ts.SyntaxKind.QuestionQuestionToken) return raw(left) === null || raw(left) === undefined ? expression(node.right, env) : left;
        const a = scalar(left); const b = scalar(expression(node.right, env));
        if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) return value(a === b);
        if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken) return value(a !== b);
        if (op === ts.SyntaxKind.PlusToken && ((typeof a === 'string' && typeof b === 'string') || (typeof a === 'number' && typeof b === 'number'))) return value(typeof a === 'string' ? a + b : a + (b as number));
        if (typeof a === 'number' && typeof b === 'number') {
          if (op === ts.SyntaxKind.GreaterThanToken) return value(a > b); if (op === ts.SyntaxKind.LessThanToken) return value(a < b);
          if (op === ts.SyntaxKind.GreaterThanEqualsToken) return value(a >= b); if (op === ts.SyntaxKind.LessThanEqualsToken) return value(a <= b);
          if (op === ts.SyntaxKind.MinusToken) return value(a - b); if (op === ts.SyntaxKind.AsteriskToken) return value(a * b);
          if (op === ts.SyntaxKind.SlashToken && b !== 0) return value(a / b);
        }
        throw new Unsupported('Binary operator or operand combination is unsupported.');
      }
      throw new Unsupported(`Unsupported expression: ${ts.SyntaxKind[node.kind]}.`);
    } finally { depth--; }
  }
  function statement(node: ts.Statement, env: Environment): void {
    charge();
    if (ts.isBlock(node)) { const local = new Map(env); for (const child of node.statements) statement(child, local); return; }
    if (ts.isVariableStatement(node)) {
      if (!(node.declarationList.flags & ts.NodeFlags.Const)) throw new Unsupported('Only const bindings are supported; mutable state remains unknown.');
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw new Unsupported('Destructuring and uninitialized bindings are unsupported.');
        if (!safeKey(declaration.name.text)) throw new Unsupported('Unsafe binding.');
        const evaluated = expression(declaration.initializer, env); env.set(declaration.name.text, evaluated);
      }
      return;
    }
    if (ts.isReturnStatement(node)) throw new Returned(node.expression ? expression(node.expression, env) : value(undefined));
    if (ts.isIfStatement(node)) { if (raw(expression(node.expression, env))) statement(node.thenStatement, env); else if (node.elseStatement) statement(node.elseStatement, env); return; }
    if (ts.isSwitchStatement(node)) {
      const discriminant = scalar(expression(node.expression, env)); let index = node.caseBlock.clauses.findIndex((clause) => ts.isCaseClause(clause) && scalar(expression(clause.expression, env)) === discriminant);
      if (index < 0) index = node.caseBlock.clauses.findIndex(ts.isDefaultClause);
      if (index >= 0) try { const local = new Map(env); for (const clause of node.caseBlock.clauses.slice(index)) for (const child of clause.statements) statement(child, local); } catch (error) { if (!(error instanceof Broken)) throw error; }
      return;
    }
    if (ts.isBreakStatement(node) && !node.label) throw new Broken();
    if (ts.isThrowStatement(node)) {
      const expr = unwrap(node.expression);
      if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Error' && expr.arguments?.length === 1 && !env.has('Error')) throw new Error(string(expression(expr.arguments[0]!, env)));
      throw new Error(String(scalar(expression(expr, env))));
    }
    if (ts.isExpressionStatement(node)) { expression(node.expression, env); return; }
    if (ts.isEmptyStatement(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    throw new Unsupported(`Unsupported statement: ${ts.SyntaxKind[node.kind]}.`);
  }
  let outcome: CallerReplayOutcome;
  try {
    if (parsed.problem) throw new Unsupported(parsed.problem);
    const fn = parsed.functions.get(scenario.exportName); if (!fn?.body) throw new Unsupported('Named exported function was not found.');
    if ('asteriskToken' in fn && fn.asteriskToken) throw new Unsupported('Generator functions are unsupported.');
    if (!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) throw new Unsupported('The request entry point must be an async function.');
    if (fn.parameters.some((p) => !ts.isIdentifier(p.name) || p.dotDotDotToken || p.initializer)) throw new Unsupported('Only simple parameters without defaults/rest are supported.');
    if (fn.parameters.length !== scenario.args.length) throw new Unsupported('Scenario args must exactly match the declared function parameters.');
    // Reject shadowing throughout the entry point, including unexecuted branches.
    // This deliberately avoids approximating JavaScript lexical TDZ/hoisting rules.
    const bindings = new Set<string>();
    const bindingNodes: ts.Node[] = [fn];
    while (bindingNodes.length) {
      const node = bindingNodes.pop()!;
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
        const name = node.name.text;
        if (bindings.has(name) || REPLAY_BUILTINS.has(name) || parsed.axiosAliases.has(name)) throw new Unsupported(`Binding ${name} shadows another binding or a replay builtin; lexical shadowing is outside the profile.`);
        bindings.add(name);
      }
      ts.forEachChild(node, (child) => { bindingNodes.push(child); });
    }
    const env: Environment = new Map([['fetch', { kind: 'fetch' }]]);
    for (const alias of parsed.axiosAliases) env.set(alias, { kind: 'axios' });
    fn.parameters.forEach((param, i) => env.set((param.name as ts.Identifier).text, value(scenario.args[i])));
    let output: Runtime = value(undefined);
    try { if (ts.isBlock(fn.body)) statement(fn.body, env); else output = expression(fn.body, env); } catch (returned) { if (returned instanceof Returned) output = returned.value; else throw returned; }
    if (requests !== 1) throw new Unsupported('Scenario did not execute exactly one attributable request.');
    const observed = raw(output); jsonValue(observed);
    if (Buffer.byteLength(JSON.stringify(observed)) > 128 * 1024) throw new Unsupported('Output exceeds 128 KiB.');
    const passed = canonicalJson(observed) === canonicalJson(scenario.expected);
    outcome = { status: passed ? 'passed' : 'failed', value: observed, ...(passed ? {} : { error: 'Observed return value does not equal the explicit scenario oracle.' }), steps, requests };
  } catch (error) {
    outcome = { status: error instanceof Unsupported ? 'unsupported' : 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Replay terminated without a supported return value.', steps, requests };
  }
  return { outcome, reads, siteIds: [...siteIds] };
}
