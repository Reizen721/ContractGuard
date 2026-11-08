import ts from 'typescript';
import {
  fingerprintText,
  type OpenApiInput,
  type SchemaAlignmentReport,
  type SchemaMigrationHypothesis,
} from '@contractguard/core';
import {
  analyzeProgramDataflow,
  createVirtualTsProgram,
  type CallerFile,
  type ProgramDataflowReport,
} from '@contractguard/caller';
import type { VerificationCounterexample } from '@contractguard/project';
import type { CegarFilePatch } from './types.js';

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
  reason: string;
  hypothesisId?: string;
  counterexampleId?: string;
}

export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const oldLines = before.replace(/\r\n/g, '\n').split('\n');
  const newLines = after.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.at(-1) === '') oldLines.pop();
  if (newLines.at(-1) === '') newLines.pop();

  // Compute compact contextual unified diff header + changed lines
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const ctx = 2;
  const oldStart = Math.max(0, prefix - ctx);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + ctx);
  const newStart = Math.max(0, prefix - ctx);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + ctx);

  const hunkLines: string[] = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`,
  ];
  for (let i = oldStart; i < prefix; i++) hunkLines.push(` ${oldLines[i]!}`);
  for (let i = prefix; i < oldLines.length - suffix; i++) hunkLines.push(`-${oldLines[i]!}`);
  for (let i = prefix; i < newLines.length - suffix; i++) hunkLines.push(`+${newLines[i]!}`);
  for (let i = newLines.length - suffix; i < newEnd; i++) hunkLines.push(` ${newLines[i]!}`);
  return hunkLines.join('\n') + '\n';
}

function applyNonOverlappingEdits(source: string, edits: TextEdit[]): { content: string; applied: TextEdit[] } {
  const sorted = [...edits].sort((a, b) => {
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    return lenDiff !== 0 ? lenDiff : a.start - b.start;
  });

  const accepted: TextEdit[] = [];
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > source.length || edit.start > edit.end) continue;
    const overlaps = accepted.some((other) => !(edit.end <= other.start || edit.start >= other.end));
    if (!overlaps) accepted.push(edit);
  }

  accepted.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of accepted) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  }
  return { content: out, applied: accepted.reverse() };
}

function findNodeAtSpan(sf: ts.SourceFile, start: number, end: number): ts.Node | undefined {
  let best: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    const nStart = node.getStart(sf);
    const nEnd = node.getEnd();
    if (nStart <= start && end <= nEnd) {
      best = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return best;
}

function peelPropertyChain(
  expr: ts.Node,
  segmentCount: number,
  sf: ts.SourceFile,
): { receiverText: string; optionalChain: boolean } | undefined {
  let cur: ts.Node = expr;
  let optionalChain = false;
  for (let i = 0; i < segmentCount; i++) {
    if (ts.isPropertyAccessExpression(cur)) {
      if (cur.questionDotToken) optionalChain = true;
      cur = cur.expression;
    } else if (ts.isElementAccessExpression(cur)) {
      if (cur.questionDotToken) optionalChain = true;
      cur = cur.expression;
    } else {
      return undefined;
    }
  }
  return { receiverText: cur.getText(sf), optionalChain };
}

function buildNestedDestructurePattern(segments: string[], bindingAlias: string): string {
  if (segments.length === 1) {
    const prop = segments[0]!;
    return prop === bindingAlias ? prop : `${prop}: ${bindingAlias}`;
  }
  const [head, ...rest] = segments;
  return `${head}: { ${buildNestedDestructurePattern(rest, bindingAlias)} }`;
}

function wrapCoercionExpression(
  accessText: string,
  exprNode: ts.Node,
  hyp: SchemaMigrationHypothesis,
  sf: ts.SourceFile,
): { start: number; end: number; code: string } {
  const baseSpan = { start: exprNode.getStart(sf), end: exprNode.getEnd() };
  const parent = exprNode.parent;

  switch (hyp.coercionHint) {
    case 'cents-to-decimal': {
      // If caller wrote `(order.amountCents / 100).toFixed(2)` or `order.amountCents / 100`
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.left === exprNode &&
        parent.operatorToken.kind === ts.SyntaxKind.SlashToken &&
        parent.right.getText(sf).trim() === '100'
      ) {
        return { start: parent.getStart(sf), end: parent.getEnd(), code: `Number(${accessText})` };
      }
      // If caller does arithmetic (+, -, *, >, <) expecting integer cents
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.LessThanToken,
        ].includes(parent.operatorToken.kind)
      ) {
        return { ...baseSpan, code: `Math.round(Number(${accessText}) * 100)` };
      }
      return { ...baseSpan, code: `Math.round(Number(${accessText}) * 100)` };
    }
    case 'epoch-to-iso': {
      // If caller wrote `new Date(order.createdAt * 1000)`
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
        parent.getText(sf).includes('1000')
      ) {
        return { start: parent.getStart(sf), end: parent.getEnd(), code: `Date.parse(${accessText})` };
      }
      return { ...baseSpan, code: `Math.floor(Date.parse(${accessText}) / 1000)` };
    }
    case 'number-to-string': {
      // Candidate now returns string; if caller performs numeric comparison or math, coerce to Number(...)
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.GreaterThanToken,
          ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind)
      ) {
        const otherSide = parent.left === exprNode ? parent.right : parent.left;
        if (ts.isNumericLiteral(otherSide) || parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
          return { ...baseSpan, code: `Number(${accessText})` };
        }
      }
      if (
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        const otherSide = parent.left === exprNode ? parent.right : parent.left;
        if (ts.isNumericLiteral(otherSide)) {
          return { ...baseSpan, code: `Number(${accessText})` };
        }
      }
      if (
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === exprNode &&
        ['toFixed', 'toPrecision', 'toExponential'].includes(parent.name.text)
      ) {
        return { ...baseSpan, code: `Number(${accessText})` };
      }
      if (parent && ts.isCallExpression(parent) && parent.arguments.includes(exprNode as ts.Expression)) {
        const calleeText = parent.expression.getText(sf);
        if (calleeText.startsWith('Math.')) {
          return { ...baseSpan, code: `Number(${accessText})` };
        }
      }
      return { ...baseSpan, code: accessText };
    }
    case 'string-to-number':
      return { ...baseSpan, code: `String(${accessText})` };
    case 'boolean-to-enum':
      return { ...baseSpan, code: `(${accessText} === 'ARCHIVED')` };
    default:
      return { ...baseSpan, code: accessText };
  }
}

function inferSwitchReturnFallback(sw: ts.SwitchStatement, checker: ts.TypeChecker): string {
  for (const clause of sw.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    for (const stmt of clause.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        const t = checker.getTypeAtLocation(stmt.expression);
        if ((t.flags & ts.TypeFlags.NumberLike) !== 0) return '0';
        if ((t.flags & ts.TypeFlags.BooleanLike) !== 0) return 'false';
        return "'UNKNOWN'";
      }
    }
  }
  return "'UNKNOWN'";
}

function inferExpressionFallback(expr: ts.Node, checker: ts.TypeChecker, defaultString = "''"): string {
  const t = checker.getTypeAtLocation(expr);
  if ((t.flags & ts.TypeFlags.NumberLike) !== 0) return '0';
  if ((t.flags & ts.TypeFlags.BooleanLike) !== 0) return 'false';
  if (checker.isArrayType(t)) return '[]';
  return defaultString;
}

function buildNestedInterfacePropSignature(toSegs: string[], hyp: SchemaMigrationHypothesis): string {
  const leafTsType =
    hyp.coercionHint === 'string-to-number'
      ? 'number'
      : hyp.coercionHint === 'number-to-string' || hyp.coercionHint === 'cents-to-decimal' || hyp.coercionHint === 'epoch-to-iso'
        ? 'string'
        : 'any';
  if (toSegs.length === 1) {
    return `${toSegs[0]}?: ${leafTsType} | null`;
  }
  const [head, ...rest] = toSegs;
  return `${head}?: { ${buildNestedInterfacePropSignature(rest, hyp)} } | null`;
}

function appendQueryParamToUrlLiteral(rawNodeText: string, key: string, value: string): string {
  if (rawNodeText.includes(`${key}=`)) return rawNodeText;
  const quote = rawNodeText[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return rawNodeText;
  const inner = rawNodeText.slice(1, -1);
  const sep = inner.includes('?') ? '&' : '?';
  return `${quote}${inner}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${quote}`;
}

export function proposeSymbolicRoundPatches(options: {
  round: number;
  currentFiles: CallerFile[];
  originalFiles: CallerFile[];
  baseline: OpenApiInput;
  candidate: OpenApiInput;
  alignment: SchemaAlignmentReport;
  previousCounterexamples: VerificationCounterexample[];
}): {
  nextFiles: CallerFile[];
  patches: CegarFilePatch[];
  actionSummary: string;
  citedHypothesisIds: string[];
  citedCounterexampleIds: string[];
} {
  const { round, currentFiles, originalFiles, baseline, candidate, alignment, previousCounterexamples } = options;
  const dataflow: ProgramDataflowReport = analyzeProgramDataflow(currentFiles, baseline, candidate, alignment);
  const { program, userSourceFiles } = createVirtualTsProgram(currentFiles);
  const checker = program.getTypeChecker();

  const editsByFile = new Map<string, TextEdit[]>();
  const addEdit = (file: string, edit: TextEdit): void => {
    if (!editsByFile.has(file)) editsByFile.set(file, []);
    editsByFile.get(file)!.push(edit);
  };

  if (round === 1) {
    // Round 1: Apply structural, coercion, enum-mapping, and request-schema alignment hypotheses
    const sortedHyps = [...alignment.hypotheses].sort(
      (a, b) => (b.fromPath?.length ?? 0) - (a.fromPath?.length ?? 0),
    );

    for (const hyp of sortedHyps) {
      const opKey = `${hyp.operation.method} ${hyp.operation.path}`;

      // 1A. Envelope Wrap: Order[] -> { data: Order[], total }
      if (hyp.kind === 'envelope-wrap' && hyp.toPath) {
        for (const site of dataflow.callsites) {
          if (`${site.method} ${site.matchedPath ?? ''}` !== opKey) continue;
          const sf = userSourceFiles.get(site.file);
          if (!sf) continue;
          const visitJson = (node: ts.Node): void => {
            if (
              ts.isAwaitExpression(node) &&
              ts.isCallExpression(node.expression) &&
              ts.isPropertyAccessExpression(node.expression.expression) &&
              node.expression.expression.name.text === 'json'
            ) {
              // Ensure not already unwrapped
              if (
                !(ts.isParenthesizedExpression(node.parent) &&
                  ts.isPropertyAccessExpression(node.parent.parent) &&
                  node.parent.parent.name.text === hyp.toPath)
              ) {
                addEdit(site.file, {
                  start: node.getStart(sf),
                  end: node.getEnd(),
                  replacement: `(${node.getText(sf)}).${hyp.toPath}`,
                  reason: `Unwrap response envelope '.${hyp.toPath}'`,
                  hypothesisId: hyp.id,
                });
              }
            }
            ts.forEachChild(node, visitJson);
          };
          visitJson(sf);
        }
      }

      // 1B. Field Rename / Nest / Flatten / Coercion
      if (
        ['field-rename', 'structural-nest', 'structural-flatten', 'type-coercion'].includes(hyp.kind) &&
        hyp.fromPath &&
        hyp.toPath
      ) {
        const relFrom = hyp.fromPath.includes('[].') ? hyp.fromPath.split('[].').at(-1)! : hyp.fromPath;
        const relTo = hyp.toPath.includes('[].') ? hyp.toPath.split('[].').at(-1)! : hyp.toPath;
        const fromSegs = relFrom.split('.').filter(Boolean);
        const toSegs = relTo.split('.').filter(Boolean);

        const matchingUsages = dataflow.fieldUsages.filter(
          (u) =>
            `${u.operation.method} ${u.operation.path}` === opKey &&
            u.dotPath === hyp.fromPath,
        );

        for (const usage of matchingUsages) {
          const sf = userSourceFiles.get(usage.file);
          if (!sf) continue;

          if (usage.usageKind === 'destructure-binding') {
            const bindingNode = findNodeAtSpan(sf, usage.exprStart, usage.exprEnd);
            let localAlias = usage.leaf;
            if (bindingNode && ts.isBindingElement(bindingNode) && ts.isIdentifier(bindingNode.name)) {
              localAlias = bindingNode.name.text;
            }
            let replacement = buildNestedDestructurePattern(toSegs, localAlias);
            if (hyp.coercionHint) {
              // Keep destructuring valid; coercion handled if property access, or if destructured leave alias
            }
            addEdit(usage.file, {
              start: usage.exprStart,
              end: usage.exprEnd,
              replacement,
              reason: `Migrate destructured binding '${relFrom}' -> '${relTo}'`,
              hypothesisId: hyp.id,
            });
          } else {
            const exprNode = findNodeAtSpan(sf, usage.exprStart, usage.exprEnd);
            if (!exprNode) continue;
            const peeled = peelPropertyChain(exprNode, fromSegs.length, sf);
            if (!peeled) {
              // Identifier reference to destructured variable that needs coercion
              if (hyp.coercionHint && ts.isIdentifier(exprNode)) {
                const wrapped = wrapCoercionExpression(exprNode.getText(sf), exprNode, hyp, sf);
                if (wrapped.code !== exprNode.getText(sf)) {
                  addEdit(usage.file, {
                    start: wrapped.start,
                    end: wrapped.end,
                    replacement: wrapped.code,
                    reason: `Apply ${hyp.coercionHint} coercion on '${usage.leaf}'`,
                    hypothesisId: hyp.id,
                  });
                }
              }
              continue;
            }
            const joiner = peeled.optionalChain ? '?.' : '.';
            const accessText = `${peeled.receiverText}${joiner}${toSegs.join(joiner)}`;
            const wrapped = wrapCoercionExpression(accessText, exprNode, hyp, sf);
            addEdit(usage.file, {
              start: wrapped.start,
              end: wrapped.end,
              replacement: wrapped.code,
              reason: `Migrate '${relFrom}' -> '${relTo}'${hyp.coercionHint ? ` (${hyp.coercionHint})` : ''}`,
              hypothesisId: hyp.id,
            });
          }
        }

        // Also migrate explicit local TypeScript DTO interface PropertySignatures in impacted files so TypeChecker Gate 1 stays green
        const impactedFiles = new Set(matchingUsages.map((u) => u.file));
        if (fromSegs.length === 1) {
          for (const file of impactedFiles) {
            const sf = userSourceFiles.get(file);
            if (!sf) continue;
            const visitTypes = (n: ts.Node): void => {
              if (
                ts.isPropertySignature(n) &&
                ts.isIdentifier(n.name) &&
                n.name.text === fromSegs[0]
              ) {
                addEdit(file, {
                  start: n.getStart(sf),
                  end: n.getEnd(),
                  replacement: `${buildNestedInterfacePropSignature(toSegs, hyp)};`,
                  reason: `Migrate TypeScript DTO property signature '${fromSegs[0]}' -> '${toSegs.join('.')}'`,
                  hypothesisId: hyp.id,
                });
              }
              ts.forEachChild(n, visitTypes);
            };
            visitTypes(sf);
          }
        }
      }

      // 1C. Enum Value Remapping (e.g. ADMIN -> OWNER)
      if (hyp.kind === 'enum-extension' && hyp.enumMapping && Object.keys(hyp.enumMapping).length > 0) {
        const impactedFiles = new Set(
          dataflow.fieldUsages
            .filter((u) => `${u.operation.method} ${u.operation.path}` === opKey)
            .map((u) => u.file),
        );
        for (const file of impactedFiles) {
          const sf = userSourceFiles.get(file);
          if (!sf) continue;
          const visitLiterals = (node: ts.Node): void => {
            if (ts.isStringLiteral(node) && Object.hasOwn(hyp.enumMapping!, node.text)) {
              const mapped = hyp.enumMapping![node.text]!;
              // Only rewrite inside case clauses, binary comparisons, or object property keys
              if (
                ts.isCaseClause(node.parent) ||
                ts.isBinaryExpression(node.parent) ||
                ts.isPropertyAssignment(node.parent)
              ) {
                addEdit(file, {
                  start: node.getStart(sf),
                  end: node.getEnd(),
                  replacement: JSON.stringify(mapped),
                  reason: `Remap enum literal '${node.text}' -> '${mapped}'`,
                  hypothesisId: hyp.id,
                });
              }
            }
            ts.forEachChild(node, visitLiterals);
          };
          visitLiterals(sf);
        }
      }

      // 1D. Outbound Request Contract Migrations (query param required/rename, header required, request body rename)
      if (hyp.direction === 'request') {
        for (const site of dataflow.callsites) {
          if (`${site.method} ${site.matchedPath ?? ''}` !== opKey) continue;
          const sf = userSourceFiles.get(site.file);
          if (!sf) continue;

          if (hyp.kind === 'request-param-required' && hyp.paramLocation === 'query' && hyp.toPath) {
            const urlText = sf.text.slice(site.urlNodeStart, site.urlNodeEnd);
            const updatedUrl = appendQueryParamToUrlLiteral(
              urlText,
              hyp.toPath,
              hyp.suggestedParamValue ?? '1',
            );
            if (updatedUrl !== urlText) {
              addEdit(site.file, {
                start: site.urlNodeStart,
                end: site.urlNodeEnd,
                replacement: updatedUrl,
                reason: `Inject required query parameter '${hyp.toPath}=${hyp.suggestedParamValue ?? '1'}'`,
                hypothesisId: hyp.id,
              });
            }
          } else if (hyp.kind === 'request-param-rename' && hyp.paramLocation === 'query' && hyp.fromPath && hyp.toPath) {
            const urlText = sf.text.slice(site.urlNodeStart, site.urlNodeEnd);
            let updatedUrl = urlText.replace(
              new RegExp(`([?&])${hyp.fromPath}=([^&'"\`\\s]+)`),
              (_m, prefix: string, oldVal: string) => {
                let nextVal = oldVal;
                if (hyp.suggestedParamValue && /^\d+$/.test(oldVal)) {
                  const maxNum = Number(hyp.suggestedParamValue);
                  if (Number(oldVal) > maxNum) nextVal = String(maxNum);
                }
                return `${prefix}${hyp.toPath}=${nextVal}`;
              },
            );
            if (updatedUrl !== urlText) {
              addEdit(site.file, {
                start: site.urlNodeStart,
                end: site.urlNodeEnd,
                replacement: updatedUrl,
                reason: `Rename query parameter '${hyp.fromPath}' -> '${hyp.toPath}'`,
                hypothesisId: hyp.id,
              });
            }
          } else if (hyp.kind === 'request-param-required' && hyp.paramLocation === 'header' && hyp.toPath) {
            const val = hyp.suggestedParamValue ?? 'v2';
            if (!site.hasSecondArg) {
              addEdit(site.file, {
                start: site.urlNodeEnd,
                end: site.urlNodeEnd,
                replacement: `, { headers: { ${JSON.stringify(hyp.toPath)}: ${JSON.stringify(val)} } }`,
                reason: `Add required request header '${hyp.toPath}'`,
                hypothesisId: hyp.id,
              });
            } else if (site.secondArgStart !== undefined && site.secondArgEnd !== undefined) {
              const initNode = findNodeAtSpan(sf, site.secondArgStart, site.secondArgEnd);
              if (initNode && ts.isObjectLiteralExpression(initNode)) {
                const headersProp = initNode.properties.find(
                  (p): p is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(p) &&
                    (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                    p.name.text === 'headers',
                );
                if (headersProp && ts.isObjectLiteralExpression(headersProp.initializer)) {
                  const innerOpen = headersProp.initializer.getStart(sf) + 1;
                  addEdit(site.file, {
                    start: innerOpen,
                    end: innerOpen,
                    replacement: ` ${JSON.stringify(hyp.toPath)}: ${JSON.stringify(val)},`,
                    reason: `Append required header '${hyp.toPath}'`,
                    hypothesisId: hyp.id,
                  });
                } else if (!headersProp) {
                  const openBrace = initNode.getStart(sf) + 1;
                  addEdit(site.file, {
                    start: openBrace,
                    end: openBrace,
                    replacement: ` headers: { ${JSON.stringify(hyp.toPath)}: ${JSON.stringify(val)} },`,
                    reason: `Insert headers object with '${hyp.toPath}'`,
                    hypothesisId: hyp.id,
                  });
                }
              }
            }
          } else if (hyp.kind === 'request-body-rename' && hyp.fromPath && hyp.toPath && site.secondArgStart !== undefined && site.secondArgEnd !== undefined) {
            const initNode = findNodeAtSpan(sf, site.secondArgStart, site.secondArgEnd);
            if (initNode) {
              const visitBodyKeys = (n: ts.Node): void => {
                if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === hyp.fromPath) {
                  addEdit(site.file, {
                    start: n.name.getStart(sf),
                    end: n.name.getEnd(),
                    replacement: hyp.toPath!,
                    reason: `Rename request body property '${hyp.fromPath}' -> '${hyp.toPath}'`,
                    hypothesisId: hyp.id,
                  });
                } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === hyp.fromPath) {
                  addEdit(site.file, {
                    start: n.getStart(sf),
                    end: n.getEnd(),
                    replacement: `${hyp.toPath}: ${n.name.text}`,
                    reason: `Rename shorthand request body property '${hyp.fromPath}' -> '${hyp.toPath}'`,
                    hypothesisId: hyp.id,
                  });
                }
                ts.forEachChild(n, visitBodyKeys);
              };
              visitBodyKeys(initNode);
            }
          }
        }
      }
    }
  } else {
    // Round 2+: Counterexample-Guided Refinement (CEGAR)!
    // Repairs nullability/optionality crashes, empty-array boundary crashes, unhandled enum variants, and residual request/compiler errors!
    for (const cex of previousCounterexamples) {
      // 2A. Repair Request Contract Violation if still present
      if (cex.kind === 'request-contract-violation' && cex.operation) {
        const opKey = `${cex.operation.method} ${cex.operation.path}`;
        const matchingReqHyps = alignment.hypotheses.filter(
          (h) => h.direction === 'request' && `${h.operation.method} ${h.operation.path}` === opKey,
        );
        for (const hyp of matchingReqHyps) {
          for (const site of dataflow.callsites) {
            if (`${site.method} ${site.matchedPath ?? ''}` !== opKey) continue;
            const sf = userSourceFiles.get(site.file);
            if (!sf) continue;
            if (hyp.paramLocation === 'query' && hyp.toPath) {
              const urlText = sf.text.slice(site.urlNodeStart, site.urlNodeEnd);
              const updated = appendQueryParamToUrlLiteral(urlText, hyp.toPath, hyp.suggestedParamValue ?? '1');
              if (updated !== urlText) {
                addEdit(site.file, {
                  start: site.urlNodeStart,
                  end: site.urlNodeEnd,
                  replacement: updated,
                  reason: `CEGAR repair for ${cex.id}: add required query param '${hyp.toPath}'`,
                  hypothesisId: hyp.id,
                  counterexampleId: cex.id,
                });
              }
            }
          }
        }
      }

      // 2B. Repair Adversarial Null / Optional / Empty-Array / Enum-Extension Crash or TS Null Diagnostic
      if (cex.kind === 'adversarial-witness-crash' || cex.kind === 'compiler-diagnostic' || cex.kind === 'nominal-test-failure') {
        const targetFiles = cex.file
          ? currentFiles.filter((f) => f.path === cex.file)
          : currentFiles;

        for (const fileObj of targetFiles) {
          const sf = userSourceFiles.get(fileObj.path);
          if (!sf) continue;

          // Case 1: Exhaustive switch statement throwing on new enum variant
          let handledSwitchOrDict = false;
          const visitStatements = (node: ts.Node): void => {
            if (ts.isSwitchStatement(node)) {
              const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
              if (!cex.line || (cex.line >= startLine && cex.line <= endLine)) {
                const defaultFallback = inferSwitchReturnFallback(node, checker);
                const defaultClause = node.caseBlock.clauses.find(ts.isDefaultClause);
                if (defaultClause) {
                  const hasThrow = defaultClause.statements.some(ts.isThrowStatement);
                  if (hasThrow) {
                    addEdit(fileObj.path, {
                      start: defaultClause.getStart(sf),
                      end: defaultClause.getEnd(),
                      replacement: `default: return ${defaultFallback};`,
                      reason: `CEGAR repair for ${cex.id}: replace throwing switch default with safe fallback for extended enum`,
                      counterexampleId: cex.id,
                    });
                    handledSwitchOrDict = true;
                  }
                } else {
                  const closeBrace = node.caseBlock.getEnd() - 1;
                  addEdit(fileObj.path, {
                    start: closeBrace,
                    end: closeBrace,
                    replacement: `  default: return ${defaultFallback};\n  `,
                    reason: `CEGAR repair for ${cex.id}: add safe default branch for extended enum`,
                    counterexampleId: cex.id,
                  });
                  handledSwitchOrDict = true;
                }
              }
            }

            // Case 2: Dictionary lookup `RATES[payment.method].toFixed(2)` crashing on new enum key
            if (
              ts.isPropertyAccessExpression(node) &&
              ts.isElementAccessExpression(node.expression)
            ) {
              const elemLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              if (!cex.line || Math.abs(elemLine - cex.line) <= 2) {
                const elemText = node.expression.getText(sf);
                const method = node.name.text;
                const fallback = ['toFixed', 'toPrecision'].includes(method)
                  ? '0'
                  : inferExpressionFallback(node.expression, checker, "''");
                if (!elemText.includes('??')) {
                  addEdit(fileObj.path, {
                    start: node.expression.getStart(sf),
                    end: node.expression.getEnd(),
                    replacement: `(${elemText} ?? ${fallback})`,
                    reason: `CEGAR repair for ${cex.id}: guard dictionary/array element lookup '${elemText}' with fallback`,
                    counterexampleId: cex.id,
                  });
                  handledSwitchOrDict = true;
                }
              }
            }
            ts.forEachChild(node, visitStatements);
          };
          visitStatements(sf);

          if (handledSwitchOrDict && cex.witnessId?.startsWith('WIT-ENUM')) continue;

          // Case 3: Nullable / Optional / Empty-Array Property Dereference Crash
          // Locate usages matching cex.targetPath or cex.line
          const targetLeaf = cex.targetPath?.split('.').at(-1)?.replace(/\[\]/g, '');
          const visitDerefs = (node: ts.Node): void => {
            // Pattern A: `<nullableExpr>.<stringOrArrayOrNumberMethod>(...)` or `<nullableExpr>.<subProp>`
            if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
              const recv = node.expression;
              const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              const lineMatches = cex.line ? Math.abs(line - cex.line) <= 2 : true;
              const recvText = recv.getText(sf);
              const leafMatches = targetLeaf
                ? recvText.endsWith(`.${targetLeaf}`) || recvText.endsWith(`?.${targetLeaf}`) || recvText === targetLeaf
                : false;

              if ((cex.line && lineMatches || leafMatches) && !recvText.includes('??')) {
                // Check if this is `expr.method(...)` where method is string/array/number method
                if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
                  const mName = node.name.text;
                  if (['toUpperCase', 'toLowerCase', 'trim', 'slice', 'split', 'replace', 'startsWith', 'endsWith'].includes(mName)) {
                    const safeRecv = recvText.replace(/\./g, '?.');
                    addEdit(fileObj.path, {
                      start: recv.getStart(sf),
                      end: recv.getEnd(),
                      replacement: `(${safeRecv} ?? '')`,
                      reason: `CEGAR repair for ${cex.id}: coalesce nullable/optional string '${recvText}' before .${mName}()`,
                      counterexampleId: cex.id,
                    });
                    return;
                  }
                  if (['toFixed', 'toPrecision', 'toExponential'].includes(mName)) {
                    const safeRecv = recvText.replace(/\./g, '?.');
                    addEdit(fileObj.path, {
                      start: recv.getStart(sf),
                      end: recv.getEnd(),
                      replacement: `(${safeRecv} ?? 0)`,
                      reason: `CEGAR repair for ${cex.id}: coalesce nullable/optional number '${recvText}' before .${mName}()`,
                      counterexampleId: cex.id,
                    });
                    return;
                  }
                  if (['map', 'filter', 'join', 'forEach', 'reduce', 'some', 'every'].includes(mName)) {
                    const safeRecv = recvText.replace(/\./g, '?.');
                    addEdit(fileObj.path, {
                      start: recv.getStart(sf),
                      end: recv.getEnd(),
                      replacement: `(${safeRecv} ?? [])`,
                      reason: `CEGAR repair for ${cex.id}: coalesce nullable array '${recvText}' before .${mName}()`,
                      counterexampleId: cex.id,
                    });
                    return;
                  }
                } else if (leafMatches && ts.isPropertyAccessExpression(recv) && !ts.isPropertyAccessExpression(node.parent)) {
                  // Outermost nested nullable object `order.reviewer.name` -> `(order?.reviewer?.name ?? 'NONE')`
                  const safeChain = `${recvText.replace(/\./g, '?.')}?.${node.name.text}`;
                  const fallback = node.name.text === 'length' ? '0' : inferExpressionFallback(node, checker, "'NONE'");
                  addEdit(fileObj.path, {
                    start: node.getStart(sf),
                    end: node.getEnd(),
                    replacement: `(${safeChain} ?? ${fallback})`,
                    reason: `CEGAR repair for ${cex.id}: optional-chain & fallback on nullable object '${node.getText(sf)}'`,
                    counterexampleId: cex.id,
                  });
                  return;
                }
              }
            }

            // Pattern B: `arr[0].toLowerCase()` when `arr` is null or empty `[]`!
            if (ts.isElementAccessExpression(node)) {
              const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              if ((!cex.line || Math.abs(line - cex.line) <= 2) && !node.getText(sf).includes('??')) {
                const recvText = node.expression.getText(sf).replace(/\./g, '?.');
                const idxText = node.argumentExpression.getText(sf);
                const parentProp = ts.isPropertyAccessExpression(node.parent) ? node.parent.name.text : '';
                const fallback = ['toFixed'].includes(parentProp) ? '0' : "''";
                addEdit(fileObj.path, {
                  start: node.getStart(sf),
                  end: node.getEnd(),
                  replacement: `(${recvText}?.[${idxText}] ?? ${fallback})`,
                  reason: `CEGAR repair for ${cex.id}: safe optional element access & fallback on '${node.getText(sf)}'`,
                  counterexampleId: cex.id,
                });
                return;
              }
            }

            // Pattern C: Template literal `${order.nickname}` leaking 'null' or 'undefined'
            if (ts.isTemplateSpan(node) && !ts.isIdentifier(node.expression)) {
              const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
              const exprText = node.expression.getText(sf);
              const matchesTarget = targetLeaf ? exprText.includes(targetLeaf) : true;
              if (
                matchesTarget &&
                ((cex.line && Math.abs(line - cex.line) <= 2) ||
                  (targetLeaf && exprText.includes(targetLeaf))) &&
                !exprText.includes('??')
              ) {
                addEdit(fileObj.path, {
                  start: node.expression.getStart(sf),
                  end: node.expression.getEnd(),
                  replacement: `(${exprText.replace(/\./g, '?.')} ?? '')`,
                  reason: `CEGAR repair for ${cex.id}: coalesce nullable template interpolation '${exprText}'`,
                  counterexampleId: cex.id,
                });
                return;
              }
            }

            ts.forEachChild(node, visitDerefs);
          };
          visitDerefs(sf);
        }
      }
    }
  }

  const nextFiles: CallerFile[] = [];
  const patches: CegarFilePatch[] = [];
  const citedHyps = new Set<string>();
  const citedCexs = new Set<string>();
  const reasons: string[] = [];

  for (const current of currentFiles) {
    const fileEdits = editsByFile.get(current.path) ?? [];
    if (fileEdits.length === 0) {
      nextFiles.push(current);
      continue;
    }
    const { content: patchedContent, applied } = applyNonOverlappingEdits(current.content, fileEdits);
    nextFiles.push({ path: current.path, content: patchedContent });

    for (const e of applied) {
      reasons.push(e.reason);
      if (e.hypothesisId) citedHyps.add(e.hypothesisId);
      if (e.counterexampleId) citedCexs.add(e.counterexampleId);
    }

    const origFile = originalFiles.find((o) => o.path === current.path) ?? current;
    if (patchedContent !== origFile.content) {
      patches.push({
        file: current.path,
        sourceSha256: fingerprintText(origFile.content).value,
        patchedSha256: fingerprintText(patchedContent).value,
        unifiedDiff: buildUnifiedDiff(current.path, origFile.content, patchedContent),
        patchedContent,
        rationale: applied.map((e) => e.reason).join('; '),
      });
    }
  }

  // Also include unchanged-in-this-round files that were already modified in earlier rounds relative to originalFiles!
  for (const nf of nextFiles) {
    if (patches.some((p) => p.file === nf.path)) continue;
    const orig = originalFiles.find((o) => o.path === nf.path);
    if (orig && orig.content !== nf.content) {
      patches.push({
        file: nf.path,
        sourceSha256: fingerprintText(orig.content).value,
        patchedSha256: fingerprintText(nf.content).value,
        unifiedDiff: buildUnifiedDiff(nf.path, orig.content, nf.content),
        patchedContent: nf.content,
        rationale: 'Retained verified structural edits from earlier CEGAR round.',
      });
    }
  }

  const compactReasons = [...new Set(reasons.map((r) => r.replace(/^CEGAR repair for (CEX-\d+):\s*/, '[$1] ')))];
  const actionSummary =
    compactReasons.length > 0
      ? compactReasons.slice(0, 3).join('；')
      : round === 1
        ? '进入反例诊断'
        : '本轮无新增重写规则';

  return {
    nextFiles,
    patches,
    actionSummary,
    citedHypothesisIds: [...citedHyps],
    citedCounterexampleIds: [...citedCexs],
  };
}
