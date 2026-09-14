/**
 * packages/agent/__tests__/decideCoordination.test.ts
 *
 * The decide node is the one place where a mistake silently commits the
 * business to something a supplier never actually said. Every branch is
 * covered, and the two invariants that protect the operator — the confidence
 * floor and the price-approval gate — are tested against attempts to route
 * around them.
 */

import { decideCoordination } from "../nodes/decideCoordination";
import { createInitialCoordinationState, type CoordinationState } from "../coordinationState";
import type { Order, WholesaleResult, Confidence } from "../../types/wholesale";

const ORDER: Order = {
  id: "CR-1007",
  reference: "ORD-482",
  traceId: "tr_test01",
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
  trigger: { type: "ORDER", summary: "Reorder point reached", receivedAt: "2026-09-14T06:00:00.000Z" },
  createdAt: "2026-09-14T06:00:00.000Z",
  closedAt: null,
  currentRung: 1,
  maxRungs: 3,
  outcome: null,
  operatorMinutesSaved: null,
  scenarioId: "agent",
};

const HIGH: Confidence = { score: 0.94, label: "high" };
const LOW: Confidence = { score: 0.42, label: "low" };

function result(overrides: Partial<WholesaleResult> = {}): WholesaleResult {
  return {
    contact_reached: "yes",
    stock_status: "confirmed",
    next_action: "CONFIRM_ORDER",
    ...overrides,
  };
}

function stateWith(
  extracted: WholesaleResult,
  confidence: Confidence,
  patch: Partial<CoordinationState> = {},
): CoordinationState {
  return {
    ...createInitialCoordinationState(ORDER),
    structuredResults: [extracted],
    confidenceHistory: [confidence],
    ...patch,
  };
}

describe("decideCoordination — routing", () => {
  it("confirms a high-confidence full commitment", () => {
    expect(decideCoordination(stateWith(result(), HIGH))).toBe("confirm");
  });

  it("routes a partial confirmation to the partial node", () => {
    const extracted = result({
      next_action: "PARTIAL_CONFIRMATION",
      stock_status: "partial",
      confirmed_quantity: 120,
      remaining_quantity: 80,
    });
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("partial");
  });

  it("schedules a callback when the supplier asked for one", () => {
    const extracted = result({
      next_action: "SCHEDULE_CALLBACK",
      callback_requested_at: "2026-09-14T14:00:00.000Z",
    });
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("schedule_callback");
  });

  it("escalates when nobody committed", () => {
    const extracted = result({
      next_action: "ESCALATE_NEXT_CONTACT",
      contact_reached: "no",
      stock_status: "unknown",
    });
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("escalate");
  });

  it("parks an explicit HUMAN_REVIEW request", () => {
    expect(
      decideCoordination(stateWith(result({ next_action: "HUMAN_REVIEW" }), HIGH)),
    ).toBe("human_review");
  });
});

describe("decideCoordination — invariant 1: the confidence floor", () => {
  it.each([
    "CONFIRM_ORDER",
    "PARTIAL_CONFIRMATION",
    "SCHEDULE_CALLBACK",
  ] as const)("never lets a low-confidence %s commit the order", (next_action) => {
    expect(decideCoordination(stateWith(result({ next_action }), LOW))).toBe("human_review");
  });

  it("still escalates on low confidence — a no-answer scores 0 by construction", () => {
    const extracted = result({ next_action: "ESCALATE_NEXT_CONTACT", contact_reached: "no" });
    const noAnswer: Confidence = { score: 0, label: "none" };
    expect(decideCoordination(stateWith(extracted, noAnswer))).toBe("escalate");
  });

  it("treats the threshold as inclusive — exactly 0.7 is good enough", () => {
    const atThreshold: Confidence = { score: 0.7, label: "medium" };
    expect(decideCoordination(stateWith(result(), atThreshold))).toBe("confirm");
  });
});

describe("decideCoordination — invariant 2: the price gate (FR-5.3)", () => {
  it("routes a price change to approval even at high confidence", () => {
    const extracted = result({ requires_approval: true, unit_price: 520 });
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("request_approval");
  });

  it("cannot be routed around by a CONFIRM_ORDER next_action", () => {
    // The dangerous case: the model is certain, and says to close the order,
    // but also reports that a person must approve. The gate must win.
    const extracted = result({ next_action: "CONFIRM_ORDER", requires_approval: true, unit_price: 999 });
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("request_approval");
  });

  it("a low-confidence price change goes to review, not to approval", () => {
    const extracted = result({ requires_approval: true, unit_price: 520 });
    expect(decideCoordination(stateWith(extracted, LOW))).toBe("human_review");
  });
});

describe("decideCoordination — degraded input", () => {
  it("reviews when no result was extracted", () => {
    const state = { ...createInitialCoordinationState(ORDER) };
    expect(decideCoordination(state)).toBe("human_review");
  });

  it("reviews an unrecognised next_action rather than guessing", () => {
    const extracted = { ...result(), next_action: "SHIP_IT_ANYWAY" } as unknown as WholesaleResult;
    expect(decideCoordination(stateWith(extracted, HIGH))).toBe("human_review");
  });
});
