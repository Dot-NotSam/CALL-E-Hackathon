/**
 * packages/calle/__tests__/schema.test.ts
 *
 * The result schema is the contract between a phone conversation and a
 * workflow. If it drifts from `WholesaleResult`, the agent branches on fields
 * CALL-E was never asked to extract — and the failure is silent.
 *
 * The type-level guard in schema.ts catches renamed properties. These tests
 * cover what it cannot: enum membership and JSON Schema `type` keywords.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WHOLESALE_COORDINATION_RESULT_SCHEMA as SCHEMA,
  REQUIRED_RESULT_FIELDS,
} from "../schema";
import { HUMAN_REVIEW_THRESHOLD } from "../../types";

describe("the schema matches PRD §7.2", () => {
  it("requires exactly the three fields the decision table needs", () => {
    expect(SCHEMA.required).toEqual(["contact_reached", "stock_status", "next_action"]);
    expect(REQUIRED_RESULT_FIELDS).toEqual(SCHEMA.required);
  });

  it("declares the six next_action values the graph routes on", () => {
    expect(SCHEMA.properties.next_action.enum).toEqual([
      "CONFIRM_ORDER",
      "PARTIAL_CONFIRMATION",
      "REQUEST_APPROVAL",
      "SCHEDULE_CALLBACK",
      "ESCALATE_NEXT_CONTACT",
      "HUMAN_REVIEW",
    ]);
  });

  it("declares the contact_reached values, including the two safety cases", () => {
    expect(SCHEMA.properties.contact_reached.enum).toEqual([
      "yes",
      "no",
      "wrong_person",
      "voicemail",
      "unknown",
    ]);
  });

  it("declares the stock_status values", () => {
    expect(SCHEMA.properties.stock_status.enum).toEqual([
      "confirmed",
      "partial",
      "unavailable",
      "unknown",
    ]);
  });

  it("types the quantities and price as numbers, not strings", () => {
    for (const field of ["confirmed_quantity", "remaining_quantity", "unit_price"] as const) {
      expect(SCHEMA.properties[field].type).toBe("number");
    }
  });

  it("types requires_approval as a boolean", () => {
    expect(SCHEMA.properties.requires_approval.type).toBe("boolean");
  });
});

describe("the descriptions are part of the prompt, not documentation", () => {
  it("gives every property a description — CALL-E shows these to the extractor", () => {
    for (const [name, property] of Object.entries(SCHEMA.properties)) {
      expect(
        (property as { description?: string }).description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ).toBeDefined();
      expect((property as { description: string }).description.length).toBeGreaterThan(20);
      expect(name).toBeTruthy();
    }
  });

  it("tells the extractor to record a changed price rather than negotiate it", () => {
    expect(SCHEMA.properties.unit_price.description).toMatch(/Never negotiate/);
  });

  it("tells the extractor to resolve a relative callback time", () => {
    expect(SCHEMA.properties.callback_requested_at.description).toMatch(/Resolve relative times/);
  });

  it("tells the extractor to quote rather than paraphrase the commitment", () => {
    expect(SCHEMA.properties.verbatim_commitment.description).toMatch(/do not paraphrase/i);
  });
});

describe("HUMAN_REVIEW_THRESHOLD", () => {
  it("is 0.7, the value PRD §6 and the contract doc both name", () => {
    expect(HUMAN_REVIEW_THRESHOLD).toBe(0.7);
  });
});

describe("the skill's published schema", () => {
  /**
   * `skills/.../references/result-schema.json` is what a third party reading
   * the skill will code against. Unlike `scripts/lib/`, it is hand-maintained
   * rather than generated — so this test is the only thing standing between it
   * and silent drift from the schema we actually send to CALL-E.
   */
  it("is byte-for-byte the schema the agent sends", () => {
    const published = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "..",
          "..",
          "..",
          "skills",
          "wholesale-order-coordination",
          "references",
          "result-schema.json"
        ),
        "utf8"
      )
    );

    expect(published).toEqual(JSON.parse(JSON.stringify(SCHEMA)));
  });
});
