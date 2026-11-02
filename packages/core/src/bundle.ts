import { parse as parseYaml } from "yaml";
import { ContractGuardError } from "./errors.js";
import { fingerprintObject, fingerprintOpenApiInput, fingerprintText } from "./fingerprint.js";
import { parseOpenApi, resolveLocalRef } from "./parser.js";
import type { ContentFingerprint, ContractBundleMetadata, ContractSourceLocation, OpenApiBundleInput, OpenApiDocument, OpenApiInput, ParsedOpenApi } from "./types.js";

/** Private graph storage; never accepted from a submitted document. */
export const BUNDLE_FILES_KEY = "x-contractguard-bundle-files";
export const BUNDLE_LIMITS = Object.freeze({ files: 50, bytes: 5 * 1024 * 1024, expandedBytes: 20 * 1024 * 1024, parsedValues: 200_000, nodes: 30_000, references: 5_000, depth: 128, dependencyDepth: 32 });

export interface PreparedContract extends ParsedOpenApi {
  fingerprint: ContentFingerprint;
  bundle?: ContractBundleMetadata;
}

type Node = Record<string, unknown>;
type Role = "document" | "path" | "operation" | "parameter" | "response" | "body" | "media" | "encoding" | "schema" | "callback" | "reference";
interface SourceMap {
  entry: string;
  origins: WeakMap<object, ContractSourceLocation>;
}
const SOURCES = new WeakMap<OpenApiDocument, SourceMap>();
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function record(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new ContractGuardError("INVALID_BUNDLE", message, details);
}

function limit(message: string): never {
  throw new ContractGuardError("BUNDLE_LIMIT_EXCEEDED", message);
}

/** Canonical package-relative names, not filesystem paths or network locators. */
export function normalizeBundlePath(value: string, directory = ""): string {
  if (!value || value.length > 512 || /[\\\u0000-\u001f\u007f:%?#]/.test(value) || value.startsWith("/")) {
    fail("Bundle paths must be relative YAML/JSON paths, without backslashes, URI schemes, percent escapes, query strings, or fragments.");
  }
  const segments = directory ? directory.split("/") : [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) fail("A bundle reference escapes the allowed package root.");
      segments.pop();
    } else {
      // Windows device names and trailing dot/space aliases can otherwise make
      // CLI file identity disagree with browser package identity.
      if (/[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail("Bundle path contains a platform-ambiguous filename.");
      segments.push(segment);
    }
  }
  const path = segments.join("/");
  if (!/\.(?:ya?ml|json)$/i.test(path)) fail("Bundle files must use .yaml, .yml, or .json extensions.");
  return path;
}

export function isOpenApiBundle(input: unknown): input is OpenApiBundleInput {
  return record(input) && input.kind === "bundle";
}

function pointerPart(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function childPointer(pointer: string, key: string): string {
  return `${pointer}/${pointerPart(key)}`;
}

function parseFragment(source: string, path: string): unknown {
  try {
    const text = source.trimStart();
    const parsed = text.startsWith("{") || text.startsWith("[") ? JSON.parse(source) as unknown
      : parseYaml(source, { strict: true, prettyErrors: true, maxAliasCount: 100 }) as unknown;
    return cloneBundleValue(parsed, path);
  } catch (error) {
    if (error instanceof ContractGuardError) throw error;
    throw new ContractGuardError("PARSE_ERROR", `Could not parse bundle file ${path}: ${error instanceof Error ? error.message : String(error)}`, { file: path });
  }
}

/** Break YAML alias sharing so rewriting a real schema cannot alter its example.
 * The expanded value budget also bounds otherwise small alias-heavy documents.
 */
function cloneBundleValue(input: unknown, file: string): unknown {
  const ancestors = new WeakSet<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let values = 0;
  function charge(text: string): void {
    bytes += encoder.encode(text).byteLength;
    if (bytes > BUNDLE_LIMITS.expandedBytes) limit(`Expanded bundle file ${file} exceeds the ${BUNDLE_LIMITS.expandedBytes}-byte JSON budget.`);
  }
  function copy(value: unknown, depth: number): unknown {
    if (++values > BUNDLE_LIMITS.parsedValues || depth > BUNDLE_LIMITS.depth) limit(`Parsed bundle file ${file} exceeds its value/depth budget.`);
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) fail("Bundle files must contain only finite JSON-compatible values.", { file });
      charge(JSON.stringify(value));
      return value;
    }
    if (typeof value !== "object") fail("Bundle files must contain JSON-compatible values.", { file });
    if (ancestors.has(value)) fail("Bundle file contains circular YAML aliases.", { file });
    ancestors.add(value);
    try {
      charge("[]");
      if (Array.isArray(value)) return value.map((item) => copy(item, depth + 1));
      const result: Node = {};
      for (const [key, child] of Object.entries(value)) {
        charge(`${JSON.stringify(key)}:,`);
        Object.defineProperty(result, key, { value: copy(child, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  return copy(input, 0);
}

/** Build a bounded in-memory graph from explicitly supplied local files only. */
export function prepareContract(input: OpenApiInput): PreparedContract {
  if (!isOpenApiBundle(input)) {
    const fingerprint = fingerprintOpenApiInput(input);
    const parsed = parseOpenApi(input);
    if (Object.prototype.hasOwnProperty.call(parsed.document, BUNDLE_FILES_KEY)) fail(`Reserved field ${BUNDLE_FILES_KEY} cannot be supplied in a contract.`);
    return { ...parsed, fingerprint };
  }
  if (Object.keys(input).some((key) => !["kind", "entry", "files"].includes(key)) || typeof input.entry !== "string" || !Array.isArray(input.files)) fail("Bundle input must contain only kind, entry, and a files array.");
  if (!input.files.length || input.files.length > BUNDLE_LIMITS.files) limit(`A bundle must contain 1-${BUNDLE_LIMITS.files} files.`);
  const supplied = new Map<string, string>();
  const caseNames = new Set<string>();
  let bytes = 0;
  for (const file of input.files) {
    if (!record(file) || Object.keys(file).some((key) => key !== "path" && key !== "content") || typeof file.path !== "string" || typeof file.content !== "string") fail("Each bundle file must contain only path and text content.");
    const path = normalizeBundlePath(file.path);
    if (caseNames.has(path.toLowerCase())) fail("Bundle paths must be unique, including case-insensitive aliases.", { file: path });
    caseNames.add(path.toLowerCase());
    bytes += new TextEncoder().encode(file.content).byteLength;
    if (bytes > BUNDLE_LIMITS.bytes) limit(`Bundle text exceeds the ${BUNDLE_LIMITS.bytes}-byte total limit.`);
    supplied.set(path, file.content);
  }
  const entry = normalizeBundlePath(input.entry);
  const entryText = supplied.get(entry);
  if (entryText === undefined) fail(`Bundle entry ${entry} was not supplied.`, { missingFile: entry });
  const entryDocument = cloneBundleValue(parseOpenApi(entryText).document, entry) as OpenApiDocument;
  const roots = new Map<string, unknown>([[entry, entryDocument]]);
  const used = new Set<string>([entry]);
  const origins = new WeakMap<object, ContractSourceLocation>();
  const visited = new WeakMap<object, Set<Role>>();
  const referenceTargets: Array<{ ref: string; file: string }> = [];
  let nodes = 0;
  let references = 0;

  function root(path: string): unknown {
    if (!roots.has(path)) {
      const source = supplied.get(path);
      if (source === undefined) fail(`Referenced bundle file ${path} was not supplied.`, { missingFile: path });
      roots.set(path, parseFragment(source, path));
    }
    used.add(path);
    const result = roots.get(path);
    if (record(result) && Object.prototype.hasOwnProperty.call(result, BUNDLE_FILES_KEY)) fail(`Reserved field ${BUNDLE_FILES_KEY} cannot be supplied in a contract.`, { file: path });
    return result;
  }

  function resolveReference(reference: string, file: string): { file: string; pointer: string; target: unknown; rewritten: string } {
    const hash = reference.indexOf("#");
    const filePart = hash < 0 ? reference : reference.slice(0, hash);
    const fragment = hash < 0 ? "" : reference.slice(hash + 1);
    if (fragment && !fragment.startsWith("/")) throw new ContractGuardError("INVALID_REFERENCE", "Bundle references support JSON Pointer fragments only; named anchors require a resource-aware resolver.", { file });
    if (/%(?![0-9a-f]{2})/i.test(fragment)) throw new ContractGuardError("INVALID_REFERENCE", "Bundle JSON Pointer contains invalid percent encoding.", { file });
    const targetFile = filePart ? normalizeBundlePath(filePart, file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "") : file;
    const targetRoot = root(targetFile);
    // resolveLocalRef only needs a JSON object/array root; OpenAPI root fields are
    // irrelevant when resolving a pointer in a standalone schema fragment.
    const pointer = fragment ? `#${fragment}` : "#";
    const target = resolveLocalRef(targetRoot as OpenApiDocument, pointer);
    return { file: targetFile, pointer, target, rewritten: `#/${BUNDLE_FILES_KEY}/${pointerPart(targetFile)}${fragment}` };
  }

  function mapChildren(value: unknown, role: Role, file: string, pointer: string, depth: number, dependencies: string[], scopedId: boolean, skipExtensions = true): void {
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (skipExtensions && /^x-/i.test(key)) continue;
      visit(child, role, file, childPointer(pointer, key), depth + 1, dependencies, scopedId);
    }
  }

  function arrayChildren(value: unknown, role: Role, file: string, pointer: string, depth: number, dependencies: string[], scopedId: boolean): void {
    if (!Array.isArray(value)) return;
    for (const [index, child] of value.entries()) visit(child, role, file, childPointer(pointer, String(index)), depth + 1, dependencies, scopedId);
  }

  function visit(value: unknown, role: Role, file: string, pointer: string, depth: number, dependencies: string[], scopedId = false): void {
    if (depth > BUNDLE_LIMITS.depth) limit(`Bundle graph exceeds depth ${BUNDLE_LIMITS.depth}.`);
    if (!record(value)) return;
    if (++nodes > BUNDLE_LIMITS.nodes) limit(`Bundle graph exceeds the ${BUNDLE_LIMITS.nodes}-node traversal budget.`);
    if (!origins.has(value)) origins.set(value, { file, pointer });
    const roles = visited.get(value) ?? new Set<Role>();
    if (roles.has(role)) return;
    roles.add(role);
    visited.set(value, roles);
    const resourceScoped = scopedId || (role === "schema" && typeof value.$id === "string");
    if (Object.prototype.hasOwnProperty.call(value, "$ref")) {
      if (typeof value.$ref !== "string") throw new ContractGuardError("INVALID_REFERENCE", "A bundle $ref must be a string.", { file, pointer });
      if (++references > BUNDLE_LIMITS.references) limit(`Bundle exceeds ${BUNDLE_LIMITS.references} references.`);
      if (resourceScoped) fail("References governed by schema $id resource scopes are not supported in local bundles; supply a resource-free package or pre-bundle it with a dialect-aware tool.", { file, pointer });
      const resolved = resolveReference(value.$ref, file);
      value.$ref = resolved.rewritten;
      referenceTargets.push({ ref: resolved.rewritten, file });
      const chain = dependencies.includes(resolved.file) ? dependencies : [...dependencies, resolved.file];
      if (chain.length > BUNDLE_LIMITS.dependencyDepth) limit(`Bundle dependency chain exceeds ${BUNDLE_LIMITS.dependencyDepth} files.`);
      const targetRoot = roots.get(resolved.file);
      const rootScoped = record(targetRoot) && targetRoot.openapi === undefined && typeof targetRoot.$id === "string";
      visit(resolved.target, role, resolved.file, resolved.pointer, depth + 1, chain, rootScoped);
      if (role !== "schema" && role !== "path") return;
      if (role === "schema" && entryDocument.openapi.startsWith("3.0.")) return;
    }
    const one = (key: string, next: Role): void => visit(value[key], next, file, childPointer(pointer, key), depth + 1, dependencies, resourceScoped);
    const map = (key: string, next: Role, skip = true): void => mapChildren(value[key], next, file, childPointer(pointer, key), depth, dependencies, resourceScoped, skip);
    const array = (key: string, next: Role): void => arrayChildren(value[key], next, file, childPointer(pointer, key), depth, dependencies, resourceScoped);
    switch (role) {
      case "document":
        map("paths", "path"); map("webhooks", "path");
        if (record(value.components)) {
          const components = value.components;
          for (const [key, next] of Object.entries({ schemas: "schema", parameters: "parameter", headers: "parameter", responses: "response", requestBodies: "body", callbacks: "callback", pathItems: "path", securitySchemes: "reference", examples: "reference", links: "reference" } as const)) {
            mapChildren(components[key], next, file, `${pointer}/components/${key}`, depth + 1, dependencies, false, false);
          }
        }
        break;
      case "path":
        array("parameters", "parameter");
        for (const key of METHODS) one(key, "operation");
        break;
      case "operation": array("parameters", "parameter"); one("requestBody", "body"); map("responses", "response"); map("callbacks", "callback"); break;
      case "response": map("headers", "parameter"); map("links", "reference"); map("content", "media"); break;
      case "body": map("content", "media"); break;
      case "parameter": one("schema", "schema"); map("content", "media"); map("examples", "reference", false); break;
      case "media": one("schema", "schema"); map("encoding", "encoding", false); map("examples", "reference", false); break;
      case "encoding": map("headers", "parameter"); break;
      case "callback":
        for (const [key, child] of Object.entries(value)) if (!/^x-/i.test(key)) visit(child, "path", file, childPointer(pointer, key), depth + 1, dependencies, resourceScoped);
        break;
      case "schema":
        for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) map(key, "schema", false);
        for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) array(key, "schema");
        for (const key of ["additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames", "contentSchema"]) one(key, "schema");
        if (Array.isArray(value.items)) array("items", "schema"); else one("items", "schema");
        if (record(value.dependencies)) for (const [key, child] of Object.entries(value.dependencies)) if (record(child)) visit(child, "schema", file, `${pointer}/dependencies/${pointerPart(key)}`, depth + 1, dependencies, resourceScoped);
        break;
      case "reference": break;
    }
  }

  root(entry);
  visit(entryDocument, "document", entry, "#", 0, [entry]);
  const graph: Node = Object.create(null) as Node;
  for (const path of [...used].sort()) graph[path] = roots.get(path);
  const document: OpenApiDocument = { ...entryDocument, [BUNDLE_FILES_KEY]: graph };
  origins.set(document, { file: entry, pointer: "#" });
  SOURCES.set(document, { entry, origins });
  // Every rewritten pointer is checked after graph construction as well.
  for (const reference of referenceTargets) resolveLocalRef(document, reference.ref);
  const bundle: ContractBundleMetadata = { entry, files: [...used].sort().map((path) => ({ path, fingerprint: fingerprintText(supplied.get(path)!) })) };
  return { document, format: "object", bundle, fingerprint: fingerprintObject(bundle) };
}

function locationTokens(location: string): string[] {
  if (location.startsWith("#/")) return location.slice(2).split("/").map((part) => decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~"));
  const tokens: string[] = [];
  const pattern = /(?:^|\.)([A-Za-z_$][A-Za-z0-9_$-]*)|\[("(?:\\.|[^"\\])*"|\d+)\]/g;
  for (const match of location.matchAll(pattern)) tokens.push(match[1] ?? (match[2]!.startsWith('"') ? JSON.parse(match[2]!) as string : match[2]!));
  if (tokens[0] === "$") tokens.shift();
  return tokens;
}

/** Best available original location, resolving refs while following a finding's logical path. */
export function locateContractSource(document: OpenApiDocument, logicalLocation: string): ContractSourceLocation | undefined {
  const sourceMap = SOURCES.get(document);
  if (!sourceMap) return undefined;
  let current: unknown = document;
  let nearest: ContractSourceLocation = { file: sourceMap.entry, pointer: "#" };
  let pathParameters: unknown[] = [];
  const tokens = locationTokens(logicalLocation);
  function follow(value: unknown, next?: string): unknown {
    const visited = new Set<string>();
    let result = value;
    while (record(result) && typeof result.$ref === "string" && !visited.has(result.$ref)) {
      if (next !== undefined && Object.prototype.hasOwnProperty.call(result, next)) break;
      visited.add(result.$ref);
      const ref = result.$ref;
      const prefix = `#/${BUNDLE_FILES_KEY}/`;
      if (ref.startsWith(prefix)) {
        const parts = ref.slice(prefix.length).split("/");
        nearest = { file: parts[0]!.replace(/~1/g, "/").replace(/~0/g, "~"), pointer: parts.length > 1 ? `#/${parts.slice(1).join("/")}` : "#" };
      }
      result = resolveLocalRef(document, ref);
    }
    return result;
  }
  for (let index = 0; index < Math.min(tokens.length, 256); index += 1) {
    const key = tokens[index]!;
    current = follow(current, key);
    if (current && typeof current === "object") nearest = sourceMap.origins.get(current) ?? nearest;
    if (METHODS.has(key) && record(current) && Array.isArray(current.parameters)) pathParameters = current.parameters;
    if (key === "parameters" && ["query", "header", "cookie", "path"].includes(tokens[index + 1] ?? "") && tokens[index + 2] !== undefined) {
      const where = tokens[index + 1]!;
      const name = tokens[index + 2]!;
      const parameters = [...pathParameters, ...(record(current) && Array.isArray(current.parameters) ? current.parameters : [])];
      const parameterParent = nearest;
      let selected: unknown;
      for (const raw of parameters) {
        const parameter = follow(raw);
        if (record(parameter) && parameter.in === where && typeof parameter.name === "string" && (where === "header" ? parameter.name.toLowerCase() === name.toLowerCase() : parameter.name === name)) selected = raw;
      }
      nearest = parameterParent;
      if (selected === undefined) return nearest;
      current = follow(selected);
      if (current && typeof current === "object") nearest = sourceMap.origins.get(current) ?? nearest;
      index += 2;
      continue;
    }
    if ((!record(current) && !Array.isArray(current)) || !Object.prototype.hasOwnProperty.call(current, key)) return nearest;
    const child = (current as Node)[key];
    nearest = { file: nearest.file, pointer: childPointer(nearest.pointer, key) };
    current = child;
    if (tokens[index - 1] === "paths" && record(current) && Array.isArray(current.parameters)) pathParameters = current.parameters;
  }
  current = follow(current);
  return current && typeof current === "object" ? sourceMap.origins.get(current) ?? nearest : nearest;
}
