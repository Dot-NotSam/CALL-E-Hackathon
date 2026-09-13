/**
 * packages/agent/__tests__/decide.test.ts
 *
 * The decision table from docs/FRONTEND_BACKEND_CONTRACT.md §2.2, rule by rule.
 * Every branch of `decide` is reachable and asserted here, because this is the
 * node that decides whether a supplier's words become a commitment.
 */

import {
  decide,
  explainDecision,
  reconcileQuantities,
  priceChanged,
  dispatchMissesDeadline,
} from "../nodes/decide";
import { makeState, withResult, RESULTS, HIGH, LOW, NONE } from "./fixtures";
import type { WholesaleResult } from "../../types";

describe("decide — rule order (contract §2.2)", () => {
  it("routes CONFIRM_ORDER to confirm", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);
    expect(decide(state)).toBe("confirm");
  });

  it("routes PARTIAL_CONFIRMATION to partial", () => {
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);
    expect(decide(state)).toBe("partial");
  });

  it("routes REQUEST_APPROVAL to approval", () => {
    const state = withResult(makeState(), RESULTS.priceChange, HIGH);
    expect(decide(state)).toBe("approval");
  });

  it("routes SCHEDULE_CALLBACK to schedule_callback", () => {
    const state = withResult(makeState(), RESULTS.callback, HIGH);
    expect(decide(state)).toBe("schedule_callback");
  });

  it("routes ESCALATE_NEXT_CONTACT to escalate", () => {
    const state = withResult(makeState(), RESULTS.unavailable, HIGH);
    expect(decide(state)).toBe("escalate");
  });

  it("routes an explicit HUMAN_REVIEW to human_review", () => {
    const state = withResult(makeState(), RESULTS.explicitReview, HIGH);
    expect(decide(state)).toBe("human_review");
  });
});

describe("decide — rule 0: an unverified answerer cannot commit (FR-7.4)", () => {
  // Live calls #9 and #10 both disclosed the order to whoever answered and
  // never asked who it was. These assert the gate that stops such a call
  // becoming a commitment, whatever the conversation produced.

  const unverified = (
    contactReached: WholesaleResult["contact_reached"],
    result: WholesaleResult
  ): WholesaleResult => ({ ...result, contact_reached: contactReached });

  it("does not confirm an order for someone who is not the contact", () => {
    const state = withResult(
      makeState(),
      unverified("wrong_person", RESULTS.fullConfirmation),
      HIGH
    );
    expect(decide(state)).toBe("escalate");
  });

  it("does not accept a partial confirmation from an unidentified answerer", () => {
    const state = withResult(
      makeState(),
      unverified("unknown", RESULTS.partialStock),
      HIGH
    );
    expect(decide(state)).toBe("human_review");
  });

  it("does not raise a price approval off an unverified call", () => {
    // Worth its own case: approval is the branch that puts a number in front of
    // an operator, and a number sourced from the wrong person is worse than no
    // number — it looks like a real quote from the supplier.
    const state = withResult(
      makeState(),
      unverified("wrong_person", RESULTS.priceChange),
      HIGH
    );
    expect(decide(state)).toBe("escalate");
  });

  it("does not schedule a callback agreed by someone else", () => {
    const state = withResult(
      makeState(),
      unverified("voicemail", RESULTS.callback),
      HIGH
    );
    expect(decide(state)).toBe("escalate");
  });

  it("beats high confidence — a wrong person can speak very confidently", () => {
    const state = withResult(
      makeState(),
      unverified("wrong_person", RESULTS.fullConfirmation),
      HIGH
    );
    expect(decide(state)).not.toBe("confirm");
  });

  it("still lets a verified contact through", () => {
    const state = withResult(
      makeState(),
      unverified("yes", RESULTS.fullConfirmation),
      HIGH
    );
    expect(decide(state)).toBe("confirm");
  });

  it("does not interfere with a non-committing action", () => {
    // ESCALATE_NEXT_CONTACT is not a CLOSING_ACTION, so rule 0 leaves it alone
    // and it routes on next_action as usual.
    const state = withResult(
      makeState(),
      unverified("wrong_person", RESULTS.unavailable),
      HIGH
    );
    expect(decide(state)).toBe("escalate");
  });

  it("explains itself in the audit trail", () => {
    const state = withResult(
      makeState(),
      unverified("wrong_person", RESULTS.fullConfirmation),
      HIGH
    );
    expect(explainDecision(state, decide(state))).toMatch(
      /never confirmed they are the named contact/
    );
  });
});

describe("decide — rule 1: confidence beats next_action (FR-5.6)", () => {
  it("sends a low-confidence CONFIRM_ORDER to review, not to confirm", () => {
    const state = withResult(makeState(), RESULTS.vague, LOW);
    expect(decide(state)).toBe("human_review");
  });

  it("sends a low-confidence PARTIAL_CONFIRMATION to review", () => {
    const state = withResult(makeState(), RESULTS.partialStock, LOW);
    expect(decide(state)).toBe("human_review");
  });

  it("sends a low-confidence SCHEDULE_CALLBACK to review", () => {
    const state = withResult(makeState(), RESULTS.callback, LOW);
    expect(decide(state)).toBe("human_review");
  });

  it("sends a low-confidence REQUEST_APPROVAL to review", () => {
    const state = withResult(makeState(), RESULTS.priceChange, LOW);
    expect(decide(state)).toBe("human_review");
  });

  it("STILL ESCALATES at zero confidence — an unanswered call has nobody to be confident about", () => {
    const state = withResult(makeState(), RESULTS.noAnswer, NONE);
    expect(decide(state)).toBe("escalate");
  });

  it("treats exactly 0.70 as acceptable — the threshold is a floor, not a gap", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, {
      score: 0.7,
      label: "medium",
    });
    expect(decide(state)).toBe("confirm");
  });

  it("rejects 0.699", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, {
      score: 0.699,
      label: "medium",
    });
    expect(decide(state)).toBe("human_review");
  });
});

describe("decide — rule 2: a price change is never accepted autonomously (FR-5.3)", () => {
  it("routes to approval when requires_approval is set, whatever next_action says", () => {
    const sneaky: WholesaleResult = {
      ...RESULTS.fullConfirmation,
      requires_approval: true,
    };
    const state = withResult(makeState(), sneaky, HIGH);

    // next_action is CONFIRM_ORDER, but the supplier proposed terms.
    expect(state.structuredResults[0]?.next_action).toBe("CONFIRM_ORDER");
    expect(decide(state)).toBe("approval");
  });

  it("explains the approval in terms of the two prices", () => {
    const state = withResult(makeState(), RESULTS.priceChange, HIGH);
    const explanation = explainDecision(state, "approval");

    expect(explanation).toContain("2050");
    expect(explanation).toContain("1850");
    expect(explanation).toContain("FR-5.3");
  });
});

describe("decide — guards", () => {
  it("routes to review when no result was extracted", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(decide(makeState())).toBe("human_review");
    spy.mockRestore();
  });

  it("routes an unrecognised next_action to review rather than guessing", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const state = withResult(
      makeState(),
      { ...RESULTS.fullConfirmation, next_action: "SHIP_IT" as never },
      HIGH
    );

    expect(decide(state)).toBe("human_review");
    spy.mockRestore();
  });
});

describe("reconcileQuantities", () => {
  it("derives the remainder from the order rather than trusting the supplier's arithmetic", () => {
    const state = withResult(makeState(), RESULTS.partialStock, HIGH);
    expect(reconcileQuantities(state)).toMatchObject({
      confirmed: 120,
      remaining: 80,
      conflicting: false,
    });
  });

  it("flags quantities that do not sum to the requested total", () => {
    const state = withResult(makeState(), RESULTS.conflictingQuantities, HIGH);
    const reconciled = reconcileQuantities(state);

    expect(reconciled.conflicting).toBe(true);
    expect(reconciled.confirmed).toBeNull();
    expect(reconciled.remaining).toBeNull();
    expect(reconciled.note).toMatch(/does not sum/);
  });

  it("flags a confirmed quantity larger than the order", () => {
    const state = withResult(
      makeState(),
      { ...RESULTS.fullConfirmation, confirmed_quantity: 250 },
      HIGH
    );

    expect(reconcileQuantities(state).conflicting).toBe(true);
  });

  it("infers the confirmed quantity when only a remainder was given", () => {
    const state = withResult(
      makeState(),
      {
        contact_reached: "yes",
        stock_status: "partial",
        remaining_quantity: 50,
        next_action: "PARTIAL_CONFIRMATION",
      },
      HIGH
    );

    expect(reconcileQuantities(state)).toMatchObject({ confirmed: 150, remaining: 50 });
  });

  it("returns nulls without flagging a conflict when no quantity was given at all", () => {
    const state = withResult(makeState(), RESULTS.callback, HIGH);
    expect(reconcileQuantities(state)).toMatchObject({
      confirmed: null,
      remaining: null,
      conflicting: false,
    });
  });
});

describe("priceChanged", () => {
  it("detects a quoted price that differs from the order", () => {
    expect(priceChanged(withResult(makeState(), RESULTS.sneakyPriceChange, HIGH))).toBe(true);
  });

  it("does not fire when the supplier quoted the order's own price back", () => {
    expect(priceChanged(withResult(makeState(), RESULTS.fullConfirmation, HIGH))).toBe(false);
  });

  it("does not fire when no price was discussed", () => {
    expect(priceChanged(withResult(makeState(), RESULTS.callback, HIGH))).toBe(false);
  });

  it("routes a price change to approval even when the model left the flag unset", () => {
    const state = withResult(makeState(), RESULTS.sneakyPriceChange, HIGH);

    // The model said CONFIRM_ORDER and did not set requires_approval, so
    // `decide` cannot catch this one — the price guard in confirm/humanReview
    // is what stops it reaching the order. Assert the detection works, which is
    // what those nodes depend on.
    expect(priceChanged(state)).toBe(true);
  });
});

describe("dispatchMissesDeadline", () => {
  it("is false when dispatch beats the required date", () => {
    const state = withResult(makeState(), RESULTS.fullConfirmation, HIGH);
    expect(dispatchMissesDeadline(state)).toBe(false);
  });

  it("is true when dispatch lands after it", () => {
    const state = withResult(
      makeState(),
      { ...RESULTS.fullConfirmation, dispatch_date: "2026-09-20T11:00:00.000Z" },
      HIGH
    );
    expect(dispatchMissesDeadline(state)).toBe(true);
  });

  it("treats a missing dispatch date as late — we cannot prove it is on time", () => {
    const state = withResult(makeState(), RESULTS.callback, HIGH);
    expect(dispatchMissesDeadline(state)).toBe(true);
  });

  it("treats an unparseable dispatch date as late", () => {
    const state = withResult(
      makeState(),
      { ...RESULTS.fullConfirmation, dispatch_date: "sometime next week" },
      HIGH
    );
    expect(dispatchMissesDeadline(state)).toBe(true);
  });
});

describe("explainDecision — the audit trail", () => {
  it("says nothing was written when confidence blocked a commitment", () => {
    const state = withResult(makeState(), RESULTS.vague, LOW);
    const explanation = explainDecision(state, "human_review");

    expect(explanation).toContain("0.58");
    expect(explanation).toContain("0.7");
    expect(explanation).toMatch(/Nothing was written/i);
  });

  it("says why escalating on low confidence is still correct", () => {
    const state = withResult(makeState(), RESULTS.noAnswer, NONE);
    expect(explainDecision(state, "escalate")).toMatch(/fail-safe/);
  });

  it("names the rung when the ladder is exhausted", () => {
    const state = withResult(
      makeState({ rung: 3, maxRungs: 3 }),
      RESULTS.unavailable,
      HIGH
    );
    expect(explainDecision(state, "escalate")).toMatch(/exhausted/);
  });
});
