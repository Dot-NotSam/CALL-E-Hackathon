/**
 * packages/agent/__tests__/graph.integration.test.ts
 *
 * End-to-end runs through the compiled LangGraph, driven by the mock CALL-E
 * driver. These assert the paths a judge actually sees: the hero partial
 * confirmation, the escalation ladder, the price-approval stop, and the safety
 * controls that must hold regardless of what the model returns.
 *
 * ⚠️  Every call here is the MOCK driver (Rule 8, FR-4.5). No credit is spent
 * and no phone rings.
 */

import { runCoordinationAgent } from "../index";
import type { AgentDependencies } from "../graph";
import type {
  Contact,
  FollowUp,
  OrderOutcome,
  SentinelEvent,
  WholesaleResult,
  Confidence,
} from "../../types";
import type { MockScenario } from "../../calle/mock";
import { makeContext, LADDER, PRIMARY } from "./fixtures";

/** Captures everything the agent emitted, so a test can assert on the story. */
interface Harness {
  deps: AgentDependencies;
  events: { node: string; decision: string; reason: string }[];
  sse: SentinelEvent[];
  orders: OrderOutcome[];
  followUps: FollowUp[];
  callStates: string[];
  transcript: { speaker: string; text: string }[];
  prompts: string[];
  approvals: { previousUnitPrice: number; proposedUnitPrice: number }[];
  alerts: string[];
}

function harness(
  scenario: MockScenario,
  overrides: Partial<AgentDependencies> = {},
  roster: Contact[] = LADDER
): Harness {
  const events: Harness["events"] = [];
  const sse: SentinelEvent[] = [];
  const orders: OrderOutcome[] = [];
  const followUps: FollowUp[] = [];
  const callStates: string[] = [];
  const transcript: Harness["transcript"] = [];
  const prompts: string[] = [];
  const approvals: Harness["approvals"] = [];
  const alerts: string[] = [];

  process.env.SENTINEL_MOCK_SCENARIO = scenario;
  process.env.SENTINEL_MOCK_DELAY_MS = "0";

  const deps: AgentDependencies = {
    getContacts: async () => roster,
    getOpenOrders: async () => [],
    requiredCategory: "medical-supplies",

    useMock: true,
    isKillSwitchActive: async () => false,

    persistCall: async ({ taskPrompt }) => {
      prompts.push(taskPrompt);
      return { callId: `call-${prompts.length}` };
    },

    confirmCallbacks: {
      updateOrder: async (o) => void orders.push(o),
      scheduleFollowUp: async (f) => void followUps.push(f),
    },
    approvalCallbacks: {
      requestApproval: async ({ approval }) => void approvals.push(approval),
      updateOrder: async (o) => void orders.push(o),
    },
    scheduleCallbackCallbacks: {
      scheduleCallbackJob: async () => {},
      scheduleFollowUp: async (f) => void followUps.push(f),
      updateOrder: async (o) => void orders.push(o),
    },
    humanReviewCallbacks: {
      parkOrder: async () => {},
      updateOrder: async (o) => void orders.push(o),
    },
    unresolvedCallbacks: {
      updateOrder: async (o) => void orders.push(o),
      alertOperations: async ({ reason }) => void alerts.push(reason),
    },

    emitAgentEvent: (e) => void events.push(e),
    emitSSEOrderSuppressed: (p) => void sse.push({ type: "order.suppressed", ...p }),
    emitSSEContactSelected: (p) => void sse.push({ type: "contact.selected", ...p }),
    emitSSEPlanComposed: (p) => void sse.push({ type: "plan.composed", ...p }),
    emitSSECallState: ({ state }) => void callStates.push(state),
    emitSSETranscriptDelta: ({ speaker, text }) => void transcript.push({ speaker, text }),
    emitSSEResultExtracted: (p) =>
      void sse.push({
        type: "result.extracted",
        orderId: p.orderId,
        structured: p.structured,
        confidence: p.confidence,
        evidence: p.evidence,
      }),
    emitSSEOrderEscalated: (p) => void sse.push({ type: "order.escalated", ...p }),

    ...overrides,
  };

  return { deps, events, sse, orders, followUps, callStates, transcript, prompts, approvals, alerts };
}

afterEach(() => {
  delete process.env.SENTINEL_MOCK_SCENARIO;
  delete process.env.SENTINEL_MOCK_DELAY_MS;
});

describe("the hero path — partial stock (PRD §4.1)", () => {
  it("confirms 120 now and 80 to follow, then schedules both follow-ups", async () => {
    const h = harness("partial_stock");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome).toMatchObject({
      status: "PARTIALLY_CONFIRMED",
      committed: true,
      confirmedQuantity: 120,
      remainingQuantity: 80,
    });

    expect(h.followUps.map((f) => f.kind).sort()).toEqual([
      "REMAINING_QUANTITY",
      "VERIFICATION",
    ]);
  });

  it("walks the expected node sequence", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.events.map((e) => e.node)).toEqual([
      "assess_order",
      "select_contact",
      "plan_call",
      "execute_call",
      "decide",
      "confirm",
    ]);
  });

  it("shows the plan BEFORE the phone rings (FR-4.1)", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    const planIndex = h.events.findIndex((e) => e.node === "plan_call");
    const callIndex = h.events.findIndex((e) => e.node === "execute_call");

    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(callIndex);
  });

  it("emits the typed extraction with confidence and evidence (FR-4.4)", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    const extracted = h.sse.find((e) => e.type === "result.extracted");
    expect(extracted).toBeDefined();
    expect((extracted as { structured: WholesaleResult }).structured.confirmed_quantity).toBe(120);
    expect((extracted as { evidence: string[] }).evidence.length).toBeGreaterThan(0);
  });

  it("carries the same trace_id across every call record (Rule 7)", async () => {
    const h = harness("partial_stock");
    const ctx = makeContext();
    const final = await runCoordinationAgent(ctx, h.deps);

    for (const call of final.callHistory) {
      expect(call.traceId).toBe(ctx.traceId);
    }
  });

  it("composes a prompt carrying the real order, not a template", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts[0]).toContain("ORD-482");
    expect(h.prompts[0]).toContain("200 cases");
    expect(h.prompts[0]).toContain("Metro Supply Co.");
    expect(h.prompts[0]).toContain("automated operations line");
  });
});

describe("the escalation ladder", () => {
  it("walks all three rungs on repeated no-answers, then gives up loudly", async () => {
    const h = harness("no_answer");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.attemptedContacts).toEqual([PRIMARY.id, LADDER[1].id, LADDER[2].id]);
    expect(h.alerts).toHaveLength(1);
  });

  it("places exactly one call per rung", async () => {
    const h = harness("no_answer");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.callHistory).toHaveLength(3);
    expect(h.prompts).toHaveLength(3);
  });

  it("escalates at zero confidence — nobody spoke, so there is nothing to review", async () => {
    const h = harness("no_answer");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.confidenceHistory.every((c: Confidence) => c.score === 0)).toBe(true);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.requiresHumanReview).toBe(false);
  });

  it("emits an escalation event per advance, with a reason", async () => {
    const h = harness("no_answer");
    await runCoordinationAgent(makeContext(), h.deps);

    const escalations = h.sse.filter((e) => e.type === "order.escalated");
    expect(escalations).toHaveLength(2); // 1→2 and 2→3
    expect((escalations[0] as { reason: string }).reason).toMatch(/did not answer/);
  });

  it("gives each rung a differently framed prompt — a backup is not a repeat", async () => {
    const h = harness("no_answer");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts[0]).toContain("first call about this order");
    expect(h.prompts[1]).toContain("backup contact");
    expect(h.prompts[2]).toContain("supervisor-level call");
  });

  it("stops at the rung cap even with more contacts available", async () => {
    const extra = [...LADDER, { ...PRIMARY, id: "ct-fourth", escalationPriority: 4 }];
    const h = harness("no_answer", {}, extra);
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.callHistory).toHaveLength(3);
    expect(final.rung).toBe(3);
  });
});

describe("the price-approval stop (FR-5.3)", () => {
  it("parks the order and never applies the quoted price", async () => {
    const h = harness("price_change");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome?.status).toBe("APPROVAL_REQUIRED");
    expect(final.finalOutcome?.unitPrice).toBeNull();
    expect(h.approvals[0]).toMatchObject({
      previousUnitPrice: 1850,
      proposedUnitPrice: 2050,
    });
  });

  it("schedules no follow-ups — nothing was agreed yet", async () => {
    const h = harness("price_change");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.followUps).toHaveLength(0);
  });
});

describe("low confidence (FR-5.6, PRD §6)", () => {
  it("routes a vague answer to review even though next_action said CONFIRM_ORDER", async () => {
    const h = harness("vague_answer");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.structuredResults[0]?.next_action).toBe("CONFIRM_ORDER");
    expect(final.finalOutcome?.status).toBe("HUMAN_REVIEW");
  });

  it("writes NO quantities to the order", async () => {
    const h = harness("vague_answer");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome?.confirmedQuantity).toBeNull();
    expect(final.finalOutcome?.remainingQuantity).toBeNull();
  });
});

describe("callback", () => {
  it("parks the order and schedules the retry", async () => {
    const h = harness("callback_requested");
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome?.status).toBe("CALLBACK_SCHEDULED");
    expect(h.followUps[0].kind).toBe("CALLBACK");
  });
});

describe("duplicate suppression (FR-2.3)", () => {
  it("suppresses before any contact is selected, so no credit is spent", async () => {
    const h = harness("partial_stock", {
      getOpenOrders: async () => [
        {
          id: "CR-1001",
          reference: "ORD-479",
          sellerId: "org-metro-supply",
          sku: "MED-TS-CASE",
          status: "PARTIALLY_CONFIRMED",
          createdAt: "2026-09-13T04:02:00.000Z",
        },
      ],
    });

    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.suppressReason).toMatch(/ORD-479/);
    expect(final.callHistory).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    expect(h.events.map((e) => e.node)).toEqual(["assess_order"]);
  });
});

describe("safety controls", () => {
  it("fails closed when no kill switch check is wired in", async () => {
    const h = harness("partial_stock", { isKillSwitchActive: undefined });
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.callError).toMatch(/fail-closed/);
  });

  it("fails closed when the kill switch check itself throws", async () => {
    const h = harness("partial_stock", {
      isKillSwitchActive: async () => {
        throw new Error("database unreachable");
      },
    });

    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });

  it("does not dial when the kill switch is engaged", async () => {
    const h = harness("partial_stock", { isKillSwitchActive: async () => true });
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });

  it("does NOT escalate past the kill switch — that would be a bypass", async () => {
    const h = harness("no_answer", { isKillSwitchActive: async () => true });
    const final = await runCoordinationAgent(makeContext(), h.deps);

    // One blocked attempt, not three. The ladder must not walk past a
    // deliberate stop looking for someone else to ring.
    expect(final.attemptedContacts).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it("enforces the call cap independently of the rung cap", async () => {
    const h = harness("no_answer", { maxCallsPerOrder: 2 });
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.callHistory).toHaveLength(2);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });

  it("never calls a contact without recorded consent", async () => {
    const unconsented = LADDER.map((c) => ({ ...c, consentAt: "" }));
    const h = harness("partial_stock", {}, unconsented);
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });

  it("gives up rather than calling an empty roster", async () => {
    const h = harness("partial_stock", {}, []);
    const final = await runCoordinationAgent(makeContext(), h.deps);

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(h.alerts).toHaveLength(1);
  });
});

describe("call progress (FR-4.3)", () => {
  it("streams the state sequence CALL-E actually produces", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    // `connected` never fires and turns arrive at `extracting` — observed
    // behaviour, not a simplification. See docs/CALLE_TESTING_LOG.md F-003/F-006.
    expect(h.callStates).toEqual(["queued", "dialling", "extracting", "completed"]);
    expect(h.callStates).not.toContain("connected");
  });

  it("streams transcript turns", async () => {
    const h = harness("partial_stock");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.transcript.length).toBeGreaterThan(0);
    expect(h.transcript[0].speaker).toBe("AGENT");
    // Every mock turn is labelled, so it can never pass as a real transcript.
    expect(h.transcript.every((t) => t.text.startsWith("[MOCK]"))).toBe(true);
  });

  it("ends on no_answer without ever reaching a conversation state", async () => {
    const h = harness("no_answer");
    await runCoordinationAgent(makeContext(), h.deps);

    expect(h.callStates.slice(0, 3)).toEqual(["queued", "dialling", "no_answer"]);
  });
});
