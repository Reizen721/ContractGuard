import { describe, expect, it } from "vitest";
import { BUNDLE_FILES_KEY, BUNDLE_LIMITS, locateContractSource, normalizeBundlePath, prepareContract } from "../src/bundle.js";
import { ContractGuardError } from "../src/errors.js";
import { fingerprintText } from "../src/fingerprint.js";
import { resolveLocalRef, resolveNode } from "../src/parser.js";
import type { OpenApiBundleInput } from "../src/types.js";

function root(schema: unknown = { $ref: "schemas/order.yaml#/$defs/Order" }) {
  return { openapi: "3.1.0", info: { title: "Orders", version: "1" }, paths: { "/orders": { post: {
    requestBody: { content: { "application/json": { schema } } }, responses: { "200": { description: "OK" } },
  } } } };
}

function bundle(schema: unknown = { type: "object", properties: { id: { type: "integer" } } }): OpenApiBundleInput {
  return { kind: "bundle", entry: "openapi.yaml", files: [
    { path: "openapi.yaml", content: JSON.stringify(root()) },
    { path: "schemas/order.yaml", content: JSON.stringify({ $defs: { Order: schema } }) },
  ] };
}

function code(run: () => unknown, expected: string): void {
  try { run(); throw new Error("Expected error"); } catch (error) {
    expect(error).toBeInstanceOf(ContractGuardError);
    expect((error as ContractGuardError).code).toBe(expected);
  }
}

describe("V1.3 local contract bundles", () => {
  it("preserves single-file parsing formats and byte fingerprints", () => {
    const yaml = "openapi: 3.0.4\ninfo: { title: Single, version: '1' }\npaths: {}\n";
    expect(prepareContract(yaml).format).toBe("yaml");
    expect(prepareContract(yaml).fingerprint).toEqual(fingerprintText(yaml));
    expect(prepareContract(yaml).bundle).toBeUndefined();
  });

  it("resolves a fragment file and exposes dependency fingerprints without raw source", () => {
    const prepared = prepareContract(bundle());
    const schema = (prepared.document.paths as any)["/orders"].post.requestBody.content["application/json"].schema;
    expect(resolveNode(prepared.document, schema)).toEqual({ type: "object", properties: { id: { type: "integer" } } });
    expect(prepared.bundle?.files.map((file) => file.path)).toEqual(["openapi.yaml", "schemas/order.yaml"]);
    expect(prepared.bundle?.files[1]?.fingerprint.algorithm).toBe("sha256");
    expect(JSON.stringify(prepared.bundle)).not.toContain('"content"');
  });

  it("uses stable file order and ignores unreferenced supplied file content", () => {
    const input = bundle();
    const baseline = prepareContract(input);
    input.files.reverse();
    input.files.push({ path: "unused.yaml", content: "invalid: [" });
    expect(prepareContract(input).fingerprint).toEqual(baseline.fingerprint);
    expect(prepareContract(input).bundle?.files).toHaveLength(2);
    input.files.find((file) => file.path === "schemas/order.yaml")!.content += "\n ";
    expect(prepareContract(input).fingerprint).not.toEqual(baseline.fingerprint);
  });

  it("resolves nested relative file paths and same-file pointers against the referenced file", () => {
    const input = bundle({ $ref: "../common.json#/Shared" });
    input.files.push({ path: "common.json", content: JSON.stringify({ Shared: { $ref: "#/Leaf" }, Leaf: { type: "string" } }) });
    const prepared = prepareContract(input);
    const schema = (prepared.document.paths as any)["/orders"].post.requestBody.content["application/json"].schema;
    expect(resolveNode(prepared.document, schema)).toEqual({ type: "string" });
    expect(prepared.bundle?.files.map((file) => file.path)).toEqual(["common.json", "openapi.yaml", "schemas/order.yaml"]);
  });

  it("retains recursive refs as graph edges rather than generating cyclic JavaScript values", () => {
    const input = bundle({ type: "object", properties: { child: { $ref: "#/$defs/Order" } } });
    const prepared = prepareContract(input);
    expect(() => JSON.stringify(prepared.document)).not.toThrow();
    const ref = (prepared.document[BUNDLE_FILES_KEY] as any)["schemas/order.yaml"].$defs.Order.properties.child.$ref;
    expect(resolveLocalRef(prepared.document, ref)).toHaveProperty("type", "object");
  });

  it("does not inspect $ref-shaped payload data in examples, enum, default, or extensions", () => {
    const data = { $ref: "https://private.example.invalid/secrets" };
    const document = root({ type: "object", example: data, examples: [data], enum: [data], default: data, "x-data": data });
    (document.paths["/orders"].post.responses["200"] as any).content = { "application/json": { example: data, examples: { payload: { value: data } }, schema: { type: "object" } } };
    const prepared = prepareContract({ kind: "bundle", entry: "openapi.yaml", files: [{ path: "openapi.yaml", content: JSON.stringify(document) }] });
    expect(prepared.bundle?.files).toHaveLength(1);
    expect(JSON.stringify(prepared.document)).toContain("https://private.example.invalid/secrets");
  });

  it("does not rewrite a payload example that shares a YAML alias with a schema", () => {
    const text = `openapi: 3.1.0
info: {title: Alias, version: '1'}
paths:
  /orders:
    post:
      requestBody:
        content:
          application/json:
            schema: &value
              $ref: './value.yaml'
            example: *value
      responses:
        '200': {description: OK}
`;
    const prepared = prepareContract({ kind: "bundle", entry: "openapi.yaml", files: [
      { path: "openapi.yaml", content: text }, { path: "value.yaml", content: "type: string" },
    ] });
    const media = (prepared.document.paths as any)["/orders"].post.requestBody.content["application/json"];
    expect(media.schema.$ref).toContain(BUNDLE_FILES_KEY);
    expect(media.example.$ref).toBe("./value.yaml");
  });

  it("returns a safe missingFile hint for CLI dependency loading", () => {
    const input = bundle();
    input.files.pop();
    try { prepareContract(input); throw new Error("Expected error"); } catch (error) {
      expect((error as ContractGuardError).code).toBe("INVALID_BUNDLE");
      expect((error as ContractGuardError).details?.missingFile).toBe("schemas/order.yaml");
    }
  });

  it.each(["/etc/passwd.yaml", "C:/secret.yaml", "\\\\server\\secret.yaml", "../secret.yaml", "https://example.com/schema.yaml", "file:///tmp/schema.yaml", "schemas/%2e%2e/secret.yaml", "schemas\\secret.yaml", "a.yaml?x=1", "a.yaml\u0000"])("rejects unsafe manifest path %s", (path) => {
    const input = bundle();
    input.files[1]!.path = path;
    code(() => prepareContract(input), "INVALID_BUNDLE");
  });

  it.each(["https://example.com/schema.yaml", "file:///secret.yaml", "../../secret.yaml", "C:/secret.yaml", "\\\\host\\secret.yaml", "%2e%2e/secret.yaml"])("rejects unsafe ref %s without returning a load hint", (reference) => {
    const input = bundle({ $ref: reference });
    try { prepareContract(input); throw new Error("Expected error"); } catch (error) {
      expect(error).toBeInstanceOf(ContractGuardError);
      expect((error as ContractGuardError).details?.missingFile).toBeUndefined();
    }
  });

  it("allows package-internal .. resolution but never root escapes", () => {
    expect(normalizeBundlePath("../common.json", "schemas")).toBe("common.json");
    expect(() => normalizeBundlePath("../../common.json", "schemas")).toThrow(/escapes/);
  });

  it.each(["schemas/ORDER.yaml", "./schemas/order.yaml"])("rejects duplicate/case-aliased path %s", (path) => {
    const input = bundle(); input.files.push({ path, content: "{}" });
    code(() => prepareContract(input), "INVALID_BUNDLE");
  });

  it("rejects unknown fields and malformed bundle structures", () => {
    code(() => prepareContract({ ...bundle(), root: "C:/" }), "INVALID_BUNDLE");
    code(() => prepareContract({ kind: "bundle", entry: "openapi.yaml", files: "no" } as any), "INVALID_BUNDLE");
    code(() => prepareContract({ ...bundle(), files: [{ path: "openapi.yaml", content: 4 }] } as any), "INVALID_BUNDLE");
  });

  it("caps file count and combined text size before parsing", () => {
    code(() => prepareContract({ kind: "bundle", entry: "a.yaml", files: [] }), "BUNDLE_LIMIT_EXCEEDED");
    code(() => prepareContract({ kind: "bundle", entry: "a.yaml", files: Array.from({ length: 51 }, (_, index) => ({ path: `${index}.yaml`, content: "{}" })) }), "BUNDLE_LIMIT_EXCEEDED");
    code(() => prepareContract({ kind: "bundle", entry: "a.yaml", files: [{ path: "a.yaml", content: " ".repeat(BUNDLE_LIMITS.bytes + 1) }] }), "BUNDLE_LIMIT_EXCEEDED");
  });

  it("rejects the private graph field in entry, dependency, and single-file inputs", () => {
    code(() => prepareContract({ ...root(), [BUNDLE_FILES_KEY]: {} }), "INVALID_BUNDLE");
    const input = bundle(); input.files[0]!.content = JSON.stringify({ ...root(), [BUNDLE_FILES_KEY]: {} });
    code(() => prepareContract(input), "INVALID_BUNDLE");
    input.files[0]!.content = JSON.stringify(root()); input.files[1]!.content = JSON.stringify({ $defs: { Order: {} }, [BUNDLE_FILES_KEY]: {} });
    code(() => prepareContract(input), "INVALID_BUNDLE");
  });

  it("rejects missing pointer targets and named anchors", () => {
    code(() => prepareContract(bundle({ $ref: "#/Missing" })), "INVALID_REFERENCE");
    code(() => prepareContract(bundle({ $ref: "#Order" })), "INVALID_REFERENCE");
  });

  it("rejects resource-scoped refs instead of resolving $id against the wrong physical file", () => {
    const input = bundle({ $id: "https://schemas.example.test/order", $ref: "#/Leaf" });
    code(() => prepareContract(input), "INVALID_BUNDLE");
  });

  it("caps dependency depth without following an unbounded chain", () => {
    const input: OpenApiBundleInput = { kind: "bundle", entry: "openapi.yaml", files: [{ path: "openapi.yaml", content: JSON.stringify(root({ $ref: "s0.yaml" })) }] };
    for (let index = 0; index < 34; index += 1) input.files.push({ path: `s${index}.yaml`, content: JSON.stringify(index === 33 ? { type: "string" } : { $ref: `s${index + 1}.yaml` }) });
    code(() => prepareContract(input), "BUNDLE_LIMIT_EXCEEDED");
  });

  it("rejects alias cycles before walking the graph", () => {
    const input = bundle(); input.files[1]!.content = "$defs:\n  Order: &self\n    properties:\n      recursive: *self\n";
    expect(() => prepareContract(input)).toThrow(/circular/);
  });

  it("preserves original file and pointer for a finding beneath a cross-file ref", () => {
    const { document } = prepareContract(bundle());
    expect(locateContractSource(document, 'paths["/orders"].post.requestBody.content["application/json"].schema.properties["id"].type')).toEqual({ file: "schemas/order.yaml", pointer: "#/$defs/Order/properties/id/type" });
    expect(locateContractSource(document, 'paths["/orders"].post.requestBody.content["application/json"].schema.properties["missing"].type')).toEqual({ file: "schemas/order.yaml", pointer: "#/$defs/Order/properties" });
    expect(locateContractSource(parseOpenApiForTest(), 'paths["/orders"]')).toBeUndefined();
  });

  it("maps inherited and overridden parameter virtual locations to real array indexes", () => {
    const document = root({ type: "string" });
    (document.paths["/orders"] as any).parameters = [{ in: "header", name: "X-Tenant", schema: { type: "string" } }];
    (document.paths["/orders"].post as any).parameters = [{ in: "header", name: "X-Tenant", required: true, schema: { type: "string" } }];
    const prepared = prepareContract({ kind: "bundle", entry: "openapi.yaml", files: [{ path: "openapi.yaml", content: JSON.stringify(document) }] });
    expect(locateContractSource(prepared.document, 'paths["/orders"].post.parameters.header["x-tenant"].required')).toEqual({ file: "openapi.yaml", pointer: "#/paths/~1orders/post/parameters/0/required" });
  });
});

function parseOpenApiForTest() {
  return prepareContract(JSON.stringify(root({ type: "string" }))).document;
}
