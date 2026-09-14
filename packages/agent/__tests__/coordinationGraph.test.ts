/**
 * packages/agent/__tests__/coordinationGraph.test.ts
 *
 * End-to-end graph behaviour for the wholesale coordination agent, driven by a
 * fake CALL-E layer so no credits are spent.
 *
 * The point of these tests is the safety layer: the kill switch and the call
 * cap are promises made in SAFETY.md, and a promise that is not tested is a
 * promise that quietly stops being true.
 */

import { buildCoordinationGraph, type CoordinationDependencies } from "../coordinationGraph";
import { createInitialCoordinationState } from "../coordinationState";
import type { Order, Contact } from "../../types/wholesale";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORDER: Order = {
  id: "CR-2001",
  reference: "ORD-900",
  traceId: "tr_graph01",
  buyer: { id: "org_buyer", name: "Northgate Distributors", role: "DISTRIBUTOR" },
  seller: { id: "org_seller", name: "Metro Supply Co.", role: "WHOLESALER" },
  item: {
    sku: "SKU-COLD-200",
    description: "Chilled transport crates",
    unit: "units",
    requestedQuantity: 200,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: 450,
    currency: "INR",
  },
  status: "AWAITING_CONFIRMATION",
  urgency: "PRIORITY",
  requiredBy: "2026-09-16T10:00:00.000Z",
  trigger: { type: "ORDER", summary: "Reorder point", receivedAt: "2026-09-14T06:00:00.000Z" },
  createdAt: "2026-09-14T06:00:00.000Z",
  closedAt: null,
  currentRung: 1,
  maxRungs: 3,
  outcome: null,
  operatorMinutesSaved: null,
  scenarioId: "agent",
};

/** Always-available contacts, so availability never masks the thing under test. */
function contact(id: string, priority: number): Contact {
  return {
    id,
    organizationId: "org_seller",
    name: `Contact ${id}`,
    role: "Sales desk",
    phoneE164: "+919876543210",
    productCategories: [],
    region: "North",
    workingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    escalationPriority: priority,
    preferredLanguage: "en-IN",
    consentAt: "2026-09-01T00:00:00.000Z",
    cooldownUntil: null,
  };
}

const DIRECTORY = [contact("c1", 1), contact("c2", 2), contact("c3", 3)];

/** Records what the graph did, so assertions read as behaviour not plumbing. */
interface Recorder {
  dialled: number;
  events: { node: string; decision: string }[];
  outcome: string | null;
}

function makeDeps(
  recorder: Recorder,
  overrides: Partial<CoordinationDependencies> = {},
): CoordinationDependencies {
  return {
    getDirectory: async () => DIRECTORY,

    // Stands in for the CALL-E layer. Counting here is how we prove the agent
    // did or did not reach the dial.
    persistCall: async ({ rung }) => {
      recorder.dialled += 1;
      return { callId: `call_${rung}` };
    },

    onConfirmed: async () => void (recorder.outcome = "CONFIRMED"),
    onPartial: async () => void (recorder.outcome = "PARTIALLY_CONFIRMED"),
    onApprovalRequired: async () => void (recorder.outcome = "APPROVAL_REQUIRED"),
    onCallbackScheduled: async () => void (recorder.outcome = "CALLBACK_SCHEDULED"),
    onHumanReview: async () => void (recorder.outcome = "HUMAN_REVIEW"),
    onUnresolved: async () => void (recorder.outcome = "UNRESOLVED"),

    emitAgentEvent: ({ node, decision }) => {
      recorder.events.push({ node, decision });
    },

    orderOpenedAt: new Date(ORDER.createdAt),
    useMock: true,
    ...overrides,
  };
}

function newRecorder(): Recorder {
  return { dialled: 0, events: [], outcome: null };
}

// ── Kill switch (FR-10.5 / SAFETY.md) ────────────────────────────────────────

describe("coordination graph — the kill switch", () => {
  it("refuses to dial when the switch is engaged", async () => {
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(
      makeDeps(recorder, { isKillSwitchActive: async () => true }),
    );

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBe(0);
    expect(recorder.events).toContainEqual({
      node: "execute_call",
      decision: "kill_switch_active",
    });
  });

  it("dials normally when the switch is released", async () => {
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(
      makeDeps(recorder, { isKillSwitchActive: async () => false }),
    );

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBeGreaterThan(0);
  });

  it("fails CLOSED when no kill switch was wired in at all", async () => {
    // A missing check is a broken check. The agent must not treat "nobody told
    // me" as permission to call people.
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(makeDeps(recorder));

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBe(0);
  });

  it("fails CLOSED when the kill switch check itself throws", async () => {
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(
      makeDeps(recorder, {
        isKillSwitchActive: async () => {
          throw new Error("redis down");
        },
      }),
    );

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBe(0);
  });
});

// ── Call cap (FR-7.3) ────────────────────────────────────────────────────────

describe("coordination graph — the call cap", () => {
  it("never places more calls than the cap allows", async () => {
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(
      makeDeps(recorder, {
        isKillSwitchActive: async () => false,
        maxCallsPerOrder: 2,
      }),
    );

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBeLessThanOrEqual(2);
  });
});

// ── Ladder (FR-4.1) ──────────────────────────────────────────────────────────

describe("coordination graph — the contact ladder", () => {
  it("terminates rather than looping when the seller has no contacts on file", async () => {
    // An empty directory is a data problem, not a refusal — it goes to a
    // person, and above all the graph must stop rather than spin.
    const recorder = newRecorder();
    const graph = buildCoordinationGraph(
      makeDeps(recorder, {
        isKillSwitchActive: async () => false,
        getDirectory: async () => [],
      }),
    );

    const final = await graph.invoke(createInitialCoordinationState(ORDER));

    expect(recorder.dialled).toBe(0);
    expect(final.finalOutcome).toBe("HUMAN_REVIEW");
    expect(recorder.events).toContainEqual({
      node: "select_contact",
      decision: "none_at_seller",
    });
  });

  it("marks the order UNRESOLVED once every contact has been called and none committed", async () => {
    // The genuine exhausted ladder: real calls happened, nobody committed.
    const recorder = newRecorder();
    process.env.SENTINEL_MOCK_SCENARIO = "no_answer";
    process.env.SENTINEL_MOCK_DELAY_MS = "0";

    try {
      const graph = buildCoordinationGraph(
        makeDeps(recorder, { isKillSwitchActive: async () => false }),
      );

      const final = await graph.invoke(createInitialCoordinationState(ORDER));

      expect(recorder.dialled).toBe(3);
      expect(final.finalOutcome).toBe("UNRESOLVED");
    } finally {
      delete process.env.SENTINEL_MOCK_SCENARIO;
      delete process.env.SENTINEL_MOCK_DELAY_MS;
    }
  });

  it("parks an off-hours order for a person instead of claiming the ladder was exhausted", async () => {
    // Everyone is asleep. Climbing the rungs would hit the same wall three
    // times and then report UNRESOLVED, which describes the wrong problem:
    // nobody refused, the working day simply has not started.
    const recorder = newRecorder();
    const asleep = DIRECTORY.map((c) => ({
      ...c,
      workingHours: { start: "09:00", end: "17:00", timezone: "UTC" },
    }));

    const graph = buildCoordinationGraph(
      makeDeps(recorder, {
        isKillSwitchActive: async () => false,
        getDirectory: async () => asleep,
      }),
    );

    // 03:00 UTC — outside every contact's window.
    jest.useFakeTimers().setSystemTime(new Date("2026-09-14T03:00:00.000Z"));
    try {
      const final = await graph.invoke(createInitialCoordinationState(ORDER));

      expect(recorder.dialled).toBe(0);
      expect(final.finalOutcome).toBe("HUMAN_REVIEW");
      expect(recorder.events).toContainEqual({
        node: "select_contact",
        decision: "outside_working_hours",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("never dials the same contact twice for one order", async () => {
    const recorder = newRecorder();
    const dialledContacts: string[] = [];

    const graph = buildCoordinationGraph(
      makeDeps(recorder, {
        isKillSwitchActive: async () => false,
        persistCall: async ({ contactId, rung }) => {
          dialledContacts.push(contactId);
          return { callId: `call_${rung}` };
        },
      }),
    );

    await graph.invoke(createInitialCoordinationState(ORDER));

    expect(new Set(dialledContacts).size).toBe(dialledContacts.length);
  });
});
