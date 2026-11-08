import { dirname, posix } from 'node:path';
import ts from 'typescript';
import {
  analyzeRelease,
  inferSchemaMigrations,
  prepareContract,
  type OpenApiDocument,
  type OpenApiInput,
  type SchemaAlignmentReport,
} from '@contractguard/core';
import type { CallerFile } from './types.js';

export interface CompilerDiagnostic {
  code: number;
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface TypecheckReport {
  clean: boolean;
  diagnostics: CompilerDiagnostic[];
}

export interface TrackedHttpCallsite {
  id: string;
  file: string;
  line: number;
  column: number;
  enclosingFunction: string;
  clientKind: 'fetch' | 'method-client' | 'openapi-client';
  method: string;
  rawUrlText: string;
  matchedPath: string | null;
  urlNodeStart: number;
  urlNodeEnd: number;
  callNodeStart: number;
  callNodeEnd: number;
  hasSecondArg: boolean;
  secondArgStart?: number;
  secondArgEnd?: number;
}

export type FieldUsageKind =
  | 'property-access'
  | 'optional-chain'
  | 'element-access'
  | 'destructure-binding'
  | 'enum-switch'
  | 'dictionary-lookup';

export interface TrackedFieldUsage {
  id: string;
  callsiteId: string;
  operation: { method: string; path: string };
  dotPath: string;
  leaf: string;
  file: string;
  line: number;
  column: number;
  /** Exact span of the property identifier or binding, suitable for AST patching */
  identStart: number;
  identEnd: number;
  /** Span of the full property access expression (e.g. `order.customerName`), suitable for coercions/null-guards */
  exprStart: number;
  exprEnd: number;
  exprText: string;
  usageKind: FieldUsageKind;
  /** Downstream sink context, e.g. 'method:toUpperCase', 'dictionary-index', 'switch-discriminant', 'arithmetic' */
  sinkContext?: string;
}

export interface CrossFileCallEdge {
  fromFile: string;
  fromFunction: string;
  toFile: string;
  toFunction: string;
  line: number;
}

export interface ProgramSlice {
  file: string;
  declarations: string[];
  slicedCode: string;
  fullChars: number;
  slicedChars: number;
}

export interface ProgramDataflowReport {
  typecheck: TypecheckReport;
  callsites: TrackedHttpCallsite[];
  fieldUsages: TrackedFieldUsage[];
  callEdges: CrossFileCallEdge[];
  slices: ProgramSlice[];
  metrics: {
    totalFiles: number;
    impactedFiles: number;
    fullTokensApprox: number;
    slicedTokensApprox: number;
    compressionRatio: number;
  };
  reachability: {
    staticBreakingCount: number;
    reachableBreakingChangeIds: string[];
    unreachableBreakingChangeIds: string[];
    reachableHypothesisIds: string[];
    hasUncalledBreakingOnly: boolean;
  };
}

interface OriginRef {
  callsiteId: string;
  operation: { method: string; path: string };
  path: string[];
}

const VIRTUAL_AMBIENT_PATH = '/__virtual__/ambient.d.ts';
const VIRTUAL_AMBIENT_CONTENT = `
declare var fetch: (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;
declare class URL {
  constructor(url: string, base?: string);
  pathname: string;
  search: string;
  searchParams: { get(name: string): string | null; set(name: string, value: string): void; toString(): string };
  toString(): string;
}
declare var console: { log(...args: any[]): void; error(...args: any[]): void };
declare module 'axios' {
  const axios: {
    get(url: string, config?: any): Promise<{ status: number; data: any }>;
    post(url: string, data?: any, config?: any): Promise<{ status: number; data: any }>;
    put(url: string, data?: any, config?: any): Promise<{ status: number; data: any }>;
    patch(url: string, data?: any, config?: any): Promise<{ status: number; data: any }>;
    delete(url: string, config?: any): Promise<{ status: number; data: any }>;
    create(config?: any): typeof axios;
  };
  export default axios;
}
`;

const libSourceCache = new Map<string, ts.SourceFile>();

function getCachedLibSourceFile(fileName: string): ts.SourceFile | undefined {
  const cached = libSourceCache.get(fileName);
  if (cached) return cached;
  const fullPath = posix.isAbsolute(fileName) || /^[A-Za-z]:/.test(fileName)
    ? fileName
    : ts.sys.resolvePath(`${dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }))}/${fileName}`);
  const text = ts.sys.readFile(fullPath);
  if (text === undefined) return undefined;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  libSourceCache.set(fileName, sf);
  return sf;
}

function normalizeVirtualPath(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
  return `/workspace/${clean}`;
}

function denormalizeVirtualPath(vp: string): string {
  return vp.startsWith('/workspace/') ? vp.slice('/workspace/'.length) : vp;
}

export function createVirtualTsProgram(files: CallerFile[]): {
  program: ts.Program;
  checker: ts.TypeChecker;
  userSourceFiles: Map<string, ts.SourceFile>;
} {
  const virtualMap = new Map<string, string>();
  for (const f of files) {
    virtualMap.set(normalizeVirtualPath(f.path), f.content);
  }
  virtualMap.set(VIRTUAL_AMBIENT_PATH, VIRTUAL_AMBIENT_CONTENT);

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
  };

  const defaultLibPath = ts.getDefaultLibFilePath(options).replace(/\\/g, '/');
  const defaultLibDir = dirname(defaultLibPath);
  const sourceFileMap = new Map<string, ts.SourceFile>();

  for (const [vPath, text] of virtualMap.entries()) {
    sourceFileMap.set(
      vPath,
      ts.createSourceFile(
        vPath,
        text,
        ts.ScriptTarget.ES2022,
        true,
        vPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    );
  }

  const resolveCandidate = (baseFile: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const dir = posix.dirname(baseFile);
    const joined = posix.normalize(posix.join(dir, specifier));
    const candidates = [
      joined,
      joined.replace(/\.m?js$/, '.ts'),
      joined.replace(/\.jsx$/, '.tsx'),
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}/index.ts`,
    ];
    return candidates.find((c) => virtualMap.has(c));
  };

  const host: ts.CompilerHost = {
    getSourceFile(fileName) {
      const norm = fileName.replace(/\\/g, '/');
      if (sourceFileMap.has(norm)) return sourceFileMap.get(norm);
      if (norm.startsWith(defaultLibDir) || norm.startsWith('lib.')) {
        const baseName = posix.basename(norm);
        return getCachedLibSourceFile(`${defaultLibDir}/${baseName}`);
      }
      return getCachedLibSourceFile(norm);
    },
    getDefaultLibFileName: () => defaultLibPath,
    writeFile: () => {},
    getCurrentDirectory: () => '/workspace',
    getCanonicalFileName: (f) => f.replace(/\\/g, '/'),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists(fileName) {
      const norm = fileName.replace(/\\/g, '/');
      if (virtualMap.has(norm)) return true;
      if (norm.startsWith(defaultLibDir)) return ts.sys.fileExists(norm);
      return false;
    },
    readFile(fileName) {
      const norm = fileName.replace(/\\/g, '/');
      return virtualMap.get(norm) ?? ts.sys.readFile(norm);
    },
    resolveModuleNames(moduleNames, containingFile) {
      const normContaining = containingFile.replace(/\\/g, '/');
      return moduleNames.map((modName) => {
        const resolved = resolveCandidate(normContaining, modName);
        if (resolved) {
          return {
            resolvedFileName: resolved,
            isExternalLibraryImport: false,
            extension: resolved.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts,
          };
        }
        return undefined;
      });
    },
  };

  const rootNames = [...virtualMap.keys()];
  const program = ts.createProgram(rootNames, options, host);
  const checker = program.getTypeChecker();
  const userSourceFiles = new Map<string, ts.SourceFile>();
  for (const f of files) {
    const sf = program.getSourceFile(normalizeVirtualPath(f.path));
    if (sf) userSourceFiles.set(f.path, sf);
  }
  return { program, checker, userSourceFiles };
}

export function typecheckVirtualFiles(files: CallerFile[]): TypecheckReport {
  const { program, userSourceFiles } = createVirtualTsProgram(files);
  const diagnostics: CompilerDiagnostic[] = [];
  for (const [relPath, sf] of userSourceFiles.entries()) {
    const rawDiags = [
      ...program.getSyntacticDiagnostics(sf),
      ...program.getSemanticDiagnostics(sf),
    ];
    for (const d of rawDiags) {
      // Ignore implicit 'any' on untyped JSON responses unless real property/type mismatch
      if (d.code === 7006 && d.messageText.toString().includes("'any'")) continue;
      const pos = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
      diagnostics.push({
        code: d.code,
        file: relPath,
        line: pos.line + 1,
        column: pos.character + 1,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      });
    }
  }
  return { clean: diagnostics.length === 0, diagnostics };
}

function unwrapExpr(node: ts.Expression): ts.Expression {
  while (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function extractUrlPattern(
  expr: ts.Expression | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!expr) return undefined;
  const target = unwrapExpr(expr);
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target)) {
    return target.text;
  }
  if (ts.isTemplateExpression(target)) {
    let acc = target.head.text;
    for (const span of target.templateSpans) {
      const subVal = extractUrlPattern(span.expression, checker);
      if (subVal && (subVal.startsWith('http') || subVal.startsWith('/'))) {
        acc += subVal.replace(/\/+$/, '') + span.literal.text;
      } else {
        acc += '{param}' + span.literal.text;
      }
    }
    return acc;
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractUrlPattern(target.left, checker);
    const right = extractUrlPattern(target.right, checker);
    if (left && right) return `${left}${right}`;
    if (left && !right) return `${left}{param}`;
  }
  if (ts.isIdentifier(target)) {
    const sym = checker.getSymbolAtLocation(target);
    const resolvedSym = sym && (sym.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(sym) : sym;
    const decl = resolvedSym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return extractUrlPattern(decl.initializer, checker);
    }
  }
  return undefined;
}

function matchOpenApiRoute(rawUrl: string, documents: OpenApiDocument[]): string | null {
  let pathname = rawUrl;
  try {
    if (/^https?:\/\//.test(pathname)) {
      pathname = new URL(pathname).pathname;
    } else {
      pathname = pathname.split(/[?#]/, 1)[0] ?? pathname;
    }
  } catch {
    pathname = pathname.split(/[?#]/, 1)[0] ?? pathname;
  }
  if (!pathname.startsWith('/')) {
    const slashIdx = pathname.indexOf('/');
    if (slashIdx >= 0) pathname = pathname.slice(slashIdx);
    else return null;
  }

  const allRoutes = [...new Set(documents.flatMap((d) => Object.keys(d.paths ?? {})))];
  if (allRoutes.includes(pathname)) return pathname;
  const segs = pathname.split('/');
  const matches = allRoutes.filter((template) => {
    const tSegs = template.split('/');
    return (
      tSegs.length === segs.length &&
      tSegs.every((part, idx) =>
        /^\{[^{}]+\}$/.test(part) || segs[idx] === '{param}' ? Boolean(segs[idx]) : part === segs[idx],
      )
    );
  });
  return matches.length === 1 ? matches[0]! : matches[0] ?? null;
}

function enclosingDeclarationName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
  }
  return '<module>';
}

function enclosingTopLevelDeclaration(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && cur.parent && !ts.isSourceFile(cur.parent)) {
    cur = cur.parent;
  }
  return cur;
}

function detectSinkContext(expr: ts.Node): string | undefined {
  const parent = expr.parent;
  if (!parent) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expr) {
    if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      return `method:${parent.name.text}`;
    }
    return `prop:${parent.name.text}`;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === expr) {
    return 'dictionary-index';
  }
  if (ts.isSwitchStatement(parent) && parent.expression === expr) {
    return 'switch-discriminant';
  }
  if (ts.isBinaryExpression(parent)) {
    const tok = parent.operatorToken.kind;
    if (
      [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.LessThanToken,
      ].includes(tok)
    ) {
      return 'arithmetic-or-compare';
    }
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(tok)) {
      return 'strict-equality';
    }
  }
  return undefined;
}

export function analyzeProgramDataflow(
  files: CallerFile[],
  baselineInput: OpenApiInput,
  candidateInput: OpenApiInput,
  alignmentReport?: SchemaAlignmentReport,
): ProgramDataflowReport {
  const baselineDoc = prepareContract(baselineInput).document;
  const candidateDoc = prepareContract(candidateInput).document;
  const docs = [baselineDoc, candidateDoc];
  const alignment = alignmentReport ?? inferSchemaMigrations(baselineInput, candidateInput);
  const staticAnalysis = analyzeRelease(baselineInput, candidateInput);

  const { program, checker, userSourceFiles } = createVirtualTsProgram(files);
  const typecheck = typecheckVirtualFiles(files);

  const callsites: TrackedHttpCallsite[] = [];
  const callEdges: CrossFileCallEdge[] = [];
  const symbolOrigins = new Map<ts.Symbol, OriginRef>();
  const functionReturnOrigins = new Map<ts.Symbol, OriginRef>();
  const responseHandleSymbols = new Map<ts.Symbol, TrackedHttpCallsite>();

  let callSeq = 1;
  let usageSeq = 1;

  function resolveEffectiveSymbol(node: ts.Node): ts.Symbol | undefined {
    const sym = checker.getSymbolAtLocation(node);
    if (!sym) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  }

  // Pass 1: Detect all HTTP callsites across all files (fetch, axios, openapi-fetch, custom http wrappers)
  const callsiteByNode = new Map<ts.CallExpression, TrackedHttpCallsite>();

  for (const [relPath, sf] of userSourceFiles.entries()) {
    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpr(node.expression);
        // Pattern 1: fetch(url, init?)
        if (ts.isIdentifier(callee) && callee.text === 'fetch' && node.arguments.length >= 1) {
          const urlArg = node.arguments[0]!;
          const rawUrl = extractUrlPattern(urlArg, checker) ?? urlArg.getText(sf);
          let method = 'GET';
          const second = node.arguments[1];
          if (second && ts.isObjectLiteralExpression(unwrapExpr(second))) {
            for (const prop of (unwrapExpr(second) as ts.ObjectLiteralExpression).properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
                prop.name.text === 'method'
              ) {
                const m = extractUrlPattern(prop.initializer, checker);
                if (m) method = m.toUpperCase();
              }
            }
          }
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const site: TrackedHttpCallsite = {
            id: `CS-${String(callSeq++).padStart(4, '0')}`,
            file: relPath,
            line: pos.line + 1,
            column: pos.character + 1,
            enclosingFunction: enclosingDeclarationName(node),
            clientKind: 'fetch',
            method,
            rawUrlText: rawUrl,
            matchedPath: matchOpenApiRoute(rawUrl, docs),
            urlNodeStart: urlArg.getStart(sf),
            urlNodeEnd: urlArg.getEnd(),
            callNodeStart: node.getStart(sf),
            callNodeEnd: node.getEnd(),
            hasSecondArg: Boolean(second),
            ...(second ? { secondArgStart: second.getStart(sf), secondArgEnd: second.getEnd() } : {}),
          };
          callsites.push(site);
          callsiteByNode.set(node, site);
        } else if (ts.isPropertyAccessExpression(callee)) {
          const propName = callee.name.text;
          // Pattern 2: axios.get / client.get / apiClient.post / client.GET (openapi-fetch)
          if (/^(get|post|put|patch|delete|head|options)$/i.test(propName) && node.arguments.length >= 1) {
            const urlArg = node.arguments[0]!;
            const rawUrl = extractUrlPattern(urlArg, checker);
            if (rawUrl && (rawUrl.startsWith('/') || rawUrl.startsWith('http'))) {
              const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              const isOpenApiFetch = propName === propName.toUpperCase();
              const second = node.arguments[1];
              const site: TrackedHttpCallsite = {
                id: `CS-${String(callSeq++).padStart(4, '0')}`,
                file: relPath,
                line: pos.line + 1,
                column: pos.character + 1,
                enclosingFunction: enclosingDeclarationName(node),
                clientKind: isOpenApiFetch ? 'openapi-client' : 'method-client',
                method: propName.toUpperCase(),
                rawUrlText: rawUrl,
                matchedPath: matchOpenApiRoute(rawUrl, docs),
                urlNodeStart: urlArg.getStart(sf),
                urlNodeEnd: urlArg.getEnd(),
                callNodeStart: node.getStart(sf),
                callNodeEnd: node.getEnd(),
                hasSecondArg: Boolean(second),
                ...(second ? { secondArgStart: second.getStart(sf), secondArgEnd: second.getEnd() } : {}),
              };
              callsites.push(site);
              callsiteByNode.set(node, site);
            }
          }
        }
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(sf);
  }

  // Helper to evaluate symbolic OriginRef of any expression
  function evalExprOrigin(expr: ts.Expression): OriginRef | undefined {
    const target = unwrapExpr(expr);

    if (ts.isCallExpression(target)) {
      const directSite = callsiteByNode.get(target);
      if (directSite && directSite.matchedPath && directSite.clientKind !== 'fetch') {
        return {
          callsiteId: directSite.id,
          operation: { method: directSite.method, path: directSite.matchedPath },
          path: [],
        };
      }

      // response.json() on a fetch callsite or response symbol
      if (ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'json') {
        const recv = unwrapExpr(target.expression.expression);
        if (ts.isCallExpression(recv)) {
          const site = callsiteByNode.get(recv);
          if (site && site.matchedPath) {
            return { callsiteId: site.id, operation: { method: site.method, path: site.matchedPath }, path: [] };
          }
        }
        if (ts.isIdentifier(recv)) {
          const sym = resolveEffectiveSymbol(recv);
          const site = sym ? responseHandleSymbols.get(sym) : undefined;
          if (site && site.matchedPath) {
            return { callsiteId: site.id, operation: { method: site.method, path: site.matchedPath }, path: [] };
          }
        }
      }

      // Array .map / .filter / .slice preserving or transforming origin
      if (ts.isPropertyAccessExpression(target.expression)) {
        const method = target.expression.name.text;
        const recvOrigin = evalExprOrigin(target.expression.expression);
        if (recvOrigin && ['filter', 'slice'].includes(method)) {
          return recvOrigin;
        }
        if (recvOrigin && method === 'find') {
          const elemPath = recvOrigin.path.length === 0
            ? ['[]']
            : [...recvOrigin.path.slice(0, -1), `${recvOrigin.path.at(-1)!}[]`];
          return { ...recvOrigin, path: elemPath };
        }
      }

      // Inter-procedural function call: check if callee symbol has a known return OriginRef!
      const calleeSym = resolveEffectiveSymbol(target.expression);
      if (calleeSym && functionReturnOrigins.has(calleeSym)) {
        return functionReturnOrigins.get(calleeSym);
      }
    }

    if (ts.isIdentifier(target)) {
      const sym = resolveEffectiveSymbol(target);
      if (sym && symbolOrigins.has(sym)) {
        return symbolOrigins.get(sym);
      }
    }

    if (ts.isPropertyAccessExpression(target)) {
      const recv = unwrapExpr(target.expression);
      if (ts.isIdentifier(recv)) {
        const sym = resolveEffectiveSymbol(recv);
        const site = sym ? responseHandleSymbols.get(sym) : undefined;
        if (site && site.matchedPath && target.name.text === 'data') {
          return { callsiteId: site.id, operation: { method: site.method, path: site.matchedPath }, path: [] };
        }
      }
      const recvOrigin = evalExprOrigin(target.expression);
      if (recvOrigin) {
        if (
          recvOrigin.path.length === 0 &&
          target.name.text === 'data' &&
          callsites.find((c) => c.id === recvOrigin.callsiteId)?.clientKind !== 'fetch'
        ) {
          return recvOrigin;
        }
        return { ...recvOrigin, path: [...recvOrigin.path, target.name.text] };
      }
    }

    if (ts.isElementAccessExpression(target)) {
      const recvOrigin = evalExprOrigin(target.expression);
      if (recvOrigin) {
        const arg = unwrapExpr(target.argumentExpression);
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          return { ...recvOrigin, path: [...recvOrigin.path, arg.text] };
        }
        if (ts.isNumericLiteral(arg)) {
          const nextPath = recvOrigin.path.length === 0
            ? ['[]']
            : [...recvOrigin.path.slice(0, -1), `${recvOrigin.path.at(-1)!}[]`];
          return { ...recvOrigin, path: nextPath };
        }
      }
    }

    if (
      ts.isBinaryExpression(target) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(target.operatorToken.kind)
    ) {
      return evalExprOrigin(target.left) ?? evalExprOrigin(target.right);
    }

    return undefined;
  }

  function bindPatternOrigins(pattern: ts.BindingName, origin: OriginRef): void {
    if (ts.isIdentifier(pattern)) {
      const sym = checker.getSymbolAtLocation(pattern);
      if (sym) symbolOrigins.set(sym, origin);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        if (el.dotDotDotToken) continue;
        const propKey = el.propertyName
          ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
            ? el.propertyName.text
            : undefined
          : ts.isIdentifier(el.name)
            ? el.name.text
            : undefined;
        if (propKey) {
          bindPatternOrigins(el.name, { ...origin, path: [...origin.path, propKey] });
        }
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      const elemPath = origin.path.length === 0
        ? ['[]']
        : [...origin.path.slice(0, -1), `${origin.path.at(-1)!}[]`];
      for (const el of pattern.elements) {
        if (ts.isBindingElement(el)) {
          bindPatternOrigins(el.name, { ...origin, path: elemPath });
        }
      }
    }
  }

  // Pass 2: Multi-round Fixed-Point Inter-Procedural Propagation (up to 4 iterations across files)
  for (let round = 0; round < 4; round++) {
    for (const [, sf] of userSourceFiles.entries()) {
      const propagate = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          const initUnwrapped = unwrapExpr(node.initializer);
          if (ts.isCallExpression(initUnwrapped) && ts.isIdentifier(node.name)) {
            const site = callsiteByNode.get(initUnwrapped);
            if (site) {
              const sym = checker.getSymbolAtLocation(node.name);
              if (sym) responseHandleSymbols.set(sym, site);
            }
          }
          const origin = evalExprOrigin(node.initializer);
          if (origin) bindPatternOrigins(node.name, origin);
        }

        // Array callback parameter origin propagation: arr.map((item) => ...)
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['map', 'filter', 'find', 'forEach', 'some', 'every', 'flatMap'].includes(node.expression.name.text) &&
          node.arguments.length >= 1
        ) {
          const recvOrigin = evalExprOrigin(node.expression.expression);
          const cb = node.arguments[0]!;
          if (recvOrigin && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length >= 1) {
            const elemPath = recvOrigin.path.length === 0
              ? ['[]']
              : [...recvOrigin.path.slice(0, -1), `${recvOrigin.path.at(-1)!}[]`];
            bindPatternOrigins(cb.parameters[0]!.name, { ...recvOrigin, path: elemPath });
          }
        }

        // for (const item of orders)
        if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
          const iterOrigin = evalExprOrigin(node.expression);
          const decl = node.initializer.declarations[0];
          if (iterOrigin && decl) {
            const elemPath = iterOrigin.path.length === 0
              ? ['[]']
              : [...iterOrigin.path.slice(0, -1), `${iterOrigin.path.at(-1)!}[]`];
            bindPatternOrigins(decl.name, { ...iterOrigin, path: elemPath });
          }
        }

        // Function / Arrow return origin propagation
        if (ts.isReturnStatement(node) && node.expression) {
          const retOrigin = evalExprOrigin(node.expression);
          if (retOrigin) {
            for (let anc: ts.Node | undefined = node.parent; anc; anc = anc.parent) {
              if (ts.isFunctionDeclaration(anc) && anc.name) {
                const fnSym = checker.getSymbolAtLocation(anc.name);
                if (fnSym) functionReturnOrigins.set(fnSym, retOrigin);
                break;
              }
              if (
                (ts.isArrowFunction(anc) || ts.isFunctionExpression(anc)) &&
                ts.isVariableDeclaration(anc.parent) &&
                ts.isIdentifier(anc.parent.name)
              ) {
                const fnSym = checker.getSymbolAtLocation(anc.parent.name);
                if (fnSym) functionReturnOrigins.set(fnSym, retOrigin);
                break;
              }
            }
          }
        }

        if (
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          !ts.isBlock(node.body) &&
          ts.isVariableDeclaration(node.parent) &&
          ts.isIdentifier(node.parent.name)
        ) {
          const retOrigin = evalExprOrigin(node.body);
          const fnSym = checker.getSymbolAtLocation(node.parent.name);
          if (retOrigin && fnSym) functionReturnOrigins.set(fnSym, retOrigin);
        }

        ts.forEachChild(node, propagate);
      };
      propagate(sf);
    }
  }

  // Pass 3: Collect Cross-File Call Edges & Exact Field Consumption Usages
  const fieldUsages: TrackedFieldUsage[] = [];
  const seenUsageKeys = new Set<string>();
  const impactedDeclarations = new Map<string, Set<ts.Node>>();

  const markImpacted = (relPath: string, node: ts.Node): void => {
    const top = enclosingTopLevelDeclaration(node);
    if (!top) return;
    if (!impactedDeclarations.has(relPath)) impactedDeclarations.set(relPath, new Set());
    impactedDeclarations.get(relPath)!.add(top);
  };

  for (const site of callsites) {
    const sf = userSourceFiles.get(site.file);
    if (sf) {
      const token = sf.statements.find(
        (st) => st.getStart(sf) <= site.callNodeStart && site.callNodeEnd <= st.getEnd(),
      );
      if (token) markImpacted(site.file, token);
    }
  }

  for (const [relPath, sf] of userSourceFiles.entries()) {
    const collect = (node: ts.Node): void => {
      // Cross-file call edges
      if (ts.isCallExpression(node)) {
        const calleeSym = resolveEffectiveSymbol(node.expression);
        const decl = calleeSym?.declarations?.[0];
        const targetSf = decl?.getSourceFile();
        if (targetSf && targetSf !== sf && targetSf.fileName.startsWith('/workspace/')) {
          const toFile = denormalizeVirtualPath(targetSf.fileName);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          callEdges.push({
            fromFile: relPath,
            fromFunction: enclosingDeclarationName(node),
            toFile,
            toFunction: calleeSym!.getName(),
            line: pos.line + 1,
          });
        }
      }

      // Property access / Optional chain usage on tracked API Origin
      if (ts.isPropertyAccessExpression(node)) {
        const recvOrigin = evalExprOrigin(node.expression);
        if (recvOrigin) {
          const isAxiosData =
            recvOrigin.path.length === 0 &&
            node.name.text === 'data' &&
            callsites.find((c) => c.id === recvOrigin.callsiteId)?.clientKind !== 'fetch';
          if (!isAxiosData) {
            const fullPath = [...recvOrigin.path, node.name.text];
            const dotPath = fullPath.join('.').replace(/^\[\]\./, '[].');
            // Record leaf or meaningful access; if parent is also a PropertyAccess continuing the chain, record both so nested & leaf alignments both match!
            const key = `${relPath}:${node.name.getStart(sf)}:${dotPath}`;
            if (!seenUsageKeys.has(key)) {
              seenUsageKeys.add(key);
              const pos = sf.getLineAndCharacterOfPosition(node.name.getStart(sf));
              const sink = detectSinkContext(node);
              const usageKind: FieldUsageKind =
                sink === 'switch-discriminant'
                  ? 'enum-switch'
                  : sink === 'dictionary-index'
                    ? 'dictionary-lookup'
                    : node.questionDotToken || (node.flags & ts.NodeFlags.OptionalChain)
                      ? 'optional-chain'
                      : 'property-access';
              fieldUsages.push({
                id: `USE-${String(usageSeq++).padStart(4, '0')}`,
                callsiteId: recvOrigin.callsiteId,
                operation: recvOrigin.operation,
                dotPath,
                leaf: node.name.text,
                file: relPath,
                line: pos.line + 1,
                column: pos.character + 1,
                identStart: node.name.getStart(sf),
                identEnd: node.name.getEnd(),
                exprStart: node.getStart(sf),
                exprEnd: node.getEnd(),
                exprText: node.getText(sf),
                usageKind,
                ...(sink ? { sinkContext: sink } : {}),
              });
              markImpacted(relPath, node);
            }
          }
        }
      }

      // Element access order['customerName']
      if (ts.isElementAccessExpression(node)) {
        const recvOrigin = evalExprOrigin(node.expression);
        const arg = unwrapExpr(node.argumentExpression);
        if (recvOrigin && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const fullPath = [...recvOrigin.path, arg.text];
          const dotPath = fullPath.join('.').replace(/^\[\]\./, '[].');
          const key = `${relPath}:${arg.getStart(sf)}:${dotPath}`;
          if (!seenUsageKeys.has(key)) {
            seenUsageKeys.add(key);
            const pos = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
            fieldUsages.push({
              id: `USE-${String(usageSeq++).padStart(4, '0')}`,
              callsiteId: recvOrigin.callsiteId,
              operation: recvOrigin.operation,
              dotPath,
              leaf: arg.text,
              file: relPath,
              line: pos.line + 1,
              column: pos.character + 1,
              identStart: arg.getStart(sf),
              identEnd: arg.getEnd(),
              exprStart: node.getStart(sf),
              exprEnd: node.getEnd(),
              exprText: node.getText(sf),
              usageKind: 'element-access',
              ...(detectSinkContext(node) ? { sinkContext: detectSinkContext(node)! } : {}),
            });
            markImpacted(relPath, node);
          }
        }
      }

      // Object destructuring: const { customerName } = order
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
        const initOrigin = evalExprOrigin(node.initializer);
        if (initOrigin) {
          const visitBinding = (pattern: ts.ObjectBindingPattern, prefix: string[]): void => {
            for (const el of pattern.elements) {
              if (el.dotDotDotToken) continue;
              const propNode = el.propertyName ?? el.name;
              const propText =
                ts.isIdentifier(propNode) || ts.isStringLiteral(propNode) ? propNode.text : undefined;
              if (!propText) continue;
              const fullPath = [...prefix, propText];
              const dotPath = fullPath.join('.');
              const key = `${relPath}:${propNode.getStart(sf)}:${dotPath}`;
              if (!seenUsageKeys.has(key)) {
                seenUsageKeys.add(key);
                const pos = sf.getLineAndCharacterOfPosition(propNode.getStart(sf));
                fieldUsages.push({
                  id: `USE-${String(usageSeq++).padStart(4, '0')}`,
                  callsiteId: initOrigin.callsiteId,
                  operation: initOrigin.operation,
                  dotPath,
                  leaf: propText,
                  file: relPath,
                  line: pos.line + 1,
                  column: pos.character + 1,
                  identStart: propNode.getStart(sf),
                  identEnd: propNode.getEnd(),
                  exprStart: el.getStart(sf),
                  exprEnd: el.getEnd(),
                  exprText: el.getText(sf),
                  usageKind: 'destructure-binding',
                });
                markImpacted(relPath, node);
              }
              if (ts.isObjectBindingPattern(el.name)) {
                visitBinding(el.name, fullPath);
              }
            }
          };
          visitBinding(node.name, initOrigin.path);
        }
      }

      // Identifier usages of destructured / bound field variables (for downstream sink context like `.toUpperCase()` or `RATES[method]`)
      if (ts.isIdentifier(node) && !ts.isVariableDeclaration(node.parent) && !ts.isBindingElement(node.parent)) {
        const sym = resolveEffectiveSymbol(node);
        const origin = sym ? symbolOrigins.get(sym) : undefined;
        if (origin && origin.path.length > 0) {
          const sink = detectSinkContext(node);
          if (sink && (sink.startsWith('method:') || sink === 'dictionary-index' || sink === 'switch-discriminant' || sink === 'arithmetic-or-compare')) {
            const dotPath = origin.path.join('.').replace(/^\[\]\./, '[].');
            const key = `${relPath}:${node.getStart(sf)}:${dotPath}:sink`;
            if (!seenUsageKeys.has(key)) {
              seenUsageKeys.add(key);
              const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              fieldUsages.push({
                id: `USE-${String(usageSeq++).padStart(4, '0')}`,
                callsiteId: origin.callsiteId,
                operation: origin.operation,
                dotPath,
                leaf: origin.path.at(-1)!,
                file: relPath,
                line: pos.line + 1,
                column: pos.character + 1,
                identStart: node.getStart(sf),
                identEnd: node.getEnd(),
                exprStart: node.getStart(sf),
                exprEnd: node.getEnd(),
                exprText: node.getText(sf),
                usageKind:
                  sink === 'switch-discriminant'
                    ? 'enum-switch'
                    : sink === 'dictionary-index'
                      ? 'dictionary-lookup'
                      : 'property-access',
                sinkContext: sink,
              });
              markImpacted(relPath, node);
            }
          }
        }
      }

      ts.forEachChild(node, collect);
    };
    collect(sf);
  }

  // Pass 4: Compute Reachability of Static Breaking Changes & Hypotheses
  const calledOps = new Set(
    callsites
      .filter((c) => c.matchedPath)
      .map((c) => `${c.method} ${c.matchedPath!}`),
  );
  const usedOpPaths = new Set(
    fieldUsages.map((u) => `${u.operation.method} ${u.operation.path}:${u.dotPath}`),
  );

  const reachableHypothesisIds: string[] = [];
  for (const hyp of alignment.hypotheses) {
    const opKey = `${hyp.operation.method} ${hyp.operation.path}`;
    if (!calledOps.has(opKey)) continue;
    if (hyp.direction === 'request') {
      reachableHypothesisIds.push(hyp.id);
    } else if (hyp.kind === 'envelope-wrap') {
      reachableHypothesisIds.push(hyp.id);
    } else {
      const checkField = hyp.fromPath ?? hyp.toPath;
      if (
        checkField &&
        (usedOpPaths.has(`${opKey}:${checkField}`) ||
          fieldUsages.some(
            (u) =>
              `${u.operation.method} ${u.operation.path}` === opKey &&
              (u.dotPath.startsWith(`${checkField}.`) || checkField.startsWith(`${u.dotPath}.`)),
          ))
      ) {
        reachableHypothesisIds.push(hyp.id);
      }
    }
  }

  const reachableBreakingChangeIds: string[] = [];
  const unreachableBreakingChangeIds: string[] = [];

  for (const change of staticAnalysis.changes.filter((c) => c.severity === 'breaking')) {
    // Parse paths["/orders"].get...
    const match = change.location.match(/^paths\[["']([^"']+)["']\](?:\.([a-z]+))?/i);
    if (!match) {
      reachableBreakingChangeIds.push(change.id);
      continue;
    }
    const route = match[1]!;
    const method = match[2]?.toUpperCase();
    const opCalled = method
      ? calledOps.has(`${method} ${route}`)
      : [...calledOps].some((op) => op.endsWith(` ${route}`));
    if (!opCalled) {
      unreachableBreakingChangeIds.push(change.id);
      continue;
    }

    // Check if it is a response property change on an unused property!
    const propMatches = [...change.location.matchAll(/\.properties\[["']([^"']+)["']\]/g)];
    if (change.location.includes('.responses') && propMatches.length > 0 && method) {
      const leafProp = propMatches.at(-1)![1]!;
      const propChain = propMatches.map((m) => m[1]!).join('.');
      const opKey = `${method} ${route}`;
      const used = fieldUsages.some(
        (u) =>
          `${u.operation.method} ${u.operation.path}` === opKey &&
          (u.leaf === leafProp ||
            u.dotPath.replace(/\[\]/g, '') === propChain ||
            u.dotPath.replace(/\[\]/g, '').startsWith(`${propChain}.`)),
      );
      if (!used) {
        unreachableBreakingChangeIds.push(change.id);
        continue;
      }
    }
    reachableBreakingChangeIds.push(change.id);
  }

  // Pass 5: Build Minimal Context Program Slices & Token Compression Metrics
  const slices: ProgramSlice[] = [];
  let fullCharsTotal = 0;
  let slicedCharsTotal = 0;

  for (const f of files) {
    fullCharsTotal += f.content.length;
    const sf = userSourceFiles.get(f.path);
    const impactedSet = impactedDeclarations.get(f.path);
    if (!sf || !impactedSet || impactedSet.size === 0) continue;

    // Keep imports + impacted top-level declarations in source order
    const keptNodes = sf.statements.filter(
      (st) => ts.isImportDeclaration(st) || impactedSet.has(st),
    );
    const slicedCode = keptNodes.map((st) => st.getText(sf)).join('\n\n');
    const declNames = keptNodes
      .filter((st) => !ts.isImportDeclaration(st))
      .map((st) => {
        if (ts.isFunctionDeclaration(st) && st.name) return st.name.text;
        if (ts.isVariableStatement(st)) {
          return st.declarationList.declarations
            .map((d) => (ts.isIdentifier(d.name) ? d.name.text : '<binding>'))
            .join(', ');
        }
        return ts.SyntaxKind[st.kind];
      });
    slicedCharsTotal += slicedCode.length;
    slices.push({
      file: f.path,
      declarations: declNames,
      slicedCode,
      fullChars: f.content.length,
      slicedChars: slicedCode.length,
    });
  }

  const fullTokensApprox = Math.max(1, Math.ceil(fullCharsTotal / 4));
  const slicedTokensApprox = Math.ceil(slicedCharsTotal / 4);
  const compressionRatio = Number(
    Math.max(0, 1 - slicedTokensApprox / fullTokensApprox).toFixed(3),
  );

  return {
    typecheck,
    callsites,
    fieldUsages,
    callEdges,
    slices,
    metrics: {
      totalFiles: files.length,
      impactedFiles: slices.length,
      fullTokensApprox,
      slicedTokensApprox,
      compressionRatio,
    },
    reachability: {
      staticBreakingCount: staticAnalysis.summary.breaking,
      reachableBreakingChangeIds,
      unreachableBreakingChangeIds,
      reachableHypothesisIds,
      hasUncalledBreakingOnly:
        staticAnalysis.summary.breaking > 0 &&
        reachableBreakingChangeIds.length === 0 &&
        reachableHypothesisIds.length === 0,
    },
  };
}
