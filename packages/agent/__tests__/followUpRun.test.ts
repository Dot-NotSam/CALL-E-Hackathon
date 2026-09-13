/**
 * packages/agent/__tests__/followUpRun.test.ts
 *
 * The follow-up run: the same graph, on the same order, carrying the same
 * trace_id — entering at plan_call instead of assess_order (FR-5.4, PRD §10.1).
 *
 * This is what closes the loop twice. A supplier saying "yes, today" and then
 * not dispatching is the most expensive outcome for the buyer because it is
 * discovered late, and the verification call is the only thing that catches it.
 */

import { runFollowUpCall } from "../index";
import type { AgentDependencies } from "../graph";
import type { FollowUp, OrderOutcome } from "../../types";
import type { MockScenario } from "../../calle/mock";
import { makeContext, PRIMARY, BACKUP, SUPERVISOR, LADDER, ITEM } from "./fixtures";

interface Harness {
  deps: AgentDependencies;
  events: { node: string; decision: string; reason: string }[];
  orders: OrderOutcome[];
  followUps: FollowUp[];
  completed: string[];
  prompts: string[];
  plans: { summary: string; mustAsk: string[] }[];
  contactsSelected: string[];
  alerts: string[];
}

function harness(scenario: MockScenario, overrides: Partial<AgentDependencies> = {}): Harness {
  process.env.SENTINEL_MOCK_SCENARIO = scenario;
  process.env.SENTINEL_MOCK_DELAY_MS = "0";

  const events: Harness["events"] = [];
  const orders: OrderOutcome[] = [];
  const followUps: FollowUp[] = [];
  const completed: string[] = [];
  const prompts: string[] = [];
  const plans: Harness["plans"] = [];
  const contactsSelected: string[] = [];
  const alerts: string[] = [];

  const deps: AgentDependencies = {
    getContacts: async () => LADDER,
    getOpenOrders: async () => [],
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
      requestApproval: async () => {},
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
    verifyCallbacks: {
      updateOrder: async (o) => void orders.push(o),
      scheduleFollowUp: async (f) => void followUps.push(f),
      completeFollowUp: async (id) => void completed.push(id),
    },

    emitAgentEvent: (e) => void events.push(e),
    emitSSEOrderSuppressed: () => {},
    emitSSEContactSelected: ({ contact }) => void contactsSelected.push(contact.id),
    emitSSEPlanComposed: ({ summary, mustAsk }) => void plans.push({ summary, mustAsk }),

    ...overrides,
  };

  return { deps, events, orders, followUps, completed, prompts, plans, contactsSelected, alerts };
}

/** An order that was partially confirmed: 120 secured, 80 outstanding. */
function partiallyConfirmedContext() {
  return makeContext({
    item: { ...ITEM, confirmedQuantity: 120, remainingQuantity: 80 },
  });
}

const VERIFICATION = { id: "CR-1007-verification", kind: "VERIFICATION" as const };
const REMAINDER = { id: "CR-1007-remaining", kind: "REMAINING_QUANTITY" as const };

afterEach(() => {
  delete process.env.SENTINEL_MOCK_SCENARIO;
  delete process.env.SENTINEL_MOCK_DELAY_MS;
});

describe("a follow-up run skips assessment and contact selection", () => {
  it("enters at plan_call — the order was already assessed", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.events.map((e) => e.node)).toEqual([
      "plan_call",
      "execute_call",
      "decide",
      "verify",
    ]);
    expect(h.events.map((e) => e.node)).not.toContain("assess_order");
    expect(h.events.map((e) => e.node)).not.toContain("select_contact");
  });

  it("calls the contact who committed, not whoever the ladder would pick", async () => {
    const h = harness("full_confirmation");

    // SUPERVISOR is rung 3 — a fresh coordination run would never pick them
    // first. A follow-up must, because they are who made the promise.
    const final = await runFollowUpCall(makeContext(), SUPERVISOR, VERIFICATION, h.deps);

    expect(final.currentContact?.id).toBe(SUPERVISOR.id);
    expect(h.contactsSelected).toHaveLength(0); // no selection happened at all
  });

  it("carries the original trace_id so it lands on the same stream", async () => {
    const h = harness("full_confirmation");
    const ctx = makeContext();

    const final = await runFollowUpCall(ctx, PRIMARY, VERIFICATION, h.deps);

    expect(final.traceId).toBe(ctx.traceId);
    expect(final.callHistory[0].traceId).toBe(ctx.traceId);
    expect(h.events.every((e) => e.reason !== undefined)).toBe(true);
  });
});

describe("the follow-up uses the short prompt, not a re-briefing", () => {
  it("verification asks whether it dispatched", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.prompts[0]).toMatch(/Has the order dispatched\?/);
    expect(h.prompts[0]).toMatch(/under 45 seconds/);
    // Not the coordination prompt.
    expect(h.prompts[0]).not.toMatch(/MUST ASK \(in this order\)/);
  });

  it("a remainder chase names the outstanding quantity", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, REMAINDER, h.deps);

    expect(h.prompts[0]).toContain("80 cases");
    expect(h.prompts[0]).toMatch(/Do not re-brief/);
  });

  it("keeps the safety clauses", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.prompts[0]).toMatch(/automated operations line/);
    expect(h.prompts[0]).toMatch(/Never disclose order details to anyone who is not/);
    expect(h.prompts[0]).toMatch(/Never agree to a price/);
  });

  it("shows the operator a follow-up plan, not a coordination plan (FR-4.1)", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, REMAINDER, h.deps);

    expect(h.plans[0].summary).toMatch(/Follow-up: chase/);
    expect(h.plans[0].summary).toContain("80 cases");
    expect(h.plans[0].mustAsk.join(" ")).toMatch(/available now/);
  });

  it("labels a verification plan as a verification", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.plans[0].summary).toMatch(/Follow-up: verify/);
    expect(h.plans[0].mustAsk[0]).toMatch(/Has the order dispatched/);
  });
});

describe("the commitment held", () => {
  it("records the verified outcome and ends", async () => {
    const h = harness("full_confirmation");
    const final = await runFollowUpCall(
      partiallyConfirmedContext(),
      PRIMARY,
      VERIFICATION,
      h.deps
    );

    expect(h.orders).toHaveLength(1);
    expect(h.orders[0].committed).toBe(true);
    expect(final.finalOutcome?.summary).toMatch(/confirmed dispatch/);
  });

  it("keeps the quantities from the order — a dispatch check is not a renegotiation", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, VERIFICATION, h.deps);

    // The mock returns confirmed_quantity 200; the order says 120/80. The
    // verification must not quietly rewrite the agreed split.
    expect(h.orders[0].confirmedQuantity).toBe(120);
    expect(h.orders[0].remainingQuantity).toBe(80);
    expect(h.orders[0].status).toBe("PARTIALLY_CONFIRMED");
  });

  it("never schedules another verification — an order must eventually close", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(partiallyConfirmedContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.followUps).toHaveLength(0);
  });

  it("marks the triggering follow-up done so it leaves the panel", async () => {
    const h = harness("full_confirmation");
    await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.completed).toEqual(["CR-1007-verification"]);
  });

  it("closes a fully-confirmed order as CONFIRMED", async () => {
    const h = harness("full_confirmation");
    const ctx = makeContext({
      item: { ...ITEM, confirmedQuantity: 200, remainingQuantity: 0 },
    });

    await runFollowUpCall(ctx, PRIMARY, VERIFICATION, h.deps);

    expect(h.orders[0].status).toBe("CONFIRMED");
  });
});

describe("the commitment did not hold", () => {
  it("escalates when nobody answered the follow-up", async () => {
    const h = harness("no_answer");
    const final = await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    // Escalation re-enters the ladder, so the backup gets tried.
    expect(final.attemptedContacts).toContain(PRIMARY.id);
    expect(h.contactsSelected).toContain(BACKUP.id);
  });

  it("calls the NEXT contact as a fresh coordination call, not a follow-up", async () => {
    // Escalating out of a verification hands the order to someone new. The
    // follow-up prompt opens with "You confirmed 120 cases previously" — said
    // to a person who confirmed nothing, that is simply false, and their
    // answer would have been routed straight back into `verify` for a
    // commitment they never made.
    const h = harness("unavailable");
    const final = await runFollowUpCall(
      partiallyConfirmedContext(),
      PRIMARY,
      VERIFICATION,
      h.deps
    );

    expect(h.contactsSelected).toContain(BACKUP.id);
    expect(h.prompts.length).toBeGreaterThan(1);

    // The first call WAS a follow-up — it went to the contact who committed.
    expect(h.prompts[0]).toMatch(/You confirmed 120 cases/);

    // The second must not tell a new person they committed to anything.
    const second = h.prompts[1];
    expect(second).not.toMatch(/You confirmed/);
    // A coordination prompt, which a follow-up prompt never contains.
    expect(second).toMatch(/MUST ASK \(in this order\)/);
    expect(final.mode).toBe("COORDINATE");
  });

  it("escalates when the supplier cannot say when it will ship", async () => {
    const h = harness("unavailable");
    const final = await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(final.attemptedContacts).toContain(PRIMARY.id);
    expect(
      h.events.find((e) => e.node === "verify")?.decision
    ).toBe("commitment_missed");
  });

  it("ends UNRESOLVED once the ladder is exhausted", async () => {
    const h = harness("no_answer");
    const final = await runFollowUpCall(
      makeContext({ rung: 3 }),
      SUPERVISOR,
      VERIFICATION,
      h.deps
    );

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(h.alerts).toHaveLength(1);
  });
});

describe("verifyCallbacks not wired", () => {
  it("parks for a person rather than silently losing the outcome", async () => {
    const h = harness("full_confirmation", { verifyCallbacks: undefined });
    const final = await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(final.finalOutcome?.status).toBe("HUMAN_REVIEW");
    expect(h.events.find((e) => e.node === "verify")?.decision).toBe("not_wired");
  });
});

describe("safety controls still apply on a follow-up", () => {
  it("does not dial when the kill switch is engaged", async () => {
    const h = harness("full_confirmation", { isKillSwitchActive: async () => true });
    const final = await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });

  it("fails closed when no kill switch check is wired", async () => {
    const h = harness("full_confirmation", { isKillSwitchActive: undefined });
    const final = await runFollowUpCall(makeContext(), PRIMARY, VERIFICATION, h.deps);

    expect(h.prompts).toHaveLength(0);
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
  });
});
