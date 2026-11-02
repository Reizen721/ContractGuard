import { describe, expect, it } from "vitest";
import { analyzeCompatibility } from "../src/index.js";

type Schema = Record<string, unknown> | boolean;
type Document = Record<string, any>;

function schemaDocument(schema: Schema, direction: "request" | "response" = "request", version = "3.1.0"): Document {
  const media = { "application/json": { schema } };
  return {
    openapi: version,
    info: { title: "Atomic regression", version: "1" },
    paths: {
      "/probe": {
        post: direction === "request"
          ? { requestBody: { content: media }, responses: { "200": { description: "OK" } } }
          : { responses: { "200": { description: "OK", content: media } } },
      },
    },
  };
}

function compareSchema(before: Schema, after: Schema, direction: "request" | "response" = "request", version = "3.1.0") {
  return analyzeCompatibility(schemaDocument(before, direction, version), schemaDocument(after, direction, version));
}

function parameterDocument(parameter: Record<string, unknown>): Document {
  const result = schemaDocument({ type: "string" });
  result.paths["/probe"].post.parameters = [parameter];
  return result;
}

function headersDocument(headers: Record<string, unknown>): Document {
  const result = schemaDocument({ type: "string" });
  result.paths["/probe"].post.responses["200"].headers = headers;
  return result;
}

describe("V1.2 numeric endpoint regressions", () => {
  it.each([
    ["minimum", "exclusiveMinimum"],
    ["maximum", "exclusiveMaximum"],
  ] as const)("detects OpenAPI 3.0 boolean %s exclusivity at zero", (inclusiveKey, exclusiveKey) => {
    const before = { type: "number", [inclusiveKey]: 0, [exclusiveKey]: false };
    const after = { ...before, [exclusiveKey]: true };
    expect(compareSchema(before, after, "request", "3.0.4").changes).toContainEqual(expect.objectContaining({
      ruleId: "SCHEMA_CONSTRAINT_TIGHTENED", severity: "breaking", location: expect.stringContaining(exclusiveKey),
    }));
    expect(compareSchema(after, before, "request", "3.0.4").changes).toContainEqual(expect.objectContaining({
      ruleId: "SCHEMA_CONSTRAINT_RELAXED", severity: "non-breaking",
    }));
    expect(compareSchema(before, after, "response", "3.0.4").changes).toContainEqual(expect.objectContaining({ severity: "non-breaking" }));
    expect(compareSchema(after, before, "response", "3.0.4").changes).toContainEqual(expect.objectContaining({ severity: "potentially-breaking" }));
  });

  it("treats omitted 3.0 exclusivity as false and a flag without its boundary as inert", () => {
    expect(compareSchema({ type: "number", minimum: 0 }, { type: "number", minimum: 0, exclusiveMinimum: false }, "request", "3.0.4").changes).toEqual([]);
    expect(compareSchema({ type: "number" }, { type: "number", exclusiveMinimum: true }, "request", "3.0.4").changes).toEqual([]);
  });

  it.each([
    [{ type: "number", minimum: 0 }, { type: "number", exclusiveMinimum: 0 }],
    [{ type: "number", maximum: 0 }, { type: "number", exclusiveMaximum: 0 }],
  ])("handles 3.1 numeric exclusivity without double-counting the endpoint", (before, after) => {
    const result = compareSchema(before, after);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ ruleId: "SCHEMA_CONSTRAINT_TIGHTENED", severity: "breaking" });
  });

  it("selects the stronger of simultaneous 3.1 inclusive and exclusive bounds", () => {
    expect(compareSchema({ type: "number", minimum: 2 }, { type: "number", minimum: 2, exclusiveMinimum: 0 }).changes).toEqual([]);
    expect(compareSchema({ type: "number", maximum: 2 }, { type: "number", maximum: 2, exclusiveMaximum: 4 }).changes).toEqual([]);
    expect(compareSchema({ type: "number", minimum: 0 }, { type: "number", minimum: -2, exclusiveMinimum: 0 }).summary.breaking).toBe(1);
  });

  it("normalizes equivalent endpoints across 3.0 and 3.1", () => {
    const before = schemaDocument({ type: "number", minimum: 0, exclusiveMinimum: true }, "request", "3.0.4");
    const after = schemaDocument({ type: "number", exclusiveMinimum: 0 }, "request", "3.1.0");
    expect(analyzeCompatibility(before, after).changes).toEqual([]);
  });

  it("does not invent integer endpoint changes where the accepted integers are identical", () => {
    expect(compareSchema({ type: "integer", minimum: 0.5 }, { type: "integer", exclusiveMinimum: 0.5 }).changes).toEqual([]);
    expect(compareSchema({ type: "integer", exclusiveMinimum: 0 }, { type: "integer", minimum: 1 }).changes).toEqual([]);
    expect(compareSchema({ type: "integer", exclusiveMaximum: 1 }, { type: "integer", maximum: 0 }).changes).toEqual([]);
  });
});

describe("V1.2 conservative composition regressions", () => {
  it("does not call an overlapping added oneOf branch safe", () => {
    const result = compareSchema({ oneOf: [{ type: "integer" }] }, { oneOf: [{ type: "integer" }, { type: "number" }] });
    expect(result.changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_COMPOSITION_CHANGED", severity: "potentially-breaking" }));
    expect(result.score).toBeLessThan(100);
  });

  it.each(["oneOf", "anyOf", "allOf"])("requires review of changed %s branches in both directions", (keyword) => {
    for (const direction of ["request", "response"] as const) {
      const result = compareSchema({ [keyword]: [{ type: "integer" }] }, { [keyword]: [{ type: "number" }, { type: "string" }] }, direction);
      expect(result.changes).toEqual([expect.objectContaining({ ruleId: "SCHEMA_COMPOSITION_CHANGED", severity: "potentially-breaking" })]);
    }
  });

  it.each(["oneOf", "anyOf", "allOf"])("does not compare reordered %s branches by array position", (keyword) => {
    const before = { [keyword]: [{ type: "string", minLength: 2 }, { type: "integer", minimum: 0 }] };
    const after = { [keyword]: [{ type: "integer", minimum: 0 }, { type: "string", minLength: 2, description: "Documentation only" }] };
    expect(compareSchema(before, after).changes).toEqual([]);
  });

  it("preserves oneOf multiplicity but ignores redundant anyOf/allOf duplicates", () => {
    const branch = { type: "string" };
    expect(compareSchema({ oneOf: [branch] }, { oneOf: [branch, branch] }).summary.potentiallyBreaking).toBe(1);
    for (const keyword of ["anyOf", "allOf"]) expect(compareSchema({ [keyword]: [branch] }, { [keyword]: [branch, branch] }).changes).toEqual([]);
  });

  it("finds a changed nested reference inside otherwise identical composition branches", () => {
    const make = (type: string): Document => {
      const spec = schemaDocument({ oneOf: [{ type: "object", properties: { child: { $ref: "#/components/schemas/Child" } } }] });
      spec.components = { schemas: { Child: { type } } };
      return spec;
    };
    expect(analyzeCompatibility(make("string"), make("number")).changes).toContainEqual(expect.objectContaining({
      ruleId: "SCHEMA_COMPOSITION_CHANGED", severity: "potentially-breaking",
    }));
  });

  it("terminates for a recursive local reference inside a composition", () => {
    const spec = schemaDocument({ oneOf: [{ $ref: "#/components/schemas/Node" }] });
    spec.components = { schemas: { Node: { type: "object", properties: { next: { $ref: "#/components/schemas/Node" } } } } };
    expect(analyzeCompatibility(spec, structuredClone(spec)).changes).toEqual([]);
  });

  it("bounds repeated reference expansion and marks an unproven comparison for review", () => {
    const spec = schemaDocument({ oneOf: [{ $ref: "#/components/schemas/Level0" }] });
    const schemas: Record<string, unknown> = {};
    for (let level = 0; level < 15; level += 1) {
      const child = level === 14 ? { type: "string" } : { $ref: `#/components/schemas/Level${level + 1}` };
      schemas[`Level${level}`] = { type: "object", properties: { left: child, right: child } };
    }
    spec.components = { schemas };
    const result = analyzeCompatibility(spec, structuredClone(spec));
    expect(result.changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_COMPOSITION_CHANGED", severity: "potentially-breaking" }));
  });
});

describe("V1.2 wire-contract regressions", () => {
  const ids = { name: "ids", in: "query", schema: { type: "array", items: { type: "string" } } };

  it("detects the repeated-query to comma-separated serialization change", () => {
    const result = analyzeCompatibility(parameterDocument({ ...ids, explode: true }), parameterDocument({ ...ids, explode: false }));
    expect(result.changes).toContainEqual(expect.objectContaining({
      ruleId: "PARAMETER_SERIALIZATION_CHANGED", severity: "potentially-breaking",
      before: { mode: "schema", style: "form", explode: true, allowReserved: false },
      after: { mode: "schema", style: "form", explode: false, allowReserved: false },
    }));
  });

  it("normalizes query/path/header/cookie serialization defaults", () => {
    for (const placement of ["query", "path", "header", "cookie"]) {
      const form = placement === "query" || placement === "cookie";
      const parameter = { ...ids, in: placement };
      expect(analyzeCompatibility(parameterDocument(parameter), parameterDocument({ ...parameter, style: form ? "form" : "simple", explode: form, allowReserved: false })).changes).toEqual([]);
    }
  });

  it("detects style and query allowReserved changes but ignores allowReserved on headers", () => {
    expect(analyzeCompatibility(parameterDocument(ids), parameterDocument({ ...ids, style: "pipeDelimited" })).summary.potentiallyBreaking).toBe(1);
    expect(analyzeCompatibility(parameterDocument(ids), parameterDocument({ ...ids, allowReserved: true })).summary.potentiallyBreaking).toBe(1);
    expect(analyzeCompatibility(parameterDocument({ ...ids, in: "header" }), parameterDocument({ ...ids, in: "header", allowReserved: true })).changes).toEqual([]);
  });

  it("does not silently ignore changes of a parameter's content media type", () => {
    const before = { name: "filter", in: "query", content: { "application/json": { schema: { type: "string" } } } };
    const after = { name: "filter", in: "query", content: { "text/plain": { schema: { type: "string" } } } };
    expect(analyzeCompatibility(parameterDocument(before), parameterDocument(after)).changes).toContainEqual(expect.objectContaining({ ruleId: "PARAMETER_SERIALIZATION_CHANGED" }));
  });

  it("detects response header removals, additions and schema changes", () => {
    const result = analyzeCompatibility(
      headersDocument({ "X-Next-Cursor": { schema: { type: "string" } }, "X-Count": { schema: { type: "integer" } } }),
      headersDocument({ "X-Count": { schema: { type: "string" } }, "X-Request-ID": { schema: { type: "string" } } }),
    );
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "RESPONSE_HEADER_REMOVED", severity: "potentially-breaking", location: expect.stringContaining("X-Next-Cursor") }),
      expect.objectContaining({ ruleId: "RESPONSE_HEADER_ADDED", severity: "non-breaking" }),
      expect.objectContaining({ ruleId: "SCHEMA_TYPE_CHANGED", severity: "breaking", location: expect.stringContaining("X-Count") }),
    ]));
  });

  it("matches response headers case-insensitively, resolves local header references and ignores Content-Type", () => {
    const before = headersDocument({ "X-Cursor": { $ref: "#/components/headers/Cursor" }, "Content-Type": { schema: { type: "string" } } });
    before.components = { headers: { Cursor: { schema: { type: "string" } } } };
    const after = headersDocument({ "x-cursor": { schema: { type: "string" }, style: "simple", explode: false } });
    expect(analyzeCompatibility(before, after).changes).toEqual([]);
  });

  it("detects response header serialization changes", () => {
    const header = { schema: { type: "array", items: { type: "string" } } };
    expect(analyzeCompatibility(headersDocument({ "X-Parts": header }), headersDocument({ "X-Parts": { ...header, explode: true } })).changes).toContainEqual(expect.objectContaining({
      ruleId: "RESPONSE_HEADER_SERIALIZATION_CHANGED", severity: "potentially-breaking",
    }));
  });
});

describe("V1.2 open-object property regressions", () => {
  it("detects a typed optional property constraining a previously open request object", () => {
    const result = compareSchema({ type: "object" }, { type: "object", properties: { note: { type: "string" } } });
    expect(result.changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_PROPERTY_ADDED", severity: "breaking" }));
    expect(result.compatible).toBe(false);
  });

  it("allows optional fields on formerly closed request objects and unconstrained fields on open objects", () => {
    const closed = compareSchema({ type: "object", additionalProperties: false }, { type: "object", additionalProperties: false, properties: { note: { type: "string" } } });
    expect(closed.summary.breaking).toBe(0);
    expect(closed.summary.potentiallyBreaking).toBe(0);
    expect(compareSchema({ type: "object" }, { type: "object", properties: { note: {} } }).summary.breaking).toBe(0);
  });

  it("accounts for schema-valued additionalProperties rather than assuming optional means safe", () => {
    const before = { type: "object", additionalProperties: { type: "string" } };
    const same = { ...before, properties: { note: { type: "string" } } };
    expect(compareSchema(before, same).summary.potentiallyBreaking).toBe(0);
    const different = { ...before, properties: { note: { type: "integer" } } };
    expect(compareSchema(before, different).summary.potentiallyBreaking).toBe(1);
  });

  it("distinguishes request-property removal with open, closed and uncertain additionalProperties", () => {
    const before = { type: "object", properties: { note: { type: "string" } } };
    expect(compareSchema(before, { type: "object" }).changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_PROPERTY_REMOVED", severity: "non-breaking" }));
    expect(compareSchema(before, { type: "object", additionalProperties: false }).changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_PROPERTY_REMOVED", severity: "breaking" }));
    expect(compareSchema(before, { type: "object", additionalProperties: { type: "number" } }).changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_PROPERTY_REMOVED", severity: "potentially-breaking" }));
  });

  it("keeps response property removal release-blocking and readOnly request additions ignored", () => {
    const before = { type: "object", properties: { note: { type: "string" } } };
    expect(compareSchema(before, { type: "object" }, "response").changes).toContainEqual(expect.objectContaining({ ruleId: "SCHEMA_PROPERTY_REMOVED", severity: "breaking" }));
    expect(compareSchema({ type: "object" }, { type: "object", properties: { serverId: { type: "string", readOnly: true } } }).changes).toEqual([]);
  });
});
