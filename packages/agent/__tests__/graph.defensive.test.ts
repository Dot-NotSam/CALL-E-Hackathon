/**
 * packages/agent/__tests__/graph.defensive.test.ts
 *
 * The graph with only its REQUIRED dependencies wired.
 *
 * Every SSE emitter except `emitAgentEvent` is optional, because the backend
 * wires them incrementally and a half-built dashboard must not be able to take
 * an order down. This file runs the full graph with all of them omitted and
 * asserts the coordination still completes correctly.
 *
 * It also covers the callback-time helpers' failure paths, which fire on
 * malformed contact data rather than on anything the model returns.
 */

import { runCoordinationAgent } from "../index";
import type { AgentDependencies } from "../graph";
import { resolveCallbackTime } from "../nodes/scheduleCallback";
import { makeContext, makeContact, LADDER } from "./fixtures";
import type { MockScenario } from "../../calle/mock";
import { CallTimeoutError } from "../../calle/progress";
import type { FollowUp, OrderOutcome } from "../../types";

/** The bare minimum a backend must supply. Nothing optional. */
function minimalDeps(scenario: MockScenario): {
  deps: AgentDependencies;
  orders: OrderOutcome[];
  followUps: FollowUp[];
  alerts: string[];
} {
  process.env.SENTINEL_MOCK_SCENARIO = scenario;
  process.env.SENTINEL_MOCK_DELAY_MS = "0";

  const orders: OrderOutcome[] = [];
  const followUps: FollowUp[] = [];
  const alerts: string[] = [];

  const deps: AgentDependencies = {
    getContacts: async () => LADDER,
    useMock: true,
    isKillSwitchActive: async () => false,
    persistCall: async () => ({ callId: "call-1" }),

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

    // Required emitters only.
    emitAgentEvent: () => {},
    emitSSEOrderSuppressed: () => {},
    emitSSEContactSelected: () => {},
    emitSSEPlanComposed: () => {},

    // emitSSECallState, emitSSETranscriptDelta, emitSSEResultExtracted and
    // emitSSEOrderEscalated are all deliberately OMITTED.
    // getOpenOrders and requiredCategory are omitted too.
  };

  return { deps, orders, followUps, alerts };
}

afterEach(() => {
  delete process.env.SENTINEL_MOCK_SCENARIO;
  delete process.env.SENTINEL_MOCK_DELAY_MS;
});

describe("the graph with no optional emitters wired", () => {
  it("completes the hero path", async () => {
    const { deps, orders, followUps } = minimalDeps("partial_stock");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("PARTIALLY_CONFIRMED");
    expect(orders).toHaveLength(1);
    expect(followUps).toHaveLength(2);
  });

  it("walks the whole ladder without an escalation emitter", async () => {
    const { deps, alerts } = minimalDeps("no_answer");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.callHistory).toHaveLength(3);
    expect(alerts).toHaveLength(1);
  });

  it("stops on a price change without a result emitter", async () => {
    const { deps, orders } = minimalDeps("price_change");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("APPROVAL_REQUIRED");
    expect(orders[0].unitPrice).toBeNull();
  });

  it("parks a vague answer", async () => {
    const { deps } = minimalDeps("vague_answer");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("HUMAN_REVIEW");
  });

  it("schedules a callback", async () => {
    const { deps, followUps } = minimalDeps("callback_requested");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("CALLBACK_SCHEDULED");
    expect(followUps[0].kind).toBe("CALLBACK");
  });

  it("runs without getOpenOrders — duplicate detection just finds nothing", async () => {
    const { deps } = minimalDeps("partial_stock");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.suppressReason).toBeNull();
    expect(final.callHistory).toHaveLength(1);
  });

  it("runs without requiredCategory — the category filter is skipped", async () => {
    const { deps } = minimalDeps("full_confirmation");
    const final = await runCoordinationAgent(makeContext(), deps);

    expect(final.finalOutcome?.status).toBe("CONFIRMED");
  });
});

describe("execute_call surfaces an SDK failure as an escalation, not a stop", () => {
  it("escalates after retries are exhausted", async () => {
    const { deps, alerts } = minimalDeps("partial_stock");

    // persistCall runs after every successful call; throwing from it is the
    // cleanest way to make execute_call fail without touching the driver.
    const failing: AgentDependencies = {
      ...deps,
      persistCall: async () => {
        throw new Error("database unreachable");
      },
    };

    const final = await runCoordinationAgent(makeContext(), failing);

    // An SDK/persistence FAILURE escalates (unlike a kill switch, which stops).
    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.attemptedContacts.length).toBeGreaterThan(0);
    expect(alerts).toHaveLength(1);
  }, 30_000);

  it("does NOT escalate when the account is out of balance", async () => {
    // OBSERVED 2026-09-14: a real run returned "Insufficient CALL-E balance"
    // and the agent escalated. Nothing about the next contact is different —
    // the account is out of money for all of them — so on a three-rung ladder
    // this produced three identical failures and an "escalation exhausted
    // after 3 contacts" alert, which reads as a supplier problem.
    const { deps, alerts } = minimalDeps("partial_stock");

    const broke: AgentDependencies = {
      ...deps,
      persistCall: async () => {
        throw new Error(
          "Insufficient CALL-E balance. Please top up at " +
          "https://dashboard.heycall-e.com/account/billing and try again."
        );
      },
    };

    const final = await runCoordinationAgent(makeContext(), broke, 3);

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    expect(final.attemptedContacts).toHaveLength(0);
    expect(final.rung).toBe(1);
    expect(alerts).toHaveLength(1);
  }, 30_000);

  it("does NOT escalate a poll timeout — that call may still be live", async () => {
    // OBSERVED twice (2026-09-13, 2026-09-14): we stopped polling at our
    // ceiling and CALL-E completed the call anyway, 40 and 44 turns, with
    // valid results. There is no cancel API. So at the moment the ladder would
    // advance, the first contact may be mid-sentence agreeing to the order —
    // and rung 2 would ring a second person about the same one.
    //
    // The error is injected at persistCall because that is the seam this file
    // already uses; what is under test is how `decide` ROUTES a timeout, not
    // where the timeout is raised.
    const { deps, alerts } = minimalDeps("partial_stock");

    const timingOut: AgentDependencies = {
      ...deps,
      persistCall: async () => {
        throw new CallTimeoutError("call_pTAB-O4ueJdAITNenOEA5Q", 600_000);
      },
    };

    const final = await runCoordinationAgent(makeContext(), timingOut);

    expect(final.finalOutcome?.status).toBe("UNRESOLVED");
    // The discriminator: `escalate` is what appends to attemptedContacts, so
    // an empty list means the ladder stopped instead of walking to the next
    // contact. Contrast the SDK-failure test above, which expects > 0.
    expect(final.attemptedContacts).toHaveLength(0);
    expect(alerts).toHaveLength(1);
  }, 30_000);
});

describe("resolveCallbackTime — malformed contact data", () => {
  const at = "2026-09-13T17:00:00.000Z";
  const now = new Date("2026-09-13T06:00:00.000Z");

  it("uses the requested time when there is no contact to check hours against", () => {
    expect(resolveCallbackTime(at, null, now)).toEqual({
      callbackAt: at,
      adjusted: false,
    });
  });

  it("does not shift the time when the timezone is unusable", () => {
    const broken = makeContact({
      workingHours: { start: "09:00", end: "18:00", timezone: "Mars/Olympus_Mons" },
    });

    expect(resolveCallbackTime(at, broken, now).adjusted).toBe(false);
  });

  it("does not shift the time when the hours are malformed", () => {
    const broken = makeContact({
      workingHours: { start: "9am", end: "6pm", timezone: "Asia/Kolkata" },
    });

    expect(resolveCallbackTime(at, broken, now).adjusted).toBe(false);
  });

  it("moves a pre-opening request forward to the same day's opening", () => {
    const contact = makeContact({
      workingHours: { start: "09:00", end: "18:00", timezone: "Asia/Kolkata" },
    });

    // 02:00 UTC = 07:30 IST, before a 09:00 opening.
    const resolved = resolveCallbackTime("2026-09-14T02:00:00.000Z", contact, now);

    expect(resolved.adjusted).toBe(true);
    expect(new Date(resolved.callbackAt).getTime()).toBeGreaterThan(
      new Date("2026-09-14T02:00:00.000Z").getTime()
    );
  });

  it("handles a contact whose working window crosses midnight", () => {
    const nightShift = makeContact({
      workingHours: { start: "22:00", end: "06:00", timezone: "Asia/Kolkata" },
    });

    // 19:00 UTC = 00:30 IST — inside a 22:00–06:00 window.
    const resolved = resolveCallbackTime("2026-09-13T19:00:00.000Z", nightShift, now);

    expect(resolved.adjusted).toBe(false);
  });
});
