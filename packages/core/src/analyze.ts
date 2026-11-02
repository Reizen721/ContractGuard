import type {
  AnalysisResult,
  AnalyzeOptions,
  Change,
  ChangeCategory,
  OpenApiDocument,
  OpenApiInput,
  Severity,
} from "./types.js";
import { prepareContract, locateContractSource } from "./bundle.js";
import { inspectCoverage } from "./coverage.js";
import { dialectFor, isUnanalysedSchema, normalizedSchemaTypes } from "./dialect.js";
import { pathItemReferenceConflicts, resolveNode, resolvePathItemNode, resolveSchemaNode } from "./parser.js";
import { resolveRulePolicy, type ResolvedRulePolicy } from "./policy.js";

export const ENGINE_VERSION = "2.0.0";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type Direction = "request" | "response";
type Node = Record<string, unknown>;
type DraftChange = Omit<Change, "id">;

interface CompareContext {
  oldDocument: OpenApiDocument;
  newDocument: OpenApiDocument;
  changes: DraftChange[];
  comparedSecuritySchemes: Set<string>;
  options: Required<Pick<AnalyzeOptions, "includeInfo" | "includeNonBreaking">>;
  policy: ResolvedRulePolicy;
}

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(document: OpenApiDocument, value: unknown): Node | undefined {
  const resolved = resolveNode(document, value);
  return isRecord(resolved) ? resolved : undefined;
}

function asSchemaRecord(document: OpenApiDocument, value: unknown): Node | undefined {
  const resolved = resolveSchemaNode(document, value);
  return isRecord(resolved) ? resolved : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function own(record: Node | undefined, key: string): boolean {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function equal(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

/** Locale-independent UTF-16 code-unit ordering for reproducible IDs across hosts. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function add(ctx: CompareContext, change: DraftChange): void {
  const configured = ctx.policy.rules[change.ruleId];
  if (configured?.enabled === false) return;
  const resolved = configured?.severity === undefined ? change : { ...change, severity: configured.severity };
  if (resolved.severity === "info" && !ctx.options.includeInfo) return;
  if (resolved.severity === "non-breaking" && !ctx.options.includeNonBreaking) return;
  const oldSource = locateContractSource(ctx.oldDocument, change.location);
  const newSource = locateContractSource(ctx.newDocument, change.location);
  ctx.changes.push({ ...resolved, ...(oldSource || newSource ? { sourceLocations: { ...(oldSource ? { old: oldSource } : {}), ...(newSource ? { new: newSource } : {}) } } : {}) });
}

function change(
  ruleId: string,
  severity: Severity,
  category: ChangeCategory,
  location: string,
  message: string,
  details: Pick<DraftChange, "before" | "after" | "recommendation"> = {},
): DraftChange {
  return { ruleId, severity, category, location, message, ...details };
}

function operationLocation(path: string, method: string): string {
  return `paths[${JSON.stringify(path)}].${method}`;
}

function isSubset<T>(left: Set<T>, right: Set<T>): boolean {
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

/** JSON Schema integers are a subset of numbers; an empty set means no type constraint. */
function isTypeSubset(left: Set<string>, right: Set<string>): boolean {
  if (right.size === 0) return true;
  if (left.size === 0) return false;
  for (const type of left) {
    if (right.has(type)) continue;
    if (type === "integer" && right.has("number")) continue;
    return false;
  }
  return true;
}

function enumMap(value: unknown): Map<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return new Map(value.map((item) => [stable(item), item]));
}

function schemaRef(value: unknown): string | undefined {
  return isRecord(value) && typeof value.$ref === "string" ? value.$ref : undefined;
}

function compareTypes(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
): void {
  const oldTypes = normalizedSchemaTypes(ctx.oldDocument, oldSchema);
  const newTypes = normalizedSchemaTypes(ctx.newDocument, newSchema);
  if (equal([...oldTypes].sort(), [...newTypes].sort())) return;

  const compatible = direction === "request"
    ? isTypeSubset(oldTypes, newTypes)
    : isTypeSubset(newTypes, oldTypes);
  add(ctx, change(
    "SCHEMA_TYPE_CHANGED",
    compatible ? "non-breaking" : "breaking",
    "schema",
    `${location}.type`,
    compatible
      ? `${direction === "request" ? "Accepted input" : "Produced output"} types became no less compatible.`
      : `${direction === "request" ? "Accepted input" : "Produced output"} types changed incompatibly.`,
    {
      before: [...oldTypes].sort(),
      after: [...newTypes].sort(),
      recommendation: compatible ? undefined : "Keep the old type in a transition release or introduce a new field/version.",
    },
  ));
}

function compareEnums(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
): void {
  const oldEnum = enumMap(oldSchema.enum);
  const newEnum = enumMap(newSchema.enum);
  if (oldEnum === undefined && newEnum === undefined) return;
  if (oldEnum !== undefined && newEnum !== undefined && equal([...oldEnum.keys()].sort(), [...newEnum.keys()].sort())) return;

  const oldKeys = new Set(oldEnum?.keys() ?? []);
  const newKeys = new Set(newEnum?.keys() ?? []);
  const removed = oldEnum === undefined ? [] : [...oldKeys].filter((key) => !newKeys.has(key));
  const added = newEnum === undefined ? [] : [...newKeys].filter((key) => !oldKeys.has(key));
  const before = oldEnum === undefined ? undefined : [...oldEnum.values()];
  const after = newEnum === undefined ? undefined : [...newEnum.values()];

  if (direction === "request") {
    if (newEnum !== undefined && (oldEnum === undefined || removed.length > 0)) {
      add(ctx, change("SCHEMA_ENUM_NARROWED", "breaking", "schema", `${location}.enum`, "The request enum accepts fewer values.", {
        before,
        after,
        recommendation: "Continue accepting every previously documented enum value during migration.",
      }));
    } else if (newEnum === undefined || added.length > 0) {
      add(ctx, change("SCHEMA_ENUM_WIDENED", "non-breaking", "schema", `${location}.enum`, "The request enum accepts additional values.", { before, after }));
    }
  } else {
    if (oldEnum === undefined && newEnum !== undefined) {
      add(ctx, change("SCHEMA_ENUM_NARROWED", "non-breaking", "schema", `${location}.enum`, "The response enum now produces a narrower set of values.", { before, after }));
    } else if (newEnum === undefined || added.length > 0) {
      add(ctx, change("SCHEMA_ENUM_WIDENED", "potentially-breaking", "schema", `${location}.enum`, "The response may now contain values that existing exhaustive clients do not handle.", {
        before,
        after,
        recommendation: "Version the enum or verify that consumers tolerate unknown values.",
      }));
    } else if (oldEnum === undefined || removed.length > 0) {
      add(ctx, change("SCHEMA_ENUM_NARROWED", "non-breaking", "schema", `${location}.enum`, "The response enum now produces a narrower set of values.", { before, after }));
    }
  }
}

const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "const",
  "format",
  "multipleOf",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "$dynamicRef",
  "$recursiveRef",
  "discriminator",
] as const;

function compareUnsupportedSchemaKeywords(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  location: string,
): void {
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (equal(oldSchema[keyword], newSchema[keyword])) continue;
    add(ctx, change(
      "SCHEMA_UNSUPPORTED_KEYWORD_CHANGED",
      "potentially-breaking",
      "schema",
      `${location}.${keyword}`,
      `Schema keyword ${keyword} changed; ContractGuard cannot prove the change is backward-compatible.`,
      {
        before: oldSchema[keyword],
        after: newSchema[keyword],
        recommendation: "Review this keyword manually and add consumer contract tests before release.",
      },
    ));
  }

  const oldAdditional = oldSchema.additionalProperties;
  const newAdditional = newSchema.additionalProperties;
  const schemaValuedAdditional = isRecord(oldAdditional) || isRecord(newAdditional);
  if (schemaValuedAdditional
    && oldAdditional !== false
    && newAdditional !== false
    && !equal(oldAdditional, newAdditional)) {
    add(ctx, change(
      "SCHEMA_UNSUPPORTED_KEYWORD_CHANGED",
      "potentially-breaking",
      "schema",
      `${location}.additionalProperties`,
      "Schema-valued additionalProperties changed; value-schema containment could not be proven.",
      {
        before: oldAdditional,
        after: newAdditional,
        recommendation: "Verify that every previously valid additional property remains accepted and every new response value remains valid for old clients.",
      },
    ));
  }
}

const LOWER_BOUNDS = ["minLength", "minItems", "minProperties"] as const;
const UPPER_BOUNDS = ["maxLength", "maxItems", "maxProperties"] as const;

interface NumericBound {
  value: number;
  exclusive: boolean;
}

/** 3.0 has a boolean exclusive flag; 3.1 allows two independent numeric bounds. */
function numericBound(document: OpenApiDocument, schema: Node, lower: boolean): NumericBound | undefined {
  const inclusiveKey = lower ? "minimum" : "maximum";
  const exclusiveKey = lower ? "exclusiveMinimum" : "exclusiveMaximum";
  const inclusive = schema[inclusiveKey];
  const exclusive = schema[exclusiveKey];
  const inclusiveBound = typeof inclusive === "number" && Number.isFinite(inclusive)
    ? { value: inclusive, exclusive: false } : undefined;
  if (document.openapi.startsWith("3.0.")) {
    return inclusiveBound === undefined ? undefined : { ...inclusiveBound, exclusive: exclusive === true };
  }
  const exclusiveBound = typeof exclusive === "number" && Number.isFinite(exclusive)
    ? { value: exclusive, exclusive: true } : undefined;
  if (inclusiveBound === undefined) return exclusiveBound;
  if (exclusiveBound === undefined) return inclusiveBound;
  const exclusiveIsStronger = lower ? exclusiveBound.value >= inclusiveBound.value : exclusiveBound.value <= inclusiveBound.value;
  return exclusiveIsStronger ? exclusiveBound : inclusiveBound;
}

function compareNumericBound(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
  lower: boolean,
): void {
  const before = numericBound(ctx.oldDocument, oldSchema, lower);
  const after = numericBound(ctx.newDocument, newSchema, lower);
  const discrete = oldSchema.type === "integer" && newSchema.type === "integer";
  const effective = (bound: NumericBound | undefined): NumericBound | undefined => bound === undefined || !discrete ? bound : {
    value: lower ? bound.exclusive ? Math.floor(bound.value) + 1 : Math.ceil(bound.value)
      : bound.exclusive ? Math.ceil(bound.value) - 1 : Math.floor(bound.value),
    exclusive: false,
  };
  const oldEffective = effective(before);
  const newEffective = effective(after);
  if (equal(oldEffective, newEffective)) return;
  const tightened = oldEffective === undefined ? true : newEffective === undefined ? false
    : oldEffective.value === newEffective.value ? newEffective.exclusive && !oldEffective.exclusive
      : lower ? newEffective.value > oldEffective.value : newEffective.value < oldEffective.value;
  const incompatible = direction === "request" ? tightened : !tightened;
  const inclusiveKey = lower ? "minimum" : "maximum";
  const key = before?.value === after?.value ? (lower ? "exclusiveMinimum" : "exclusiveMaximum") : inclusiveKey;
  add(ctx, change(
    incompatible ? "SCHEMA_CONSTRAINT_TIGHTENED" : "SCHEMA_CONSTRAINT_RELAXED",
    incompatible ? (direction === "request" ? "breaking" : "potentially-breaking") : "non-breaking",
    "schema",
    `${location}.${key}`,
    incompatible
      ? `The numeric ${lower ? "lower" : "upper"} bound ${direction === "request" ? "rejects previously valid input" : "permits output outside the old contract"}.`
      : `The numeric ${lower ? "lower" : "upper"} bound changed without reducing ${direction} backward compatibility.`,
    { before, after, recommendation: incompatible ? "Preserve both the old boundary value and whether that endpoint is included, or version the operation." : undefined },
  ));
}

function compareBound(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
  key: string,
  lower: boolean,
): void {
  const before = oldSchema[key];
  const after = newSchema[key];
  if (equal(before, after)) return;
  const beforeNumber = typeof before === "number" ? before : undefined;
  const afterNumber = typeof after === "number" ? after : undefined;
  let inputTightened = false;
  if (beforeNumber === undefined && afterNumber !== undefined) inputTightened = true;
  else if (beforeNumber !== undefined && afterNumber === undefined) inputTightened = false;
  else if (beforeNumber !== undefined && afterNumber !== undefined) inputTightened = lower ? afterNumber > beforeNumber : afterNumber < beforeNumber;
  else return;

  const incompatible = direction === "request" ? inputTightened : !inputTightened;
  add(ctx, change(
    incompatible ? "SCHEMA_CONSTRAINT_TIGHTENED" : "SCHEMA_CONSTRAINT_RELAXED",
    incompatible ? (direction === "request" ? "breaking" : "potentially-breaking") : "non-breaking",
    "schema",
    `${location}.${key}`,
    incompatible
      ? `${key} changed in a way that ${direction === "request" ? "rejects previously valid input" : "permits output outside the old contract"}.`
      : `${key} changed without reducing backward compatibility.`,
    { before, after, recommendation: incompatible ? "Retain the old constraint or introduce the constraint in a new API version." : undefined },
  ));
}

function compareConstraints(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
): void {
  compareNumericBound(ctx, oldSchema, newSchema, direction, location, true);
  compareNumericBound(ctx, oldSchema, newSchema, direction, location, false);
  for (const key of LOWER_BOUNDS) compareBound(ctx, oldSchema, newSchema, direction, location, key, true);
  for (const key of UPPER_BOUNDS) compareBound(ctx, oldSchema, newSchema, direction, location, key, false);

  if (!equal(oldSchema.pattern, newSchema.pattern)) {
    const added = oldSchema.pattern === undefined && typeof newSchema.pattern === "string";
    const removed = typeof oldSchema.pattern === "string" && newSchema.pattern === undefined;
    const incompatible = direction === "request" ? !removed : !added;
    add(ctx, change(
      incompatible ? "SCHEMA_CONSTRAINT_TIGHTENED" : "SCHEMA_CONSTRAINT_RELAXED",
      incompatible ? "potentially-breaking" : "non-breaking",
      "schema",
      `${location}.pattern`,
      incompatible ? `Pattern changed and may make ${direction}s incompatible.` : "Pattern constraint was relaxed compatibly.",
      { before: oldSchema.pattern, after: newSchema.pattern, recommendation: incompatible ? "Test representative payloads against both patterns before release." : undefined },
    ));
  }

  const oldAdditional = oldSchema.additionalProperties !== false;
  const newAdditional = newSchema.additionalProperties !== false;
  if (oldAdditional !== newAdditional) {
    const inputTightened = oldAdditional && !newAdditional;
    const incompatible = direction === "request" ? inputTightened : !inputTightened;
    add(ctx, change(
      incompatible ? "SCHEMA_CONSTRAINT_TIGHTENED" : "SCHEMA_CONSTRAINT_RELAXED",
      incompatible ? "breaking" : "non-breaking",
      "schema",
      `${location}.additionalProperties`,
      incompatible
        ? `${direction === "request" ? "Previously accepted input" : "New output"} may violate the additional-properties policy.`
        : "The additional-properties policy changed compatibly.",
      { before: oldSchema.additionalProperties, after: newSchema.additionalProperties },
    ));
  }
}

function requiredSet(schema: Node): Set<string> {
  return new Set(asArray(schema.required).filter((item): item is string => typeof item === "string"));
}

function properties(document: OpenApiDocument, schema: Node): Record<string, unknown> {
  // A property map may legally contain a property named "$ref"; it is not a Reference Object.
  return isRecord(schema.properties) ? schema.properties : {};
}

function propertyApplies(
  document: OpenApiDocument,
  value: unknown,
  direction: Direction,
): boolean {
  const schema = asSchemaRecord(document, value);
  if (schema === undefined) return true;
  return direction === "request" ? schema.readOnly !== true : schema.writeOnly !== true;
}

const SCHEMA_ANNOTATIONS = new Set(["title", "description", "example", "examples", "default", "deprecated", "readOnly", "writeOnly", "xml", "externalDocs", "$comment"]);
const UNKNOWN_SIGNATURE = "\u0000unproven-schema-signature";
const COMPLEX_OBJECT_CONSTRAINTS = ["patternProperties", "propertyNames", "unevaluatedProperties", "enum", "const", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "dependentSchemas", "dependentRequired", "minProperties", "maxProperties"];

function isUniversalSchema(document: OpenApiDocument, value: unknown): boolean {
  // Also used for the legal boolean-valued additionalProperties keyword in 3.0.
  if (typeof value === 'boolean') return value;
  if (isUnanalysedSchema(document, value)) return false;
  const resolved = resolveSchemaNode(document, value);
  return resolved === true || (isRecord(resolved) && Object.keys(resolved).every((key) => SCHEMA_ANNOTATIONS.has(key)));
}

/** Used for equality, not for proving containment between different schemas. */
function schemaSignature(document: OpenApiDocument, value: unknown, visited = new Set<string>(), budget = { remaining: 2_000, complete: true }): string {
  if (isUnanalysedSchema(document, value)) { budget.complete = false; return UNKNOWN_SIGNATURE; }
  if (--budget.remaining < 0) {
    budget.complete = false;
    return UNKNOWN_SIGNATURE;
  }
  const reference = schemaRef(value);
  if (reference !== undefined && visited.has(reference)) return stable({ $ref: reference });
  const nextVisited = new Set(visited);
  if (reference !== undefined) nextVisited.add(reference);
  const schema = resolveSchemaNode(document, value);
  if (!isRecord(schema)) return stable(schema);
  const normalized: Node = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'nullable') continue;
    if (key === 'type') { normalized.type = [...normalizedSchemaTypes(document, schema)].sort(); continue; }
    // Documentation-only annotations do not change an instance set. Directional
    // readOnly/writeOnly flags are deliberately retained for nested properties.
    if (SCHEMA_ANNOTATIONS.has(key) && key !== "readOnly" && key !== "writeOnly") continue;
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && isRecord(child)) {
      normalized[key] = Object.fromEntries(Object.entries(child).map(([name, item]) => [name, schemaSignature(document, item, nextVisited, budget)]));
    } else if (["oneOf", "anyOf", "allOf", "prefixItems"].includes(key) && Array.isArray(child)) {
      const items = child.map((item) => schemaSignature(document, item, nextVisited, budget));
      normalized[key] = key === "prefixItems" ? items : key === "oneOf" ? items.sort() : [...new Set(items)].sort();
    } else if (["items", "additionalProperties", "contains", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contentSchema"].includes(key)) {
      normalized[key] = schemaSignature(document, child, nextVisited, budget);
    } else if (["required", "enum", "type"].includes(key) && Array.isArray(child)) {
      normalized[key] = [...new Set(child.map(stable))].sort();
    } else {
      normalized[key] = child;
    }
  }
  return budget.complete ? stable(normalized) : UNKNOWN_SIGNATURE;
}

function schemasEqual(oldDocument: OpenApiDocument, oldValue: unknown, newDocument: OpenApiDocument, newValue: unknown): boolean {
  const oldSignature = schemaSignature(oldDocument, oldValue);
  return oldSignature !== UNKNOWN_SIGNATURE && oldSignature === schemaSignature(newDocument, newValue);
}

function addedOptionalRequestPropertySeverity(ctx: CompareContext, oldSchema: Node, newProperty: unknown): Severity {
  if (isUnanalysedSchema(ctx.newDocument, newProperty)) return "potentially-breaking";
  if (oldSchema.additionalProperties === false || isUniversalSchema(ctx.newDocument, newProperty)) return "non-breaking";
  const implicitSchema = oldSchema.additionalProperties ?? true;
  if (schemasEqual(ctx.oldDocument, implicitSchema, ctx.newDocument, newProperty)) return "non-breaking";
  if (COMPLEX_OBJECT_CONSTRAINTS.some((key) => oldSchema[key] !== undefined)) return "potentially-breaking";
  const next = resolveSchemaNode(ctx.newDocument, newProperty);
  // This narrow proof covers the common open-object -> typed-property case.
  // Other interactions remain explicitly uncertain, rather than called safe.
  if (isUniversalSchema(ctx.oldDocument, implicitSchema)
    && (next === false || (isRecord(next) && (next.type !== undefined || next.enum !== undefined)))) return "breaking";
  return "potentially-breaking";
}

function removedRequestPropertySeverity(ctx: CompareContext, newSchema: Node, oldProperty: unknown): Severity {
  if (isUnanalysedSchema(ctx.oldDocument, oldProperty)) return "potentially-breaking";
  if (newSchema.additionalProperties === false) return "breaking";
  if (COMPLEX_OBJECT_CONSTRAINTS.some((key) => newSchema[key] !== undefined)) return "potentially-breaking";
  const implicitSchema = newSchema.additionalProperties ?? true;
  if (isUniversalSchema(ctx.newDocument, implicitSchema)
    || schemasEqual(ctx.oldDocument, oldProperty, ctx.newDocument, implicitSchema)) return "non-breaking";
  return "potentially-breaking";
}

function compareObjectSchema(
  ctx: CompareContext,
  oldSchema: Node,
  newSchema: Node,
  direction: Direction,
  location: string,
  visited: Set<string>,
): void {
  const oldRequired = requiredSet(oldSchema);
  const newRequired = requiredSet(newSchema);
  const oldProperties = properties(ctx.oldDocument, oldSchema);
  const newProperties = properties(ctx.newDocument, newSchema);

  const propertyNames = new Set([
    ...Object.keys(oldProperties),
    ...Object.keys(newProperties),
    ...oldRequired,
    ...newRequired,
  ]);
  for (const name of [...propertyNames].sort()) {
    const childLocation = `${location}.properties[${JSON.stringify(name)}]`;
    const inOld = own(oldProperties, name)
      && propertyApplies(ctx.oldDocument, oldProperties[name], direction);
    const inNew = own(newProperties, name)
      && propertyApplies(ctx.newDocument, newProperties[name], direction);
    if (!inOld && !inNew) {
      const oldRequirementApplies = oldRequired.has(name)
        && (!own(oldProperties, name) || propertyApplies(ctx.oldDocument, oldProperties[name], direction));
      const newRequirementApplies = newRequired.has(name)
        && (!own(newProperties, name) || propertyApplies(ctx.newDocument, newProperties[name], direction));
      if (oldRequirementApplies !== newRequirementApplies) {
        const incompatible = direction === "request" ? newRequirementApplies : !newRequirementApplies;
        add(ctx, change(
          newRequirementApplies ? "SCHEMA_REQUIRED_PROPERTY_ADDED" : "SCHEMA_REQUIRED_PROPERTY_REMOVED",
          incompatible ? "breaking" : "non-breaking",
          "schema",
          `${childLocation}.required`,
          incompatible
            ? `${direction === "request" ? "Request" : "Response"} property ${JSON.stringify(name)} changed requiredness incompatibly.`
            : `Property ${JSON.stringify(name)} changed requiredness compatibly.`,
          {
            before: oldRequirementApplies,
            after: newRequirementApplies,
            recommendation: incompatible ? "Preserve the former requiredness for existing API consumers." : undefined,
          },
        ));
      }
      continue;
    }
    if (inOld && !inNew) {
      const severity = direction === "response" || own(newProperties, name) ? "breaking" : removedRequestPropertySeverity(ctx, newSchema, oldProperties[name]);
      add(ctx, change("SCHEMA_PROPERTY_REMOVED", severity, "schema", childLocation,
        direction === "response" ? "A response property used by clients was removed."
          : severity === "non-breaking" ? "A request property definition was removed, but its former values remain accepted by additionalProperties."
            : "A request property definition was removed; its former values are rejected or cannot be proven accepted by additionalProperties.",
        { before: oldProperties[name], after: newSchema.additionalProperties ?? true, recommendation: severity === "non-breaking" ? undefined : "Retain acceptance of the former property values through a deprecation window or version the operation." }));
      continue;
    }
    if (!inOld && inNew) {
      if (newRequired.has(name)) {
        const incompatible = direction === "request";
        add(ctx, change("SCHEMA_REQUIRED_PROPERTY_ADDED", incompatible ? "breaking" : "non-breaking", "schema", childLocation,
          incompatible ? "A required request property was added." : "A new response property is guaranteed to be present.",
          { after: newProperties[name], recommendation: incompatible ? "Make the new property optional or version the operation." : undefined }));
      } else {
        const severity = direction === "request" ? addedOptionalRequestPropertySeverity(ctx, oldSchema, newProperties[name]) : "non-breaking";
        add(ctx, change("SCHEMA_PROPERTY_ADDED", severity, "schema", childLocation,
          direction === "response" ? "An optional response property was added."
            : severity === "non-breaking" ? "An optional request property was added without restricting previously accepted values."
              : "An optional request property now constrains values formerly governed by additionalProperties; old input may be rejected.",
          { before: direction === "request" ? oldSchema.additionalProperties ?? true : undefined, after: newProperties[name], recommendation: severity === "non-breaking" ? undefined : "Check values previously sent under this name; optional does not imply unconstrained. Keep accepting those values or version the operation." }));
      }
      continue;
    }

    const wasRequired = oldRequired.has(name);
    const nowRequired = newRequired.has(name);
    if (wasRequired !== nowRequired) {
      const incompatible = direction === "request" ? nowRequired : !nowRequired;
      add(ctx, change(
        nowRequired ? "SCHEMA_REQUIRED_PROPERTY_ADDED" : "SCHEMA_REQUIRED_PROPERTY_REMOVED",
        incompatible ? "breaking" : "non-breaking",
        "schema",
        `${childLocation}.required`,
        incompatible
          ? `${direction === "request" ? "Request" : "Response"} property ${JSON.stringify(name)} changed requiredness incompatibly.`
          : `Property ${JSON.stringify(name)} changed requiredness compatibly.`,
        { before: wasRequired, after: nowRequired, recommendation: incompatible ? "Preserve the former requiredness for existing API consumers." : undefined },
      ));
    }
    compareSchema(ctx, oldProperties[name], newProperties[name], direction, childLocation, visited);
  }
}

function compareBooleanSchema(
  ctx: CompareContext,
  oldValue: unknown,
  newValue: unknown,
  direction: Direction,
  location: string,
): boolean {
  const resolvedOld = resolveSchemaNode(ctx.oldDocument, oldValue);
  const resolvedNew = resolveSchemaNode(ctx.newDocument, newValue);
  const oldBoolean = typeof resolvedOld === "boolean";
  const newBoolean = typeof resolvedNew === "boolean";
  if (!oldBoolean && !newBoolean) return false;
  if (oldBoolean && newBoolean && resolvedOld === resolvedNew) return true;

  // false is the empty instance set, true is the universal instance set, and
  // every ordinary Schema Object lies between them.
  const compatible = direction === "request"
    ? resolvedOld === false || resolvedNew === true
    : resolvedNew === false || resolvedOld === true;
  add(ctx, change(
    "SCHEMA_BOOLEAN_CHANGED",
    compatible ? "non-breaking" : "breaking",
    "schema",
    location,
    compatible
      ? `The boolean Schema change does not reduce ${direction} backward compatibility.`
      : `The boolean Schema change makes ${direction}s incompatible.`,
    {
      before: oldBoolean ? resolvedOld : "<schema-object>",
      after: newBoolean ? resolvedNew : "<schema-object>",
      recommendation: compatible ? undefined : "Retain the previous accepted/produced instance set or version the operation.",
    },
  ));
  return true;
}

function compareSchema(
  ctx: CompareContext,
  oldValue: unknown,
  newValue: unknown,
  direction: Direction,
  location: string,
  visited = new Set<string>(),
): void {
  if (oldValue === undefined && newValue === undefined) return;
  if (isUnanalysedSchema(ctx.oldDocument, oldValue) || isUnanalysedSchema(ctx.newDocument, newValue)) {
    const before = resolveSchemaNode(ctx.oldDocument, oldValue);
    const after = resolveSchemaNode(ctx.newDocument, newValue);
    const composition = ['oneOf', 'anyOf', 'allOf'].find((key) => (isRecord(before) && own(before, key)) || (isRecord(after) && own(after, key)));
    if (composition) add(ctx, change('SCHEMA_COMPOSITION_CHANGED', 'potentially-breaking', 'schema', `${location}.${composition}`,
      'Composed-schema comparison was withheld because its dialect, reference conjunction, or inspection budget is not fully supported.',
      { before, after, recommendation: 'Review the coverage warnings and test payloads against both contracts; no composition safety proof was established.' }));
    else if (!equal(before, after)) add(ctx, change('SCHEMA_UNSUPPORTED_KEYWORD_CHANGED', 'potentially-breaking', 'schema', location,
      'Schema changed in a dialect or resource scope that this profile cannot interpret; precise compatibility comparison was withheld.',
      { before, after, recommendation: 'Review the coverage warnings and validate both contracts with a validator for the declared dialect.' }));
    return;
  }
  if (oldValue === undefined || newValue === undefined) {
    const compatible = direction === "request"
      ? newValue === undefined
      : oldValue === undefined;
    add(ctx, change(
      "SCHEMA_PRESENCE_CHANGED",
      compatible ? "non-breaking" : "breaking",
      "schema",
      location,
      compatible
        ? `The ${direction} schema presence changed without reducing backward compatibility.`
        : `Adding or removing the ${direction} schema changes the documented instance set in an incompatible direction.`,
      {
        before: oldValue === undefined ? "<unspecified>" : oldValue,
        after: newValue === undefined ? "<unspecified>" : newValue,
        recommendation: compatible ? undefined : "Keep the former schema contract or introduce the change in a versioned operation.",
      },
    ));
    return;
  }
  if (compareBooleanSchema(ctx, oldValue, newValue, direction, location)) return;
  const oldReference = schemaRef(oldValue);
  const newReference = schemaRef(newValue);
  const pair = `${direction}:${oldReference ?? "inline"}->${newReference ?? "inline"}`;
  if ((oldReference !== undefined || newReference !== undefined) && visited.has(pair)) return;
  const nextVisited = new Set(visited);
  if (oldReference !== undefined || newReference !== undefined) nextVisited.add(pair);

  const oldSchema = asSchemaRecord(ctx.oldDocument, oldValue);
  const newSchema = asSchemaRecord(ctx.newDocument, newValue);
  if (oldSchema === undefined || newSchema === undefined) return;

  compareTypes(ctx, oldSchema, newSchema, direction, location);
  compareEnums(ctx, oldSchema, newSchema, direction, location);
  compareConstraints(ctx, oldSchema, newSchema, direction, location);
  compareUnsupportedSchemaKeywords(ctx, oldSchema, newSchema, location);
  compareObjectSchema(ctx, oldSchema, newSchema, direction, location, nextVisited);

  compareSchema(ctx, oldSchema.items, newSchema.items, direction, `${location}.items`, nextVisited);

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (own(oldSchema, keyword) || own(newSchema, keyword)) {
      const oldItems = asArray(oldSchema[keyword]);
      const newItems = asArray(newSchema[keyword]);
      const oldBudget = { remaining: 2_000, complete: true };
      const newBudget = { remaining: 2_000, complete: true };
      const oldSignatures = oldItems.map((item) => schemaSignature(ctx.oldDocument, item, new Set(), oldBudget));
      const newSignatures = newItems.map((item) => schemaSignature(ctx.newDocument, item, new Set(), newBudget));
      // oneOf duplicates are meaningful: matching the same branch twice fails.
      const oldItemSet = (keyword === "oneOf" ? oldSignatures : [...new Set(oldSignatures)]).sort();
      const newItemSet = (keyword === "oneOf" ? newSignatures : [...new Set(newSignatures)]).sort();
      if (!oldItemSet.includes(UNKNOWN_SIGNATURE) && !newItemSet.includes(UNKNOWN_SIGNATURE) && equal(oldItemSet, newItemSet)) continue;
      add(ctx, change(
        "SCHEMA_COMPOSITION_CHANGED",
        "potentially-breaking",
        "schema",
        `${location}.${keyword}`,
        `${keyword} changed or exceeded the bounded comparison budget; ${direction} instance-set containment could not be proven. Branch count and array position are not a compatibility proof.`,
        { before: oldItems, after: newItems, recommendation: "Review all composed-schema branches and test payloads against both contracts. In particular, oneOf requires exactly one matching branch." },
      ));
    }
  }
}

interface ParameterEntry {
  parameter: Node;
  key: string;
  name: string;
  in: string;
}

function collectParameters(document: OpenApiDocument, pathItem: Node, operation: Node): Map<string, ParameterEntry> {
  const result = new Map<string, ParameterEntry>();
  for (const raw of [...asArray(pathItem.parameters), ...asArray(operation.parameters)]) {
    const parameter = asRecord(document, raw);
    if (parameter === undefined || typeof parameter.name !== "string" || typeof parameter.in !== "string") continue;
    const comparisonName = parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name;
    const key = `${parameter.in}:${comparisonName}`;
    result.set(key, { parameter, key, name: parameter.name, in: parameter.in });
  }
  return result;
}

function parameterSchema(parameter: Node): unknown {
  if (parameter.schema !== undefined) return parameter.schema;
  const content = isRecord(parameter.content) ? parameter.content : undefined;
  if (content === undefined) return undefined;
  const mediaType = Object.keys(content).sort()[0];
  if (mediaType === undefined) return undefined;
  const media = content[mediaType];
  return isRecord(media) ? media.schema : undefined;
}

function serializationSettings(parameter: Node, placement: string): Node {
  if (isRecord(parameter.content)) return { mode: "content", mediaTypes: Object.keys(parameter.content).sort() };
  const style = typeof parameter.style === "string" ? parameter.style : placement === "query" || placement === "cookie" ? "form" : "simple";
  return {
    mode: "schema",
    style,
    explode: typeof parameter.explode === "boolean" ? parameter.explode : style === "form",
    ...(placement === "query" ? { allowReserved: parameter.allowReserved === true } : {}),
  };
}

function compareSerialization(ctx: CompareContext, oldParameter: Node, newParameter: Node, placement: string, location: string, header = false): void {
  const before = serializationSettings(oldParameter, placement);
  const after = serializationSettings(newParameter, placement);
  if (equal(before, after)) return;
  add(ctx, change(
    header ? "RESPONSE_HEADER_SERIALIZATION_CHANGED" : "PARAMETER_SERIALIZATION_CHANGED",
    "potentially-breaking",
    header ? "response" : "parameter",
    `${location}.serialization`,
    `${header ? "Response header" : "Request parameter"} serialization changed; unchanged values may now require a different wire representation.`,
    { before, after, recommendation: "Keep accepting/producing the previous wire format during migration and test existing SDK requests and parsers (for example, ids=a&ids=b versus ids=a,b)." },
  ));
}

function compareParameters(
  ctx: CompareContext,
  oldPathItem: Node,
  newPathItem: Node,
  oldOperation: Node,
  newOperation: Node,
  base: string,
): void {
  const oldParameters = collectParameters(ctx.oldDocument, oldPathItem, oldOperation);
  const newParameters = collectParameters(ctx.newDocument, newPathItem, newOperation);
  for (const key of [...new Set([...oldParameters.keys(), ...newParameters.keys()])].sort()) {
    const oldEntry = oldParameters.get(key);
    const newEntry = newParameters.get(key);
    const entry = oldEntry ?? newEntry;
    if (entry === undefined) continue;
    const location = `${base}.parameters.${entry.in}[${JSON.stringify(entry.name)}]`;
    if (oldEntry !== undefined && newEntry === undefined) {
      add(ctx, change("PARAMETER_REMOVED", "potentially-breaking", "parameter", location, `Request parameter ${entry.in}:${entry.name} was removed.`, {
        before: oldEntry.parameter,
        recommendation: "Continue accepting the parameter during a deprecation window, even if it is ignored.",
      }));
      continue;
    }
    if (oldEntry === undefined && newEntry !== undefined) {
      const required = newEntry.parameter.required === true || newEntry.in === "path";
      add(ctx, change(
        required ? "PARAMETER_ADDED_REQUIRED" : "PARAMETER_ADDED_OPTIONAL",
        required ? "breaking" : "non-breaking",
        "parameter",
        location,
        `${required ? "Required" : "Optional"} request parameter ${entry.in}:${entry.name} was added.`,
        { after: newEntry.parameter, recommendation: required ? "Make the new parameter optional or introduce it in a new operation/version." : undefined },
      ));
      continue;
    }
    if (oldEntry === undefined || newEntry === undefined) continue;
    const oldRequired = oldEntry.parameter.required === true || oldEntry.in === "path";
    const newRequired = newEntry.parameter.required === true || newEntry.in === "path";
    if (oldRequired !== newRequired) {
      add(ctx, change(
        newRequired ? "PARAMETER_REQUIRED" : "PARAMETER_OPTIONAL",
        newRequired ? "breaking" : "non-breaking",
        "parameter",
        `${location}.required`,
        `Parameter ${entry.in}:${entry.name} became ${newRequired ? "required" : "optional"}.`,
        { before: oldRequired, after: newRequired, recommendation: newRequired ? "Keep the parameter optional for existing callers." : undefined },
      ));
    }
    compareSerialization(ctx, oldEntry.parameter, newEntry.parameter, oldEntry.in, location);
    compareSchema(ctx, parameterSchema(oldEntry.parameter), parameterSchema(newEntry.parameter), "request", `${location}.schema`);
  }
}

function bodyNode(document: OpenApiDocument, operation: Node): Node | undefined {
  return operation.requestBody === undefined ? undefined : asRecord(document, operation.requestBody);
}

function contentNode(document: OpenApiDocument, owner: Node | undefined): Node {
  return owner === undefined ? {} : (asRecord(document, owner.content) ?? {});
}

function compareRequestBody(ctx: CompareContext, oldOperation: Node, newOperation: Node, base: string): void {
  const oldBody = bodyNode(ctx.oldDocument, oldOperation);
  const newBody = bodyNode(ctx.newDocument, newOperation);
  const location = `${base}.requestBody`;
  if (oldBody !== undefined && newBody === undefined) {
    add(ctx, change("REQUEST_BODY_REMOVED", "potentially-breaking", "request-body", location, "The accepted request body was removed.", {
      before: oldBody,
      recommendation: "Continue accepting the old body shape during migration.",
    }));
    return;
  }
  if (oldBody === undefined && newBody !== undefined) {
    const required = newBody.required === true;
    add(ctx, change(
      required ? "REQUEST_BODY_ADDED_REQUIRED" : "REQUEST_BODY_ADDED_OPTIONAL",
      required ? "breaking" : "non-breaking",
      "request-body",
      location,
      `A ${required ? "required" : "optional"} request body was added.`,
      { after: newBody, recommendation: required ? "Make the body optional for existing callers or version the operation." : undefined },
    ));
    return;
  }
  if (oldBody === undefined || newBody === undefined) return;
  const oldRequired = oldBody.required === true;
  const newRequired = newBody.required === true;
  if (oldRequired !== newRequired) {
    add(ctx, change(
      newRequired ? "REQUEST_BODY_REQUIRED" : "REQUEST_BODY_OPTIONAL",
      newRequired ? "breaking" : "non-breaking",
      "request-body",
      `${location}.required`,
      `The request body became ${newRequired ? "required" : "optional"}.`,
      { before: oldRequired, after: newRequired, recommendation: newRequired ? "Keep the body optional for existing callers." : undefined },
    ));
  }
  const oldContent = contentNode(ctx.oldDocument, oldBody);
  const newContent = contentNode(ctx.newDocument, newBody);
  for (const mediaType of [...new Set([...Object.keys(oldContent), ...Object.keys(newContent)])].sort()) {
    const mediaLocation = `${location}.content[${JSON.stringify(mediaType)}]`;
    if (own(oldContent, mediaType) && !own(newContent, mediaType)) {
      add(ctx, change("REQUEST_MEDIA_TYPE_REMOVED", "breaking", "request-body", mediaLocation, `Request media type ${mediaType} is no longer accepted.`, {
        recommendation: "Retain the old media type until clients migrate.",
      }));
    } else if (!own(oldContent, mediaType) && own(newContent, mediaType)) {
      add(ctx, change("REQUEST_MEDIA_TYPE_ADDED", "non-breaking", "request-body", mediaLocation, `Request media type ${mediaType} is now accepted.`));
    } else {
      const oldMedia = asRecord(ctx.oldDocument, oldContent[mediaType]);
      const newMedia = asRecord(ctx.newDocument, newContent[mediaType]);
      compareSchema(ctx, oldMedia?.schema, newMedia?.schema, "request", `${mediaLocation}.schema`);
    }
  }
}

function responsesNode(document: OpenApiDocument, operation: Node): Node {
  return asRecord(document, operation.responses) ?? {};
}

function isSuccessStatus(status: string): boolean {
  return /^2(?:\d\d|XX)$/i.test(status);
}

function responseHeaders(document: OpenApiDocument, response: Node | undefined): Map<string, { name: string; header: Node }> {
  const result = new Map<string, { name: string; header: Node }>();
  const headers = response === undefined ? undefined : asRecord(document, response.headers);
  for (const [name, value] of Object.entries(headers ?? {})) {
    // OpenAPI explicitly ignores Content-Type here; it is described by content.
    if (name.toLowerCase() === "content-type") continue;
    const header = asRecord(document, value);
    if (header !== undefined) result.set(name.toLowerCase(), { name, header });
  }
  return result;
}

function compareResponseHeaders(ctx: CompareContext, oldResponse: Node | undefined, newResponse: Node | undefined, base: string): void {
  const oldHeaders = responseHeaders(ctx.oldDocument, oldResponse);
  const newHeaders = responseHeaders(ctx.newDocument, newResponse);
  for (const key of [...new Set([...oldHeaders.keys(), ...newHeaders.keys()])].sort()) {
    const before = oldHeaders.get(key);
    const after = newHeaders.get(key);
    const location = `${base}.headers[${JSON.stringify(before?.name ?? after?.name)}]`;
    if (before !== undefined && after === undefined) {
      add(ctx, change("RESPONSE_HEADER_REMOVED", "potentially-breaking", "response", location,
        `Response header ${before.name} was removed; clients may depend on its value for pagination, retries, or metadata.`,
        { before: before.header, recommendation: "Keep producing the header until consumers migrate, or verify no client depends on it." }));
    } else if (before === undefined && after !== undefined) {
      add(ctx, change("RESPONSE_HEADER_ADDED", "non-breaking", "response", location, `Response header ${after.name} was added.`, { after: after.header }));
    } else if (before !== undefined && after !== undefined) {
      compareSerialization(ctx, before.header, after.header, "header", location, true);
      compareSchema(ctx, parameterSchema(before.header), parameterSchema(after.header), "response", `${location}.schema`);
    }
  }
}

function compareResponses(ctx: CompareContext, oldOperation: Node, newOperation: Node, base: string): void {
  const oldResponses = responsesNode(ctx.oldDocument, oldOperation);
  const newResponses = responsesNode(ctx.newDocument, newOperation);
  const responseKeys = [...new Set([...Object.keys(oldResponses), ...Object.keys(newResponses)])]
    .filter((key) => !/^x-/i.test(key))
    .sort();
  for (const status of responseKeys) {
    const location = `${base}.responses[${JSON.stringify(status)}]`;
    if (own(oldResponses, status) && !own(newResponses, status)) {
      add(ctx, change("RESPONSE_STATUS_REMOVED", isSuccessStatus(status) ? "breaking" : "potentially-breaking", "response", location, `Response status ${status} was removed.`, {
        recommendation: "Keep the old response documented and supported until consumers migrate.",
      }));
      continue;
    }
    if (!own(oldResponses, status) && own(newResponses, status)) {
      add(ctx, change("RESPONSE_STATUS_ADDED", isSuccessStatus(status) ? "potentially-breaking" : "non-breaking", "response", location,
        isSuccessStatus(status) ? `A new success response ${status} may require client handling.` : `Response status ${status} was added.`,
        { recommendation: isSuccessStatus(status) ? "Verify generated and handwritten clients accept every documented success status." : undefined }));
      continue;
    }
    const oldResponse = asRecord(ctx.oldDocument, oldResponses[status]);
    const newResponse = asRecord(ctx.newDocument, newResponses[status]);
    compareResponseHeaders(ctx, oldResponse, newResponse, location);
    const oldContent = contentNode(ctx.oldDocument, oldResponse);
    const newContent = contentNode(ctx.newDocument, newResponse);
    for (const mediaType of [...new Set([...Object.keys(oldContent), ...Object.keys(newContent)])].sort()) {
      const mediaLocation = `${location}.content[${JSON.stringify(mediaType)}]`;
      if (own(oldContent, mediaType) && !own(newContent, mediaType)) {
        add(ctx, change("RESPONSE_MEDIA_TYPE_REMOVED", "breaking", "response", mediaLocation, `Response media type ${mediaType} was removed.`, {
          recommendation: "Continue producing the old representation until consumers migrate.",
        }));
      } else if (!own(oldContent, mediaType) && own(newContent, mediaType)) {
        add(ctx, change("RESPONSE_MEDIA_TYPE_ADDED", "non-breaking", "response", mediaLocation, `Response media type ${mediaType} was added.`));
      } else {
        const oldMedia = asRecord(ctx.oldDocument, oldContent[mediaType]);
        const newMedia = asRecord(ctx.newDocument, newContent[mediaType]);
        compareSchema(ctx, oldMedia?.schema, newMedia?.schema, "response", `${mediaLocation}.schema`);
      }
    }
  }
}

type NormalSecurity = Map<string, Set<string>>;

function normalizeSecurity(value: unknown): NormalSecurity[] {
  if (!Array.isArray(value) || value.length === 0) return [new Map()];
  const result: NormalSecurity[] = [];
  for (const rawRequirement of value) {
    if (!isRecord(rawRequirement)) continue;
    const requirement: NormalSecurity = new Map();
    for (const scheme of Object.keys(rawRequirement).sort()) {
      const scopes = asArray(rawRequirement[scheme]).filter((scope): scope is string => typeof scope === "string");
      requirement.set(scheme, new Set(scopes));
    }
    result.push(requirement);
  }
  return result.length === 0 ? [new Map()] : result;
}

/** True when candidate does not demand more credentials/scopes than baseline. */
function noStronger(candidate: NormalSecurity, baseline: NormalSecurity): boolean {
  for (const [scheme, candidateScopes] of candidate) {
    const baselineScopes = baseline.get(scheme);
    if (baselineScopes === undefined || !isSubset(candidateScopes, baselineScopes)) return false;
  }
  return true;
}

function securitySchemeNames(requirements: NormalSecurity[]): Set<string> {
  const names = new Set<string>();
  for (const requirement of requirements) {
    for (const name of requirement.keys()) names.add(name);
  }
  return names;
}

function securityScheme(document: OpenApiDocument, name: string): Node | undefined {
  const components = asRecord(document, document.components);
  const schemes = components === undefined
    ? undefined
    : asRecord(document, components.securitySchemes);
  return schemes === undefined ? undefined : asRecord(document, schemes[name]);
}

function normalizedLower(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function addSecuritySchemeDifference(
  ctx: CompareContext,
  name: string,
  field: string,
  before: unknown,
  after: unknown,
  severity: "breaking" | "potentially-breaking",
  message: string,
): void {
  add(ctx, change(
    "SECURITY_SCHEME_CHANGED",
    severity,
    "security",
    `components.securitySchemes[${JSON.stringify(name)}].${field}`,
    message,
    {
      before,
      after,
      recommendation: severity === "breaking"
        ? "Preserve the existing credential wire format or introduce a parallel security scheme during migration."
        : "Review authentication-client compatibility and test token acquisition before release.",
    },
  ));
}

function compareReferencedSecuritySchemes(
  ctx: CompareContext,
  oldRequirements: NormalSecurity[],
  newRequirements: NormalSecurity[],
): void {
  const oldNames = securitySchemeNames(oldRequirements);
  const newNames = securitySchemeNames(newRequirements);
  const commonNames = [...oldNames].filter((name) => newNames.has(name)).sort();

  for (const name of commonNames) {
    if (ctx.comparedSecuritySchemes.has(name)) continue;
    ctx.comparedSecuritySchemes.add(name);
    const oldScheme = securityScheme(ctx.oldDocument, name);
    const newScheme = securityScheme(ctx.newDocument, name);
    if (oldScheme === undefined || newScheme === undefined) {
      if (oldScheme !== newScheme) {
        addSecuritySchemeDifference(
          ctx,
          name,
          "$definition",
          oldScheme ?? "<missing>",
          newScheme ?? "<missing>",
          oldScheme !== undefined ? "breaking" : "potentially-breaking",
          `Referenced security scheme ${JSON.stringify(name)} is missing from one contract.`,
        );
      }
      continue;
    }

    if (!equal(oldScheme.type, newScheme.type)) {
      addSecuritySchemeDifference(ctx, name, "type", oldScheme.type, newScheme.type, "breaking",
        `Security scheme ${JSON.stringify(name)} changed type.`);
      continue;
    }

    if (oldScheme.type === "apiKey") {
      if (!equal(oldScheme.in, newScheme.in)) {
        addSecuritySchemeDifference(ctx, name, "in", oldScheme.in, newScheme.in, "breaking",
          `API key scheme ${JSON.stringify(name)} changed credential location.`);
      }
      const headerName = oldScheme.in === "header" && newScheme.in === "header";
      const oldName = headerName ? normalizedLower(oldScheme.name) : oldScheme.name;
      const newName = headerName ? normalizedLower(newScheme.name) : newScheme.name;
      if (!equal(oldName, newName)) {
        addSecuritySchemeDifference(ctx, name, "name", oldScheme.name, newScheme.name, "breaking",
          `API key scheme ${JSON.stringify(name)} changed credential name.`);
      }
    } else if (oldScheme.type === "http") {
      if (!equal(normalizedLower(oldScheme.scheme), normalizedLower(newScheme.scheme))) {
        addSecuritySchemeDifference(ctx, name, "scheme", oldScheme.scheme, newScheme.scheme, "breaking",
          `HTTP security scheme ${JSON.stringify(name)} changed authentication scheme.`);
      }
      if (!equal(oldScheme.bearerFormat, newScheme.bearerFormat)) {
        addSecuritySchemeDifference(ctx, name, "bearerFormat", oldScheme.bearerFormat, newScheme.bearerFormat, "potentially-breaking",
          `HTTP security scheme ${JSON.stringify(name)} changed bearer format.`);
      }
    } else if (oldScheme.type === "openIdConnect") {
      if (!equal(oldScheme.openIdConnectUrl, newScheme.openIdConnectUrl)) {
        addSecuritySchemeDifference(ctx, name, "openIdConnectUrl", oldScheme.openIdConnectUrl, newScheme.openIdConnectUrl, "potentially-breaking",
          `OpenID Connect scheme ${JSON.stringify(name)} changed discovery URL.`);
      }
    } else if (oldScheme.type === "oauth2" && !equal(oldScheme.flows, newScheme.flows)) {
      addSecuritySchemeDifference(ctx, name, "flows", oldScheme.flows, newScheme.flows, "potentially-breaking",
        `OAuth2 scheme ${JSON.stringify(name)} changed flows, endpoints, or declared scopes.`);
    }
  }
}

function compareSecurity(
  ctx: CompareContext,
  oldSecurity: unknown,
  newSecurity: unknown,
  location: string,
): void {
  const oldRequirements = normalizeSecurity(oldSecurity);
  const newRequirements = normalizeSecurity(newSecurity);
  compareReferencedSecuritySchemes(ctx, oldRequirements, newRequirements);
  if (equal(oldSecurity ?? [], newSecurity ?? [])) return;
  const everyOldCallerStillWorks = oldRequirements.every((oldRequirement) =>
    newRequirements.some((newRequirement) => noStronger(newRequirement, oldRequirement)));
  const everyNewCallerWorkedBefore = newRequirements.every((newRequirement) =>
    oldRequirements.some((oldRequirement) => noStronger(oldRequirement, newRequirement)));
  if (everyOldCallerStillWorks && everyNewCallerWorkedBefore) return;

  add(ctx, change(
    everyOldCallerStillWorks ? "SECURITY_RELAXED" : "SECURITY_STRENGTHENED",
    everyOldCallerStillWorks ? "non-breaking" : "breaking",
    "security",
    location,
    everyOldCallerStillWorks
      ? "Security requirements were relaxed or an authentication alternative was added."
      : "Some previously valid callers now need additional authentication or scopes.",
    {
      before: oldSecurity ?? [],
      after: newSecurity ?? [],
      recommendation: everyOldCallerStillWorks ? undefined : "Keep an old authentication alternative during migration or version the operation.",
    },
  ));
}

function compareMetadata(ctx: CompareContext, oldOperation: Node, newOperation: Node, base: string): void {
  if (!equal(oldOperation.operationId, newOperation.operationId)) {
    add(ctx, change("OPERATION_ID_CHANGED", "potentially-breaking", "metadata", `${base}.operationId`, "operationId changed and may rename generated SDK methods.", {
      before: oldOperation.operationId,
      after: newOperation.operationId,
      recommendation: "Preserve operationId or publish an SDK migration note.",
    }));
  }
  const oldDeprecated = oldOperation.deprecated === true;
  const newDeprecated = newOperation.deprecated === true;
  if (oldDeprecated !== newDeprecated) {
    add(ctx, change(
      newDeprecated ? "DEPRECATED_ADDED" : "DEPRECATED_REMOVED",
      newDeprecated ? "info" : "non-breaking",
      "metadata",
      `${base}.deprecated`,
      `The operation is ${newDeprecated ? "now" : "no longer"} deprecated.`,
      { before: oldDeprecated, after: newDeprecated },
    ));
  }
  for (const key of ["summary", "description"] as const) {
    if (!equal(oldOperation[key], newOperation[key])) {
      add(ctx, change("METADATA_CHANGED", "info", "metadata", `${base}.${key}`, `${key} changed.`, {
        before: oldOperation[key], after: newOperation[key],
      }));
    }
  }
}

function compareOperation(
  ctx: CompareContext,
  oldPathItem: Node,
  newPathItem: Node,
  oldOperation: Node,
  newOperation: Node,
  path: string,
  method: string,
): void {
  const base = operationLocation(path, method);
  compareMetadata(ctx, oldOperation, newOperation, base);
  compareParameters(ctx, oldPathItem, newPathItem, oldOperation, newOperation, base);
  compareRequestBody(ctx, oldOperation, newOperation, base);
  compareResponses(ctx, oldOperation, newOperation, base);
  const oldSecurity = own(oldOperation, "security") ? oldOperation.security : ctx.oldDocument.security;
  const newSecurity = own(newOperation, "security") ? newOperation.security : ctx.newDocument.security;
  compareSecurity(ctx, oldSecurity, newSecurity, `${base}.security`);
}

function comparePaths(ctx: CompareContext): void {
  const oldPaths = asRecord(ctx.oldDocument, ctx.oldDocument.paths) ?? {};
  const newPaths = asRecord(ctx.newDocument, ctx.newDocument.paths) ?? {};
  const pathNames = [...new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)])]
    .filter((path) => path.startsWith("/"))
    .sort();
  for (const path of pathNames) {
    const location = `paths[${JSON.stringify(path)}]`;
    if (own(oldPaths, path) && !own(newPaths, path)) {
      add(ctx, change("PATH_REMOVED", "breaking", "path", location, `Path ${path} was removed.`, {
        recommendation: "Retain the endpoint through a deprecation window or publish a new API version.",
      }));
      continue;
    }
    if (!own(oldPaths, path) && own(newPaths, path)) {
      add(ctx, change("PATH_ADDED", "non-breaking", "path", location, `Path ${path} was added.`));
      continue;
    }
    const oldPathItem = resolvePathItemNode(ctx.oldDocument, oldPaths[path]);
    const newPathItem = resolvePathItemNode(ctx.newDocument, newPaths[path]);
    if (!isRecord(oldPathItem) || !isRecord(newPathItem)) continue;
    // The specification does not define which overlapping Path Item field wins.
    // Keep its coverage warning rather than inventing a precise operation diff.
    if (pathItemReferenceConflicts(ctx.oldDocument, oldPaths[path]).length
      || pathItemReferenceConflicts(ctx.newDocument, newPaths[path]).length) continue;

    for (const method of HTTP_METHODS) {
      const oldOperation = asRecord(ctx.oldDocument, oldPathItem[method]);
      const newOperation = asRecord(ctx.newDocument, newPathItem[method]);
      if (oldOperation !== undefined && newOperation === undefined) {
        add(ctx, change("OPERATION_REMOVED", "breaking", "operation", operationLocation(path, method), `${method.toUpperCase()} ${path} was removed.`, {
          recommendation: "Keep the operation during a deprecation window or release a versioned replacement.",
        }));
      } else if (oldOperation === undefined && newOperation !== undefined) {
        add(ctx, change("OPERATION_ADDED", "non-breaking", "operation", operationLocation(path, method), `${method.toUpperCase()} ${path} was added.`));
      } else if (oldOperation !== undefined && newOperation !== undefined) {
        compareOperation(ctx, oldPathItem, newPathItem, oldOperation, newOperation, path, method);
      }
    }
  }
}

function sourceDescription(
  document: OpenApiDocument,
  fingerprint: AnalysisResult["source"]["old"]["fingerprint"],
  bundle?: AnalysisResult['source']['old']['bundle'],
): AnalysisResult["source"]["old"] {
  const result: AnalysisResult["source"]["old"] = { openapi: document.openapi, fingerprint, dialect: dialectFor(document), ...(bundle ? { bundle } : {}) };
  if (typeof document.info?.title === "string") result.title = document.info.title;
  if (typeof document.info?.version === "string") result.version = document.info.version;
  return result;
}

function finalizeChanges(changes: DraftChange[]): Change[] {
  const severityOrder: Record<Severity, number> = {
    breaking: 0,
    "potentially-breaking": 1,
    "non-breaking": 2,
    info: 3,
  };
  return changes
    .sort((left, right) =>
      severityOrder[left.severity] - severityOrder[right.severity]
      || compareText(left.location, right.location)
      || compareText(left.ruleId, right.ruleId)
      || compareText(stable(left.before), stable(right.before)))
    .map((item, index) => ({ id: `CG-${String(index + 1).padStart(4, "0")}`, ...item }));
}

/**
 * Analyze provider-side backward compatibility: can callers built against oldSpec
 * continue to call, and parse responses from, newSpec?
 */
export function analyzeCompatibility(
  oldSpec: OpenApiInput,
  newSpec: OpenApiInput,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const oldPrepared = prepareContract(oldSpec);
  const newPrepared = prepareContract(newSpec);
  const oldDocument = oldPrepared.document;
  const newDocument = newPrepared.document;
  const coverage = inspectCoverage(oldDocument, newDocument);
  const policy = resolveRulePolicy(options.policy);
  const ctx: CompareContext = {
    oldDocument,
    newDocument,
    changes: [],
    comparedSecuritySchemes: new Set<string>(),
    policy,
    options: {
      includeInfo: options.includeInfo ?? true,
      includeNonBreaking: options.includeNonBreaking ?? true,
    },
  };
  comparePaths(ctx);
  const changes = finalizeChanges(ctx.changes);
  const summary = {
    total: changes.length,
    breaking: changes.filter((item) => item.severity === "breaking").length,
    potentiallyBreaking: changes.filter((item) => item.severity === "potentially-breaking").length,
    nonBreaking: changes.filter((item) => item.severity === "non-breaking").length,
    info: changes.filter((item) => item.severity === "info").length,
  };
  const risk = changes.reduce((total, item) => total + policy.scoring[item.severity], 0);
  const timestamp = options.generatedAt instanceof Date
    ? options.generatedAt.toISOString()
    : typeof options.generatedAt === "string"
      ? new Date(options.generatedAt).toISOString()
      : new Date().toISOString();
  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: timestamp,
    policy: policy.metadata,
    source: {
      old: sourceDescription(oldDocument, oldPrepared.fingerprint, oldPrepared.bundle),
      new: sourceDescription(newDocument, newPrepared.fingerprint, newPrepared.bundle),
    },
    score: Math.max(0, 100 - Math.min(100, risk)),
    compatible: summary.breaking === 0,
    summary,
    changes,
    coverage,
  };
}
