/**
 * packages/agent/__tests__/edgeCases.test.ts
 *
 * The defensive paths: optional callbacks the backend did not wire, a missing
 * contact, absent optional fields, and every branch of the human-readable
 * reason builders.
 *
 * These are not filler. Each one is a case where the agent must degrade
 * sensibly rather than throw — the backend wires these callbacks incrementally,
 * and a node that crashes because `notifyBuyer` is undefined takes an order
 * down with it.
 */

import { confirm } from "../nodes/confirm";
import { approval } from "../nodes/approval";
import { humanReview } from "../nodes/humanReview";
import { unresolved } from "../nodes/unresolved";
import { scheduleCallback } from "../nodes/scheduleCallback";
import { escalate } from "../nodes/escalate";
import { assessOrder, toDuplicateCandidate } from "../nodes/assessOrder";
import { narrowResult, executeCall } from "../nodes/executeCall";
import { decide } from "../nodes/decide";
import { lastStructuredResult } from "../state";
import { makeState, withResult, RESULTS, HIGH, LOW, NONE, SELLER, BUYER, ITEM, TRIGGER } from "./fixtures";
import type { FollowUp, Order, OrderOutcome, OrderStatus, WholesaleResult } from "../../types";

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

describe("optional callbacks the backend has not wired yet", () => {
  it("confirm works without notifyBuyer", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    await expect(confirm(state, rec, { now: NOW })).resolves.toBeDefined();
    expect(rec.orders).toHaveLength(1);
  });

  it("confirm calls notifyBuyer when it IS wired", async () => {
    const rec = recorder();
    let notified = 0;
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    await confirm(
      state,
      { ...rec, notifyBuyer: async () => void notified++ },
      { now: NOW }
    );

    expect(notified).toBe(1);
  });

  it("humanReview works without alertOperator", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.vague, LOW);

    await expect(
      humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder })
    ).resolves.toBeDefined();
  });

  it("humanReview calls alertOperator when wired", async () => {
    const rec = recorder();
    let alerted = 0;
    const state = withResult(makeState(), RESULTS.vague, LOW);

    await humanReview(state, {
      parkOrder: async () => {},
      updateOrder: rec.updateOrder,
      alertOperator: async () => void alerted++,
    });

    expect(alerted).toBe(1);
  });

  it("scheduleCallback works without triggerParallelRung on an URGENT order", async () => {
    const rec = recorder();
    const state = withResult(makeState({ urgency: "URGENT" }), RESULTS.callback, HIGH);

    await expect(
      scheduleCallback(
        state,
        {
          scheduleCallbackJob: async () => {},
          scheduleFollowUp: rec.scheduleFollowUp,
          updateOrder: rec.updateOrder,
        },
        { now: NOW }
      )
    ).resolves.toBeDefined();
  });
});

describe("a missing contact does not crash a terminal node", () => {
  const noContact = { currentContact: null };

  it("confirm records a null contactId", async () => {
    const rec = recorder();
    const state = withResult(makeState(noContact), RESULTS.fullConfirmation, HIGH);

    await confirm(state, rec, { now: NOW });

    expect(rec.orders[0].contactId).toBeNull();
    // Falls back to the seller's name in the summary rather than "undefined".
    expect(rec.orders[0].summary).toContain(SELLER.name);
  });

  it("approval records a null contactId", async () => {
    const orders: OrderOutcome[] = [];
    const state = withResult(makeState(noContact), RESULTS.priceChange, HIGH);

    await approval(state, {
      requestApproval: async () => {},
      updateOrder: async (o) => void orders.push(o),
    });

    expect(orders[0].contactId).toBeNull();
    expect(orders[0].summary).toContain(SELLER.name);
  });

  it("humanReview falls back to the seller name", async () => {
    const rec = recorder();
    const state = withResult(makeState(noContact), RESULTS.vague, LOW);

    await humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder });

    expect(rec.orders[0].summary).toContain(SELLER.name);
    expect(rec.orders[0].summary).not.toContain("undefined");
  });

  it("escalate says 'the contact' rather than 'undefined'", () => {
    const state = withResult(makeState(noContact), RESULTS.noAnswer, NONE);
    expect(escalate(state).reason).toContain("the contact");
  });

  it("executeCall refuses to dial with no contact selected", async () => {
    await expect(
      executeCall(makeState(noContact), async () => ({ callId: "x" }), { useMock: true })
    ).rejects.toThrow(/no currentContact/);
  });
});

describe("buildReviewReason — every branch", () => {
  async function reasonFor(state: Parameters<typeof humanReview>[0]): Promise<string> {
    const rec = recorder();
    await humanReview(state, { parkOrder: async () => {}, updateOrder: rec.updateOrder });
    return rec.orders[0].summary;
  }

  it("reports a call error above everything else", async () => {
    const reason = await reasonFor(makeState({ callError: "SIP 500" }));
    expect(reason).toMatch(/could not be completed.*SIP 500/);
  });

  it("reports a missing result", async () => {
    expect(await reasonFor(makeState())).toMatch(/No usable call result/);
  });

  it("reports conflicting quantities with both numbers", async () => {
    const state = withResult(makeState(), RESULTS.conflictingQuantities, HIGH);
    expect(await reasonFor(state)).toMatch(/does not sum/);
  });

  it("reports low confidence and quotes what was said", async () => {
    const state = withResult(makeState(), RESULTS.vague, LOW);
    const reason = await reasonFor(state);

    expect(reason).toMatch(/0\.58/);
    expect(reason).toMatch(/Should be fine/);
  });

  it("reports low confidence without a quote when none was captured", async () => {
    const bare: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "unknown",
      next_action: "CONFIRM_ORDER",
    };
    const reason = await reasonFor(withResult(makeState(), bare, LOW));

    expect(reason).toMatch(/did not give a clear answer/);
    expect(reason).not.toContain("undefined");
  });

  it("reports a price change at high confidence", async () => {
    const state = withResult(makeState(), RESULTS.sneakyPriceChange, HIGH);
    const reason = await reasonFor(state);

    expect(reason).toMatch(/2050/);
    expect(reason).toMatch(/1850/);
  });

  it("reports an explicit HUMAN_REVIEW with its verbatim", async () => {
    const state = withResult(makeState(), RESULTS.explicitReview, HIGH);
    expect(await reasonFor(state)).toMatch(/speak to accounts/);
  });

  it("reports an explicit HUMAN_REVIEW with no verbatim", async () => {
    const bare: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "unknown",
      next_action: "HUMAN_REVIEW",
    };
    const reason = await reasonFor(withResult(makeState(), bare, HIGH));

    expect(reason).toMatch(/will not action on its own/);
    expect(reason).not.toContain("undefined");
  });
});

describe("buildApprovalReason — the non-price path", () => {
  async function reasonFor(result: WholesaleResult): Promise<string> {
    let captured = "";
    await approval(withResult(makeState(), result, HIGH), {
      requestApproval: async ({ approval: a }) => void (captured = a.reason),
      updateOrder: async () => {},
    });
    return captured;
  }

  it("handles requires_approval with no price change — credit or terms", async () => {
    const terms: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      requires_approval: true,
      verbatim_commitment: "[FIXTURE] We'd need payment up front on this one.",
      next_action: "REQUEST_APPROVAL",
    };

    const reason = await reasonFor(terms);

    expect(reason).toMatch(/commercial condition the agent may not accept/);
    expect(reason).toMatch(/payment up front/);
  });

  it("handles a terms change with no verbatim captured", async () => {
    const terms: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "confirmed",
      requires_approval: true,
      next_action: "REQUEST_APPROVAL",
    };

    const reason = await reasonFor(terms);
    expect(reason).not.toContain("undefined");
  });

  it("describes a price REDUCTION as a reduction, not an increase", async () => {
    const cheaper: WholesaleResult = {
      ...RESULTS.priceChange,
      unit_price: 1700,
    };

    expect(await reasonFor(cheaper)).toMatch(/150 INR reduction/);
  });

  it("falls back to the order's currency when the supplier gave none", async () => {
    const noCurrency: WholesaleResult = {
      ...RESULTS.priceChange,
      currency: undefined,
    };

    expect(await reasonFor(noCurrency)).toMatch(/INR/);
  });
});

describe("escalationReason — every contact_reached branch", () => {
  it.each([
    ["noAnswer", /did not answer/],
    ["voicemail", /Reached voicemail/],
    ["wrongPerson", /Someone other than/],
    ["unavailable", /cannot supply/],
  ] as const)("explains %s", (fixture, pattern) => {
    const state = withResult(makeState(), RESULTS[fixture], HIGH);
    expect(escalate(state).reason).toMatch(pattern);
  });

  it("explains a call error", () => {
    const state = makeState({ callError: "CALL-E timed out" });
    expect(escalate(state).reason).toMatch(/failed: CALL-E timed out/);
  });

  it("explains an unavailable supplier with no stated reason", () => {
    const bare: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "unavailable",
      next_action: "ESCALATE_NEXT_CONTACT",
    };
    const reason = escalate(withResult(makeState(), bare, HIGH)).reason;

    expect(reason).toMatch(/cannot supply\./);
    expect(reason).not.toContain("undefined");
  });

  it("falls back when there is no result at all", () => {
    expect(escalate(makeState()).reason).toMatch(/No usable result/);
  });

  it("explains a reached contact who simply gave nothing usable", () => {
    const nothing: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    };
    expect(escalate(withResult(makeState(), nothing, HIGH)).reason).toMatch(
      /no usable commitment/
    );
  });
});

describe("describeStatus — duplicate suppression wording", () => {
  const statuses: OrderStatus[] = [
    "CALLING",
    "CONFIRMED",
    "PARTIALLY_CONFIRMED",
    "APPROVAL_REQUIRED",
    "CALLBACK_SCHEDULED",
  ];

  it.each(statuses)("describes %s in plain language", (status) => {
    const outcome = assessOrder(makeState(), {
      now: NOW,
      existingOrders: [
        {
          id: "CR-1001",
          reference: "ORD-479",
          sellerId: SELLER.id,
          sku: ITEM.sku,
          status,
          createdAt: "2026-09-13T05:00:00.000Z",
        },
      ],
    });

    expect(outcome.route).toBe("suppress");
    expect(outcome.reason).not.toContain(status); // human words, not an enum
    expect(outcome.reason).toMatch(/ORD-479/);
  });
});

describe("toDuplicateCandidate", () => {
  it("narrows a full Order to what duplicate detection needs", () => {
    const order: Order = {
      id: "CR-1001",
      reference: "ORD-479",
      traceId: "t",
      buyer: BUYER,
      seller: SELLER,
      item: ITEM,
      status: "CONFIRMED",
      urgency: "PRIORITY",
      requiredBy: "2026-09-14T00:00:00.000Z",
      trigger: TRIGGER,
      createdAt: "2026-09-13T05:00:00.000Z",
      closedAt: null,
      currentRung: 1,
      maxRungs: 3,
      outcome: null,
      operatorMinutesSaved: null,
    };

    expect(toDuplicateCandidate(order)).toEqual({
      id: "CR-1001",
      reference: "ORD-479",
      sellerId: SELLER.id,
      sku: ITEM.sku,
      status: "CONFIRMED",
      createdAt: "2026-09-13T05:00:00.000Z",
    });
  });
});

describe("narrowResult", () => {
  it("returns null for a null payload", () => {
    expect(narrowResult(null)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(narrowResult({ contact_reached: "yes", stock_status: "confirmed" })).toBeNull();
    expect(narrowResult({ contact_reached: "yes", next_action: "CONFIRM_ORDER" })).toBeNull();
    expect(narrowResult({ stock_status: "confirmed", next_action: "CONFIRM_ORDER" })).toBeNull();
  });

  it("returns null for an empty object rather than a half-built result", () => {
    expect(narrowResult({})).toBeNull();
  });

  it("passes a complete payload through untouched, extra keys included", () => {
    const raw = {
      contact_reached: "yes",
      stock_status: "confirmed",
      next_action: "CONFIRM_ORDER",
      some_future_field: 42,
    };

    expect(narrowResult(raw)).toBe(raw);
  });

  it("a null result routes the order to review, not to a commitment", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    // execute_call appends nothing when narrowResult returns null, so decide
    // sees no structuredResult at all.
    expect(decide(makeState())).toBe("human_review");
    spy.mockRestore();
  });
});

describe("unresolved — reason wording", () => {
  it("uses the singular for one contact", async () => {
    const rec = recorder();
    const alerts: string[] = [];

    await unresolved(makeState({ attemptedContacts: ["ct-one"] }), {
      updateOrder: rec.updateOrder,
      alertOperations: async ({ reason }) => void alerts.push(reason),
    });

    expect(alerts[0]).toMatch(/after 1 contact /);
  });

  it("reports an empty directory without a call error", async () => {
    const rec = recorder();

    await unresolved(makeState({ attemptedContacts: [] }), {
      updateOrder: rec.updateOrder,
      alertOperations: async () => {},
    });

    expect(rec.orders[0].summary).toMatch(/No contact at Metro Supply Co\./);
    expect(rec.orders[0].summary).not.toContain("undefined");
  });
});

describe("a call with an unusable payload does not inherit the previous call's answer", () => {
  // `structuredResults` was appended to only when a call produced a usable
  // result, while confidenceHistory and callHistory were appended to on every
  // call. After one unusable payload the arrays were out of step, and
  // lastStructuredResult() handed the CURRENT call the PREVIOUS call's
  // extraction — so decide, escalate and every summary reasoned about a
  // commitment made by a different contact.

  /** Rung 1 answered usefully; rung 2's payload came back unusable. */
  const drifted = makeState({
    structuredResults: [RESULTS.unavailable, null],
    confidenceHistory: [HIGH, HIGH],
  });

  it("reports nothing rather than the earlier call's result", () => {
    expect(lastStructuredResult(drifted)).toBeNull();
  });

  it("routes to review instead of acting on a stale commitment", () => {
    expect(decide(drifted)).toBe("human_review");
  });

  it("keeps the result and confidence arrays index-aligned", () => {
    expect(drifted.structuredResults).toHaveLength(drifted.confidenceHistory.length);
  });

  it("still reads the current result when there is one", () => {
    const fine = makeState({
      structuredResults: [RESULTS.unavailable, RESULTS.fullConfirmation],
      confidenceHistory: [HIGH, HIGH],
    });

    expect(lastStructuredResult(fine)?.next_action).toBe("CONFIRM_ORDER");
  });
});

describe("confirm — a commitment with no number in it", () => {
  // `confirmed_quantity` is omitted whenever the supplier hedged ("about 200"),
  // which the schema now treats as not-a-commitment. This used to be written
  // CONFIRMED / committed: true with confirmedQuantity null, and the summary
  // filled the gap from the ORDER: "Rajesh confirmed all 200 cases." Nobody
  // said 200.

  const unquantified: WholesaleResult = {
    contact_reached: "yes",
    stock_status: "confirmed",
    verbatim_commitment: "[FIXTURE] Yeah, about two hundred, should be fine.",
    next_action: "CONFIRM_ORDER",
  };

  it("does not commit the order", async () => {
    const rec = recorder();
    await confirm(withResult(makeState(), unquantified, HIGH), rec, { now: NOW });

    expect(rec.orders[0].status).toBe("HUMAN_REVIEW");
    expect(rec.orders[0].committed).toBe(false);
  });

  it("does not claim a quantity the supplier never gave", async () => {
    const rec = recorder();
    await confirm(withResult(makeState(), unquantified, HIGH), rec, { now: NOW });

    expect(rec.orders[0].confirmedQuantity).toBeNull();
    expect(rec.orders[0].summary).not.toMatch(/confirmed all 200/);
    expect(rec.orders[0].summary).toMatch(/gave no firm quantity/);
  });

  it("quotes what they actually said, so the operator can judge it", async () => {
    const rec = recorder();
    await confirm(withResult(makeState(), unquantified, HIGH), rec, { now: NOW });

    expect(rec.orders[0].summary).toContain("about two hundred");
  });

  it("schedules no follow-ups off a commitment that was not made", async () => {
    const rec = recorder();
    await confirm(withResult(makeState(), unquantified, HIGH), rec, { now: NOW });

    expect(rec.followUps).toHaveLength(0);
  });

  it("still confirms normally when a firm quantity WAS given", async () => {
    const rec = recorder();
    await confirm(withResult(makeState(), RESULTS.fullConfirmation, HIGH), rec, { now: NOW });

    expect(rec.orders[0].status).toBe("CONFIRMED");
    expect(rec.orders[0].confirmedQuantity).toBe(200);
  });
});

describe("confirm — optional fields absent", () => {
  it("omits the dispatch clause when no date was given", async () => {
    const rec = recorder();
    const noDispatch: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      next_action: "CONFIRM_ORDER",
    };

    await confirm(withResult(makeState(), noDispatch, HIGH), rec, { now: NOW });

    expect(rec.orders[0].summary).not.toContain("undefined");
    expect(rec.orders[0].dispatchDate).toBeNull();
  });

  it("omits the balance clause on a partial with no delivery ETA", async () => {
    const rec = recorder();
    const noEta: WholesaleResult = {
      contact_reached: "yes",
      stock_status: "partial",
      confirmed_quantity: 120,
      remaining_quantity: 80,
      next_action: "PARTIAL_CONFIRMATION",
    };

    await confirm(withResult(makeState(), noEta, HIGH), rec, { now: NOW });

    expect(rec.orders[0].summary).toMatch(/80 cases outstanding\./);
    expect(rec.orders[0].summary).not.toContain("undefined");
  });

  it("honours an overridden labour baseline", async () => {
    const rec = recorder();
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);

    await confirm(state, rec, { now: NOW, manualBaselineMinutes: 25 });

    expect(rec.orders[0].operatorMinutesSaved).toBe(25);
  });
});
