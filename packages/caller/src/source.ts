import ts from 'typescript';
import type { OpenApiDocument } from '@contractguard/core';
import type { CallerCallsite, CallerFile } from './types.js';
import { CALLER_LIMITS } from './validate.js';

export interface Site { node: ts.CallExpression; report: CallerCallsite }
export interface ParsedFile {
  file: CallerFile; source: ts.SourceFile; sites: Site[];
  functions: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>;
  axiosAliases: Set<string>; problem?: string;
}
export const REPLAY_BUILTINS = new Set(['fetch', 'String', 'Number', 'Boolean', 'undefined', 'Error']);
export function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
export function literal(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined; node = unwrap(node);
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}
export function hasExport(node: ts.Node): boolean { return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword); }
export function functionName(node: ts.Node): string {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text ?? '<anonymous>';
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) return ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name) ? parent.parent.name.text : '<anonymous>';
  }
  return '<module>';
}
export function routePath(url: string, documents: OpenApiDocument[]): string | undefined {
  let path = url;
  try {
    if (/^https?:\/\//.test(path)) { const url = new URL(path); if (url.username || url.password) return undefined; path = url.pathname; }
    else if (path.startsWith('/') && !path.startsWith('//')) path = path.split(/[?#]/, 1)[0]!;
    else return undefined;
  } catch { return undefined; }
  const paths = [...new Set(documents.flatMap((doc) => Object.keys(doc.paths ?? {})))];
  if (paths.includes(path)) return path;
  const matches = paths.filter((template) => {
    const a = template.split('/'); const b = path.split('/');
    return a.length === b.length && a.every((part, i) => /^\{[^{}]+\}$/.test(part) ? !!b[i] : part === b[i]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}
export function requestSyntax(node: ts.CallExpression, aliases: Set<string>): { client: 'fetch' | 'axios'; method?: string; url?: string } | undefined {
  const call = unwrap(node.expression);
  if (ts.isIdentifier(call) && call.text === 'fetch') {
    let method: string | undefined = 'GET';
    if (node.arguments[1]) {
      const options = unwrap(node.arguments[1]);
      if (!ts.isObjectLiteralExpression(options)) method = undefined;
      else {
        for (const field of options.properties) {
          if (!ts.isPropertyAssignment(field) || (!ts.isIdentifier(field.name) && !ts.isStringLiteral(field.name))) { method = undefined; break; }
          if (field.name.text === 'method') method = literal(field.initializer)?.toUpperCase();
        }
      }
    }
    return { client: 'fetch', ...(method ? { method } : {}), ...(literal(node.arguments[0]) !== undefined ? { url: literal(node.arguments[0])! } : {}) };
  }
  if (ts.isPropertyAccessExpression(call) && ts.isIdentifier(call.expression) && aliases.has(call.expression.text) && /^(get|post|put|patch|delete|head|options)$/.test(call.name.text)) {
    const url = literal(node.arguments[0]); return { client: 'axios', method: call.name.text.toUpperCase(), ...(url === undefined ? {} : { url }) };
  }
  return undefined;
}
function shadowsFetch(node: ts.Node): boolean {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor && !ts.isSourceFile(ancestor)) {
    if (ts.isFunctionLike(ancestor) && ancestor.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === 'fetch')) return true;
    ancestor = ancestor.parent;
  }
  return false;
}
export function parseCallerFile(file: CallerFile, documents: OpenApiDocument[], firstId: number): ParsedFile {
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.ES2022, true, file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parsed: ParsedFile = { file, source, sites: [], functions: new Map(), axiosAliases: new Set() };
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length) parsed.problem = `TypeScript syntax error: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ')}`;
  const topLevelNames = new Set<string>();
  for (const stmt of source.statements) {
    const names = ts.isFunctionDeclaration(stmt) && stmt.name ? [stmt.name.text] : ts.isVariableStatement(stmt) ? stmt.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => (d.name as ts.Identifier).text) : ts.isImportDeclaration(stmt) && stmt.importClause?.name ? [stmt.importClause.name.text] : [];
    for (const name of names) {
      if (REPLAY_BUILTINS.has(name) || topLevelNames.has(name)) parsed.problem ??= `Top-level binding ${name} shadows a replay builtin or duplicates a declaration.`;
      topLevelNames.add(name);
    }
    if (ts.isImportDeclaration(stmt)) {
      if (ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === 'axios' && stmt.importClause?.name && !stmt.importClause.namedBindings) parsed.axiosAliases.add(stmt.importClause.name.text);
      else if (!stmt.importClause?.isTypeOnly) parsed.problem ??= 'Only a default axios import and type-only imports are supported; modules are never loaded.';
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body && hasExport(stmt)) parsed.functions.set(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt) && hasExport(stmt) && stmt.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(unwrap(d.initializer)) || ts.isFunctionExpression(unwrap(d.initializer))))) {
      for (const d of stmt.declarationList.declarations) parsed.functions.set((d.name as ts.Identifier).text, unwrap(d.initializer!) as ts.ArrowFunction);
    } else if (!(ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEmptyStatement(stmt) || (ts.isFunctionDeclaration(stmt) && stmt.body))) parsed.problem ??= 'Module initializers, re-exports, classes and side effects are not executed by the bounded replay.';
  }
  const stack: Array<{ node: ts.Node; depth: number }> = [{ node: source, depth: 0 }]; let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > CALLER_LIMITS.astNodes || current.depth > 200) { parsed.problem = 'Source AST exceeds its node/depth budget.'; break; }
    if (ts.isCallExpression(current.node)) {
      const syntax = requestSyntax(current.node, parsed.axiosAliases);
      if (syntax) {
        const { line, character } = source.getLineAndCharacterOfPosition(current.node.getStart(source));
        const path = syntax.url === undefined ? undefined : routePath(syntax.url, documents);
        const reason = shadowsFetch(current.node) ? 'fetch is shadowed by a function parameter.' : syntax.url === undefined ? 'Dynamic URL: a literal route is required for static attribution.' : !path ? 'URL does not unambiguously match a submitted OpenAPI path.' : !syntax.method ? 'HTTP method is not statically known.' : undefined;
        parsed.sites.push({ node: current.node, report: { id: `CALL-${String(firstId + parsed.sites.length).padStart(4, '0')}`, file: file.path, line: line + 1, column: character + 1, exportName: functionName(current.node), client: syntax.client, method: syntax.method ?? null, path: path ?? null, status: reason ? 'unknown' : 'resolved', ...(reason ? { reason } : {}), fields: [], relatedChangeIds: [] } });
      }
    }
    const children: ts.Node[] = []; ts.forEachChild(current.node, (child) => { children.push(child); });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, depth: current.depth + 1 });
  }
  return parsed;
}
