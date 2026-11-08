import { describe, expect, it } from "vitest";
import {
  inferSchemaMigrations,
  synthesizeDifferentialWitnesses,
  validateOutboundRequest,
} from "../src/index.js";

describe("schema migration alignment and differential witness synthesis", () => {
  it("infers structural nesting, simultaneous nullability widening, and synthesizes valid adversarial null witness", () => {
    const baseline = {
      openapi: "3.1.0",
      info: { title: "Orders", version: "1.0.0" },
      paths: {
        "/orders/current": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id", "customerName"],
                      properties: {
                        id: { type: "string" },
                        customerName: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const candidate = {
      openapi: "3.1.0",
      info: { title: "Orders", version: "2.0.0" },
      paths: {
        "/orders/current": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["id", "customer"],
                      properties: {
                        id: { type: "string" },
                        customer: {
                          type: "object",
                          required: ["displayName"],
                          properties: {
                            displayName: { type: ["string", "null"] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const alignment = inferSchemaMigrations(baseline, candidate);
    expect(alignment.hypotheses.some((h) => h.kind === "structural-nest" && h.fromPath === "customerName" && h.toPath === "customer.displayName")).toBe(true);
    expect(alignment.hypotheses.some((h) => h.kind === "nullability-widening" && h.toPath === "customer.displayName")).toBe(true);

    const suites = synthesizeDifferentialWitnesses(baseline, candidate, {
      alignment,
      seedBaselineResponses: {
        "GET /orders/current": { body: { id: "ORD-101", customerName: "Alice" } },
      },
    });
    expect(suites).toHaveLength(1);
    const suite = suites[0]!;
    expect(suite.baselineNominal.schemaValid).toBe(true);
    expect(suite.candidateNominal.schemaValid).toBe(true);
    expect(suite.candidateNominal.body).toEqual({
      id: "ORD-101",
      customer: { displayName: "Alice" },
    });
    const nullWitness = suite.adversarial.find((w) => w.kind === "adversarial-null");
    expect(nullWitness).toBeDefined();
    expect(nullWitness!.schemaValid).toBe(true);
    expect(nullWitness!.body).toEqual({
      id: "ORD-101",
      customer: { displayName: null },
    });
  });

  it("infers enum extension, type coercion, and validates outbound required request parameters", () => {
    const baseline = {
      openapi: "3.1.0",
      info: { title: "Payments", version: "1.0.0" },
      paths: {
        "/payments/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["amountCents", "status"],
                      properties: {
                        amountCents: { type: "integer" },
                        status: { type: "string", enum: ["PAID", "PENDING"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const candidate = {
      openapi: "3.1.0",
      info: { title: "Payments", version: "2.0.0" },
      paths: {
        "/payments/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "apiVersion", in: "query", required: true, schema: { type: "string", enum: ["2026-11"] } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["amountDecimal", "status"],
                      properties: {
                        amountDecimal: { type: "string" },
                        status: { type: "string", enum: ["PAID", "PENDING", "ON_HOLD"] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const alignment = inferSchemaMigrations(baseline, candidate);
    expect(alignment.hypotheses.some((h) => h.coercionHint === "cents-to-decimal")).toBe(true);
    expect(alignment.hypotheses.some((h) => h.kind === "enum-extension" && h.addedEnumValues?.includes("ON_HOLD"))).toBe(true);
    expect(alignment.hypotheses.some((h) => h.kind === "request-param-required" && h.toPath === "apiVersion" && h.suggestedParamValue === "2026-11")).toBe(true);

    const suites = synthesizeDifferentialWitnesses(baseline, candidate, {
      alignment,
      seedBaselineResponses: {
        "GET /payments/{id}": { body: { amountCents: 2550, status: "PAID" } },
      },
    });
    expect(suites[0]!.candidateNominal.body).toEqual({ amountDecimal: "25.50", status: "PAID" });
    expect(suites[0]!.adversarial.some((w) => w.kind === "adversarial-enum-variant" && (w.body as any).status === "ON_HOLD")).toBe(true);

    const missingQuery = validateOutboundRequest(candidate, { method: "GET", url: "/payments/pay-1" });
    expect(missingQuery.valid).toBe(false);
    expect(missingQuery.violations[0]?.code).toBe("MISSING_REQUIRED_QUERY_PARAM");

    const validQuery = validateOutboundRequest(candidate, { method: "GET", url: "/payments/pay-1?apiVersion=2026-11" });
    expect(validQuery.valid).toBe(true);
  });
});
