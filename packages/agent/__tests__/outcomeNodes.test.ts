/**
 * packages/agent/__tests__/outcomeNodes.test.ts
 *
 * The nodes that write back to the order: confirm, approval, schedule_callback,
 * human_review, unresolved. What each one commits — and, more importantly, what
 * it refuses to commit.
 */

import { confirm, verificationDueAt, nextBusinessMorning } from "../nodes/confirm";
import { approval } from "../nodes/approval";
import { scheduleCallback, resolveCallbackTime } from "../nodes/scheduleCallback";
import { humanReview } from "../nodes/humanReview";
import { unresolved } from "../nodes/unresolved";
import { escalate } from "../nodes/escalate";
import {
  makeState,
  makeContact,
  withResult,
  RESULTS,
  HIGH,
  LOW,
  PRIMARY,
  BACKUP,
  SUPERVISOR,
} from "./fixtures";
import type { FollowUp, OrderOutcome } from "../../types";

const NOW = new Date("2026-09-13T06:00:00.000Z");

function recorder() {
  const orders: OrderOutcome[] = [];
  const followUps: FollowUp[] = [];

  return {
    orders,
    followUps,
    updateOrder: async (o: OrderOutcome) => void orders.push(o),
    scheduleFollowUp: async (f: FollowUp) => void followUps.push(f),
  };
}

describe("confirm — full confirmation", () => {
  it("writes the confirmed quantity and schedules a verification", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    const updates = await confirm(state, rec, { now: NOW });

    expect(rec.orders[0]).toMatchObject({
      status: "CONFIRMED",
      committed: true,
      confirmedQuantity: 200,
      remainingQuantity: 0,
    });
    expect(rec.followUps.map((f) => f.kind)).toEqual(["VERIFICATION"]);
    expect(updates.finalOutcome?.status).toBe("CONFIRMED");
  });

  it("never writes a price, even when the supplier quoted one", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    await confirm(state, rec, { now: NOW });

    // The price only ever changes through the approval node.
    expect(rec.orders[0].unitPrice).toBeNull();
  });
});

describe("confirm — partial confirmation (the hero path)", () => {
  it("records both halves of the answer", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    await confirm(state, rec, { now: NOW });

    expect(rec.orders[0]).toMatchObject({
      status: "PARTIALLY_CONFIRMED",
      confirmedQuantity: 120,
      remainingQuantity: 80,
    });
  });

  it("schedules BOTH a remainder chase and a verification", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    await confirm(state, rec, { now: NOW });

    expect(rec.followUps.map((f) => f.kind).sort()).toEqual([
      "REMAINING_QUANTITY",
      "VERIFICATION",
    ]);
  });

  it("summarises what is still outstanding, not just what was secured", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    await confirm(state, rec, { now: NOW });

    expect(rec.orders[0].summary).toMatch(/120 of 200/);
    expect(rec.orders[0].summary).toMatch(/80 cases outstanding/);
  });

  it("chases the remainder in business hours, not at the hour the call happened", async () => {
    const rec = recorder();
    const midnight = new Date("2026-09-12T22:00:00.000Z"); // 03:30 IST
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    await confirm(state, rec, { now: midnight });

    const chase = rec.followUps.find((f) => f.kind === "REMAINING_QUANTITY")!;
    // The 13th is a Sunday, so the chase rolls to Monday the 14th. Calling a
    // warehouse at 10:00 on a Sunday is the behaviour this helper exists to
    // avoid, and "next morning" is not the same thing as "next business
    // morning" — which is what the function is called.
    expect(new Date(chase.dueAt).toISOString()).toBe("2026-09-14T04:30:00.000Z"); // 10:00 IST Mon
  });

  it("skips the weekend rather than chasing on a Saturday", () => {
    // Friday 2026-09-11, late evening.
    const friday = new Date("2026-09-11T20:00:00.000Z");
    const due = nextBusinessMorning(friday);

    expect(due.toISOString()).toBe("2026-09-14T04:30:00.000Z"); // Monday
    expect(due.getUTCDay()).toBe(1);
  });
});

describe("confirm — quantities that do not reconcile (PRD §9)", () => {
  it("refuses to write them and routes to review instead", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.conflictingQuantities, HIGH);

    const updates = await confirm(state, rec, { now: NOW });

    expect(rec.orders[0]).toMatchObject({
      status: "HUMAN_REVIEW",
      committed: false,
      confirmedQuantity: null,
      remainingQuantity: null,
    });
    expect(updates.requiresHumanReview).toBe(true);
  });

  it("schedules no follow-ups for an order it did not confirm", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.conflictingQuantities, HIGH);

    await confirm(state, rec, { now: NOW });

    expect(rec.followUps).toHaveLength(0);
  });
});

describe("approval — FR-5.3, the price a machine may not accept", () => {
  it("parks the order without applying the new price", async () => {
    const orders: OrderOutcome[] = [];
    const requests: { proposedUnitPrice: number; previousUnitPrice: number }[] = [];
    const state = withResult(makeState(), RESULTS.priceChange, HIGH);

    const updates = await approval(state, {
      requestApproval: async ({ approval: a }) => void requests.push(a),
      updateOrder: async (o) => void orders.push(o),
    });

    expect(orders[0]).toMatchObject({
      status: "APPROVAL_REQUIRED",
      committed: false,
      unitPrice: null,        // NOT 2050 — a person decides
      confirmedQuantity: null,
    });
    expect(requests[0]).toMatchObject({
      previousUnitPrice: 1850,
      proposedUnitPrice: 2050,
    });
    expect(updates.pendingApproval?.proposedUnitPrice).toBe(2050);
  });

  it("quantifies the change so the operator can decide at a glance", async () => {
    const requests: { reason: string }[] = [];
    const state = withResult(makeState(), RESULTS.priceChange, HIGH);

    await approval(state, {
      requestApproval: async ({ approval: a }) => void requests.push(a),
      updateOrder: async () => {},
    });

    expect(requests[0].reason).toMatch(/200 INR increase/);
    expect(requests[0].reason).toMatch(/10\.8%/);
  });

  it("passes CALL-E's evidence through so the decision rests on what was said", async () => {
    let captured: string[] = [];
    const state = withResult(makeState(), RESULTS.priceChange, HIGH, [
      "[FIXTURE] The contact quoted 2050 per case.",
    ]);

    await approval(state, {
      requestApproval: async ({ evidence }) => void (captured = evidence),
      updateOrder: async () => {},
    });

    expect(captured).toEqual(["[FIXTURE] The contact quoted 2050 per case."]);
  });
});

describe("resolveCallbackTime", () => {
  const contact = makeContact({
    workingHours: { start: "09:00", end: "18:00", timezone: "Asia/Kolkata" },
  });

  it("uses the requested time when it is inside working hours", () => {
    const resolved = resolveCallbackTime("2026-09-13T10:30:00.000Z", contact, NOW); // 16:00 IST
    expect(resolved).toMatchObject({
      callbackAt: "2026-09-13T10:30:00.000Z",
      adjusted: false,
    });
  });

  it("moves a request outside working hours to the next opening", () => {
    const resolved = resolveCallbackTime("2026-09-13T17:00:00.000Z", contact, NOW); // 22:30 IST
    expect(resolved.adjusted).toBe(true);
    expect(resolved.callbackAt).not.toBe("2026-09-13T17:00:00.000Z");
  });

  it("falls back to a default delay when no time was given", () => {
    const resolved = resolveCallbackTime(undefined, contact, NOW);
    expect(new Date(resolved.callbackAt).getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
  });

  it("falls back when the model wrote prose instead of a timestamp", () => {
    const resolved = resolveCallbackTime("after lunch", contact, NOW);
    expect(new Date(resolved.callbackAt).getTime()).toBe(NOW.getTime() + 30 * 60 * 1000);
  });

  it("falls back rather than queueing a job in the past", () => {
    const resolved = resolveCallbackTime("2026-09-13T05:00:00.000Z", contact, NOW);
    expect(new Date(resolved.callbackAt).getTime()).toBeGreaterThan(NOW.getTime());
    expect(resolved.adjusted).toBe(true);
  });
});

describe("scheduleCallback", () => {
  it("queues the retry and parks the order", async () => {
    const rec = recorder();
    const jobs: { callbackAt: string; rung: number }[] = [];
    const state = withResult(makeState(), RESULTS.callback, HIGH);

    await scheduleCallback(
      state,
      {
        scheduleCallbackJob: async (p) => void jobs.push(p),
        scheduleFollowUp: rec.scheduleFollowUp,
        updateOrder: rec.updateOrder,
      },
      { now: NOW }
    );

    expect(jobs).toHaveLength(1);
    expect(rec.orders[0].status).toBe("CALLBACK_SCHEDULED");
    expect(rec.followUps[0].kind).toBe("CALLBACK");
  });

  it("starts a parallel rung for an URGENT order", async () => {
    const rec = recorder();
    let parallel = 0;
    const state = withResult(makeState({ urgency: "URGENT" }), RESULTS.callback, HIGH);

    await scheduleCallback(
      state,
      {
        scheduleCallbackJob: async () => {},
        scheduleFollowUp: rec.scheduleFollowUp,
        updateOrder: rec.updateOrder,
        triggerParallelRung: async () => void parallel++,
      },
      { now: NOW }
    );

    expect(parallel).toBe(1);
  });

  it("does NOT start a parallel rung for a routine order — that would burn a credit", async () => {
    const rec = recorder();
    let parallel = 0;
    const state = withResult(makeState({ urgency: "ROUTINE" }), RESULTS.callback, HIGH);

    await scheduleCallback(
      state,
      {
        scheduleCallbackJob: async () => {},
        scheduleFollowUp: rec.scheduleFollowUp,
        updateOrder: rec.updateOrder,
        triggerParallelRung: async () => void parallel++,
      },
      { now: NOW }
    );

    expect(parallel).toBe(0);
  });
});

describe("humanReview", () => {
  it("parks the order with NO quantities, whatever the call claimed", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.vague, LOW);

    await humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder });

    expect(rec.orders[0]).toMatchObject({
      status: "HUMAN_REVIEW",
      committed: false,
      confirmedQuantity: null,
      remainingQuantity: null,
    });
  });

  it("explains itself in the supplier's own words", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.vague, LOW);

    await humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder });

    expect(rec.orders[0].summary).toMatch(/0\.58/);
    expect(rec.orders[0].summary).toMatch(/Should be fine/);
    expect(rec.orders[0].summary).toMatch(/Nothing has been written/);
  });

  it("stores the untrusted result verbatim anyway — it is still evidence", async () => {
    let stored: unknown = undefined;
    const state = withResult(makeState(), RESULTS.vague, LOW);

    await humanReview(state, {
      parkOrder: async ({ structuredResult }) => void (stored = structuredResult),
      updateOrder: async () => {},
    });

    expect(stored).toEqual(RESULTS.vague);
  });

  it("reports a call error rather than a confidence score when the call failed", async () => {
    const rec = recorder();
    const state = makeState({ callError: "CALL-E returned 500" });

    await humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder });

    expect(rec.orders[0].summary).toMatch(/could not be completed/);
    expect(rec.orders[0].summary).toMatch(/500/);
  });
});

describe("unresolved", () => {
  it("alerts operations loudly and names everyone tried", async () => {
    const rec = recorder();
    const alerts: string[] = [];
    const state = makeState({
      rung: 3,
      attemptedContacts: [PRIMARY.id, BACKUP.id, SUPERVISOR.id],
    });

    await unresolved(state, {
      updateOrder: rec.updateOrder,
      alertOperations: async ({ reason }) => void alerts.push(reason),
    });

    expect(rec.orders[0].status).toBe("UNRESOLVED");
    expect(alerts[0]).toMatch(/3 contacts/);
    expect(alerts[0]).toMatch(/ORD-482/);
  });

  it("does not claim contacts were tried when the kill switch stopped the run", async () => {
    const rec = recorder();
    const state = makeState({
      callError: "Outbound calling is halted by the global kill switch.",
      attemptedContacts: [],
    });

    await unresolved(state, {
      updateOrder: rec.updateOrder,
      alertOperations: async () => {},
    });

    expect(rec.orders[0].summary).not.toMatch(/exhausted/);
    expect(rec.orders[0].summary).toMatch(/kill switch/);
  });
});

describe("escalate — the rung cap", () => {
  it("advances and clears the current contact so nobody is re-dialled", () => {
    const { nextNode, updatedState } = escalate(makeState({ rung: 1, maxRungs: 3 }));

    expect(nextNode).toBe("select_contact");
    expect(updatedState.rung).toBe(2);
    expect(updatedState.currentContact).toBeNull();
    expect(updatedState.attemptedContacts).toEqual([PRIMARY.id]);
  });

  it("stops at the cap", () => {
    const { nextNode, reason } = escalate(makeState({ rung: 3, maxRungs: 3 }));

    expect(nextNode).toBe("unresolved");
    expect(reason).toMatch(/Rung cap reached \(3\/3\)/);
  });

  it("still records the final attempt when the ladder is exhausted", () => {
    const { updatedState } = escalate(makeState({ rung: 3, maxRungs: 3 }));
    expect(updatedState.attemptedContacts).toContain(PRIMARY.id);
  });

  it("explains the escalation in the supplier's terms", () => {
    const noAnswer = withResult(makeState(), RESULTS.noAnswer, { score: 0, label: "none" });
    expect(escalate(noAnswer).reason).toMatch(/did not answer/);

    const wrong = withResult(makeState(), RESULTS.wrongPerson, { score: 0.3, label: "low" });
    expect(escalate(wrong).reason).toMatch(/no details were disclosed/);

    const gone = withResult(makeState(), RESULTS.unavailable, HIGH);
    expect(escalate(gone).reason).toMatch(/cannot supply/);
  });
});

describe("follow-up timing helpers", () => {
  it("verifies just after the stated dispatch", () => {
    const due = verificationDueAt("2026-09-13T11:00:00.000Z", NOW);
    expect(due.toISOString()).toBe("2026-09-13T11:30:00.000Z");
  });

  it("falls back to +2h when no dispatch date was given", () => {
    const due = verificationDueAt(undefined, NOW);
    expect(due.getTime()).toBe(NOW.getTime() + 2 * 60 * 60 * 1000);
  });

  it("never schedules a verification in the past", () => {
    const due = verificationDueAt("2026-09-01T11:00:00.000Z", NOW);
    expect(due.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("puts the next business morning at 10:00 IST", () => {
    expect(nextBusinessMorning(NOW).toISOString()).toBe("2026-09-14T04:30:00.000Z");
  });

  // A date-only dispatch parses as UTC midnight, so "+30 minutes" landed at
  // 06:00 IST — three hours before the contact opens. `select_contact` would
  // then reject them for being outside working hours and the verification run
  // would end UNRESOLVED, purely because of arithmetic.
  it("does not schedule a date-only dispatch check before the contact opens", () => {
    const due = verificationDueAt("2026-09-16", NOW);

    expect(due.toISOString()).not.toBe("2026-09-16T00:30:00.000Z");
    expect(due.getUTCHours()).toBe(4);
    expect(due.getUTCMinutes()).toBe(30);
  });

  it("checks a date-only dispatch the morning AFTER the stated day", () => {
    // They said it goes out on the 16th; "did yesterday's dispatch leave?" is
    // a question with an answer, "is today's out yet?" at 10:00 is not.
    expect(verificationDueAt("2026-09-16", NOW).toISOString()).toBe(
      "2026-09-17T04:30:00.000Z"
    );
  });

  it("still uses the precise time when the dispatch date has one", () => {
    expect(verificationDueAt("2026-09-16T14:00:00.000Z", NOW).toISOString()).toBe(
      "2026-09-16T14:30:00.000Z"
    );
  });
});
