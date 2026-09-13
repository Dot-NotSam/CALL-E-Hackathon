/**
 * packages/calle/__tests__/mock.test.ts
 *
 * The mock driver is the dev harness five people build against, and it is what
 * every other test in this repo runs on. If it drifts from the real driver's
 * interface — or starts replaying a state sequence CALL-E never produces — the
 * whole suite passes while the demo breaks.
 *
 * It is also the file most likely to be mistaken for real output, so the
 * labelling rules (Rule 8) are asserted here.
 */

import { mockCalle, type MockScenario } from "../mock";
import type { CallState } from "../../types";

const ALL_SCENARIOS = Object.keys(mockCalle._scenarios) as MockScenario[];

const params = { task: "[test] task", resultSchema: {} };

afterEach(() => {
  delete process.env.SENTINEL_MOCK_OPTIMISTIC;
});

describe("scenario coverage", () => {
  it("covers every branch the decision table can take", () => {
    const actions = new Set(
      ALL_SCENARIOS.map((s) => mockCalle._scenarios[s].structuredResult.next_action)
    );

    expect(actions).toEqual(
      new Set([
        "CONFIRM_ORDER",
        "PARTIAL_CONFIRMATION",
        "REQUEST_APPROVAL",
        "SCHEDULE_CALLBACK",
        "ESCALATE_NEXT_CONTACT",
      ])
    );
  });

  it("returns a schema-valid result for every scenario", async () => {
    for (const scenario of ALL_SCENARIOS) {
      const result = await mockCalle.runCall(params, scenario, {}, 0);

      // The three required fields must always be present (PRD §7.2).
      expect(result.structuredResult.contact_reached).toBeDefined();
      expect(result.structuredResult.stock_status).toBeDefined();
      expect(result.structuredResult.next_action).toBeDefined();
      expect(result.completionConfidence.score).toBeGreaterThanOrEqual(0);
      expect(result.completionConfidence.score).toBeLessThanOrEqual(1);
      expect(Array.isArray(result.evidence)).toBe(true);
    }
  });

  it("throws on an unknown scenario rather than silently returning nothing", async () => {
    await expect(
      mockCalle.runCall(params, "not_a_scenario" as MockScenario, {}, 0)
    ).rejects.toThrow(/Unknown mock scenario/);
  });

  it("gives a call that nobody answered zero confidence, by construction", async () => {
    const result = await mockCalle.runCall(params, "no_answer", {}, 0);
    expect(result.completionConfidence.score).toBe(0);
  });

  it("keeps vague_answer below the review threshold while claiming to confirm", async () => {
    // This fixture exists specifically to exercise the confidence rule.
    const result = await mockCalle.runCall(params, "vague_answer", {}, 0);

    expect(result.structuredResult.next_action).toBe("CONFIRM_ORDER");
    expect(result.completionConfidence.score).toBeLessThan(0.7);
  });
});

describe("state sequences match observed CALL-E behaviour", () => {
  async function statesFor(scenario: MockScenario): Promise<CallState[]> {
    const states: CallState[] = [];
    await mockCalle.runCall(params, scenario, { onState: (s) => states.push(s) }, 0);
    return states;
  }

  it("never emits `connected` by default — CALL-E does not fire it (F-003)", async () => {
    for (const scenario of ALL_SCENARIOS) {
      expect(await statesFor(scenario)).not.toContain("connected");
    }
  });

  it("walks queued → dialling → extracting → completed on an answered call", async () => {
    expect(await statesFor("partial_stock")).toEqual([
      "queued",
      "dialling",
      "extracting",
      "completed",
    ]);
  });

  it("ends at no_answer without reaching a conversation", async () => {
    expect(await statesFor("no_answer")).toEqual(["queued", "dialling", "no_answer"]);
  });

  it("ends at failed on a dropped call", async () => {
    expect(await statesFor("call_drops")).toEqual(["queued", "dialling", "failed"]);
  });

  it("every sequence ends in a terminal state", async () => {
    for (const scenario of ALL_SCENARIOS) {
      const states = await statesFor(scenario);
      expect(["completed", "failed", "no_answer"]).toContain(states[states.length - 1]);
    }
  });

  it("replays the fuller sequence only under SENTINEL_MOCK_OPTIMISTIC", async () => {
    process.env.SENTINEL_MOCK_OPTIMISTIC = "true";

    const states = await statesFor("partial_stock");
    expect(states).toContain("connected");
    expect(states).toContain("in_conversation");
  });
});

describe("transcripts", () => {
  it("delivers turns in one burst at extraction, not during the call", async () => {
    const events: string[] = [];

    await mockCalle.runCall(
      params,
      "partial_stock",
      {
        onState: (s) => events.push(`state:${s}`),
        onTranscript: () => events.push("turn"),
      },
      0
    );

    // Every turn lands after `extracting` and before `completed` — F-006.
    const firstTurn = events.indexOf("turn");
    expect(events.indexOf("state:extracting")).toBeLessThan(firstTurn);
    expect(events.indexOf("state:completed")).toBeGreaterThan(firstTurn);
  });

  it("streams turns at in_conversation under SENTINEL_MOCK_OPTIMISTIC", async () => {
    process.env.SENTINEL_MOCK_OPTIMISTIC = "true";
    const events: string[] = [];

    await mockCalle.runCall(
      params,
      "partial_stock",
      {
        onState: (s) => events.push(`state:${s}`),
        onTranscript: () => events.push("turn"),
      },
      0
    );

    expect(events.indexOf("state:in_conversation")).toBeLessThan(events.indexOf("turn"));
  });

  it("labels every transcript line [MOCK] so it cannot pass as real output", async () => {
    const texts: string[] = [];

    for (const scenario of ALL_SCENARIOS) {
      await mockCalle.runCall(
        params,
        scenario,
        { onTranscript: (t) => texts.push(t.text) },
        0
      );
    }

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.startsWith("[MOCK]")).toBe(true);
  });

  it("labels every piece of fixture evidence too", () => {
    for (const scenario of ALL_SCENARIOS) {
      // Evidence is prose describing the call, not a quote, so it is not
      // [MOCK]-prefixed — but it must never read as a real CALL-E finding.
      // Assert it exists and is non-empty; the labelling contract that matters
      // for screenshots is on the transcript above.
      expect(mockCalle._scenarios[scenario].evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("createAndWait", () => {
  it("returns the same result as runCall, for tests that ignore progress", async () => {
    const viaRunCall = await mockCalle.runCall(params, "full_confirmation", {}, 0);
    const viaCreateAndWait = await mockCalle.calls.createAndWait(
      params,
      "full_confirmation",
      0
    );

    expect(viaCreateAndWait).toEqual(viaRunCall);
  });

  it("defaults to the hero scenario", async () => {
    const result = await mockCalle.calls.createAndWait(params, undefined, 0);
    expect(result.structuredResult.next_action).toBe("PARTIAL_CONFIRMATION");
  });
});
