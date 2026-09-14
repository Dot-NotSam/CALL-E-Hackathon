/**
 * packages/agent/__tests__/verify.test.ts
 *
 * The follow-up call that checks a commitment was actually met.
 *
 * ⚠️  `verify` is NOT a node in the compiled graph. It is a callable unit the
 * backend invokes when a VERIFICATION or REMAINING_QUANTITY follow-up fires
 * from the queue — a fresh run on the same order, same trace_id. These tests
 * cover it directly for that reason.
 */

import { verify, buildVerificationTaskPrompt } from "../nodes/verify";
import { makeState, withResult, RESULTS, HIGH, PRIMARY } from "./fixtures";
import type { FollowUp, OrderOutcome, WholesaleResult } from "../../types";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function recorder() {
  const orders: OrderOutcome[] = [];
  const followUps: FollowUp[] = [];
  const completed: string[] = [];

  return {
    orders,
    followUps,
    completed,
    updateOrder: async (o: OrderOutcome) => void orders.push(o),
    scheduleFollowUp: async (f: FollowUp) => void followUps.push(f),
    completeFollowUp: async (id: string) => void completed.push(id),
  };
}

describe("verify — the commitment held", () => {
  it("routes to confirm when the supplier confirms dispatch", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    const { route, reason } = await verify(state, rec, { now: NOW });

    expect(route).toBe("confirm");
    expect(reason).toMatch(/confirmed dispatch/);
  });

  it("accepts a partial dispatch as held — some goods moved", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    expect((await verify(state, rec, { now: NOW })).route).toBe("confirm");
  });

  it("marks the triggering follow-up done so it leaves the panel", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    await verify(state, rec, { now: NOW, followUpId: "CR-1007-verification" });

    expect(rec.completed).toEqual(["CR-1007-verification"]);
  });
});

describe("verify — the commitment did not hold", () => {
  /** Dispatch had not happened, but a new date was offered. */
  const revised: WholesaleResult = {
    contact_reached: "yes",
    stock_status: "unknown",
    dispatch_date: "2026-09-14T06:00:00.000Z",
    verbatim_commitment: "[FIXTURE] It'll go out tomorrow morning instead.",
    next_action: "PARTIAL_CONFIRMATION",
  };

  it("chases a revised date once rather than escalating immediately", async () => {
    const rec = recorder();
    const state = withResult(makeState(), revised, HIGH);

    const { route } = await verify(state, rec, { now: NOW });

    expect(route).toBe("confirm");
    expect(rec.followUps).toHaveLength(1);
    expect(rec.followUps[0].kind).toBe("VERIFICATION");
    expect(rec.followUps[0].note).toMatch(/revised dispatch date/);
  });

  it("reports the revised date as the run's outcome, not just to the DB", async () => {
    // This branch called updateOrder but returned no finalOutcome, so the run
    // ended looking like nothing happened while the order had in fact moved.
    const rec = recorder();
    const state = withResult(makeState(), revised, HIGH);

    const { updates } = await verify(state, rec, { now: NOW });

    expect(updates.finalOutcome).toBeDefined();
    expect(updates.finalOutcome).toEqual(rec.orders[rec.orders.length - 1]);
    expect(updates.finalOutcome?.dispatchDate).toBe(revised.dispatch_date);
  });

  it("escalates a second miss when THIS run is the re-check", async () => {
    // The original guard scanned state.followUps for a DONE verification. A
    // follow-up run starts with followUps: [] and nothing in the graph ever
    // marks one DONE, so it never fired and a supplier who moved the date
    // every time was chased forever, one credit per round. The re-check is
    // identified by the follow-up id that scheduled it.
    const rec = recorder();
    const state = withResult(
      makeState({ followUpId: "CR-1007-verification-revised" }),
      revised,
      HIGH
    );

    const { route } = await verify(state, rec, { now: NOW });

    expect(route).toBe("escalate");
    expect(rec.followUps).toHaveLength(0);
  });

  it("still chases when the run came from the FIRST verification", async () => {
    const rec = recorder();
    const state = withResult(
      makeState({ followUpId: "CR-1007-verification" }),
      revised,
      HIGH
    );

    expect((await verify(state, rec, { now: NOW })).route).toBe("confirm");
  });

  it("escalates on the SECOND miss rather than chasing indefinitely", async () => {
    const rec = recorder();
    const alreadyChased = makeState({
      followUps: [
        {
          id: "CR-1007-verification",
          orderId: "CR-1007",
          kind: "VERIFICATION",
          dueAt: "2026-09-13T11:30:00.000Z",
          contactId: PRIMARY.id,
          note: "first check",
          status: "DONE",
        },
      ],
    });

    const state = withResult(alreadyChased, revised, HIGH);
    const { route } = await verify(state, rec, { now: NOW });

    expect(route).toBe("escalate");
  });

  it("escalates when no revised date is given at all", async () => {
    const rec = recorder();
    const state = withResult(
      makeState(),
      { contact_reached: "yes", stock_status: "unknown", next_action: "HUMAN_REVIEW" },
      HIGH
    );

    const { route, reason } = await verify(state, rec, { now: NOW });

    expect(route).toBe("escalate");
    expect(reason).toMatch(/no revised date/);
  });

  it("escalates when nobody answered the verification call", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.noAnswer, { score: 0, label: "none" });

    expect((await verify(state, rec, { now: NOW })).route).toBe("escalate");
  });

  it("never schedules a re-check in the past", async () => {
    const rec = recorder();
    const stale: WholesaleResult = { ...revised, dispatch_date: "2020-01-01T00:00:00.000Z" };
    const state = withResult(makeState(), stale, HIGH);

    await verify(state, rec, { now: NOW });

    expect(new Date(rec.followUps[0].dueAt).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("buildVerificationTaskPrompt", () => {
  it("builds a short dispatch check, not a full briefing", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);
    const prompt = buildVerificationTaskPrompt(state, PRIMARY, "VERIFICATION");

    expect(prompt).toMatch(/Has the order dispatched\?/);
    expect(prompt).toMatch(/under 45 seconds/);
    expect(prompt).toContain("ORD-482");
  });

  it("builds a remainder chase carrying the outstanding quantity", () => {
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);
    const prompt = buildVerificationTaskPrompt(state, PRIMARY, "REMAINING_QUANTITY");

    expect(prompt).toContain("80 cases");
    expect(prompt).toMatch(/Do not re-brief/);
  });

  it("keeps the safety clauses that the main prompt has", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);
    const prompt = buildVerificationTaskPrompt(state, PRIMARY);

    expect(prompt).toMatch(/automated operations line/);
    expect(prompt).toMatch(/Never disclose order details to anyone who is not Rajesh Iyer/);
    expect(prompt).toMatch(/Never agree to a price/);
  });

  it("renders no unfilled template holes", () => {
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);

    for (const kind of ["VERIFICATION", "REMAINING_QUANTITY"] as const) {
      const prompt = buildVerificationTaskPrompt(state, PRIMARY, kind);
      for (const hole of ["undefined", "null", "NaN", "[object Object]", "Invalid Date"]) {
        expect(prompt).not.toContain(hole);
      }
    }
  });
});
