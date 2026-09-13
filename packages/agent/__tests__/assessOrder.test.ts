/**
 * packages/agent/__tests__/assessOrder.test.ts
 *
 * FR-2.1/2.2/2.3 — the gate that decides whether anyone's phone rings.
 * Duplicate suppression runs here, BEFORE a call is planned, which is what
 * stops a repeated order event costing a credit (contract §5.5).
 */

import { assessOrder, urgencyFor, findDuplicate } from "../nodes/assessOrder";
import type { DuplicateCandidate } from "../nodes/assessOrder";
import { makeState, SELLER } from "./fixtures";

const NOW = new Date("2026-09-13T06:00:00.000Z");

function candidate(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id: "CR-1001",
    reference: "ORD-479",
    sellerId: SELLER.id,
    sku: "MED-TS-CASE",
    status: "PARTIALLY_CONFIRMED",
    createdAt: "2026-09-13T04:02:00.000Z",
    ...overrides,
  };
}

describe("urgencyFor (FR-2.2)", () => {
  it("is URGENT inside 24 hours", () => {
    expect(urgencyFor("2026-09-13T18:00:00.000Z", NOW)).toBe("URGENT");
  });

  it("is PRIORITY inside 72 hours", () => {
    expect(urgencyFor("2026-09-15T06:00:00.000Z", NOW)).toBe("PRIORITY");
  });

  it("is ROUTINE beyond 72 hours", () => {
    expect(urgencyFor("2026-09-20T06:00:00.000Z", NOW)).toBe("ROUTINE");
  });

  it("is URGENT when the deadline has already passed", () => {
    expect(urgencyFor("2026-09-12T06:00:00.000Z", NOW)).toBe("URGENT");
  });

  it("falls back to PRIORITY on an unparseable date rather than guessing either extreme", () => {
    expect(urgencyFor("next Tuesday", NOW)).toBe("PRIORITY");
  });
});

describe("assessOrder — proceeding", () => {
  it("sends a real order to contact selection", () => {
    const outcome = assessOrder(makeState(), { now: NOW });

    expect(outcome.route).toBe("select_contact");
    expect(outcome.duplicateOf).toBeNull();
    expect(outcome.reason).toContain("200 cases");
  });

  it("recomputes urgency rather than trusting the state it was given", () => {
    // The order was raised as ROUTINE, but the required date is 6 hours out.
    const state = makeState({ urgency: "ROUTINE" });
    expect(assessOrder(state, { now: NOW }).urgency).toBe("URGENT");
  });
});

describe("assessOrder — suppression", () => {
  it("suppresses an order with nothing to confirm", () => {
    const state = makeState({ item: { ...makeState().item, requestedQuantity: 0 } });
    const outcome = assessOrder(state, { now: NOW });

    expect(outcome.route).toBe("suppress");
    expect(outcome.reason).toMatch(/nothing to confirm/i);
  });

  it("suppresses a repeat of the same business reference", () => {
    const state = makeState();
    const outcome = assessOrder(state, {
      now: NOW,
      existingOrders: [candidate({ reference: "ORD-482", id: "CR-1001" })],
    });

    expect(outcome.route).toBe("suppress");
    expect(outcome.duplicateOf).toBe("ORD-482");
  });

  it("suppresses a second request for the same SKU to the same seller", () => {
    const outcome = assessOrder(makeState(), {
      now: NOW,
      existingOrders: [candidate()],
    });

    expect(outcome.route).toBe("suppress");
    expect(outcome.duplicateOf).toBe("ORD-479");
    expect(outcome.reason).toMatch(/118 min ago/);
    expect(outcome.reason).toMatch(/partially confirmed/);
  });

  it("does NOT suppress against an order that ended without a commitment", () => {
    // UNRESOLVED and HUMAN_REVIEW are deliberately not covering statuses — the
    // first attempt produced nothing, so a retry must be allowed.
    for (const status of ["UNRESOLVED", "HUMAN_REVIEW"] as const) {
      const outcome = assessOrder(makeState(), {
        now: NOW,
        existingOrders: [candidate({ status })],
      });
      expect(outcome.route).toBe("select_contact");
    }
  });

  it("does not suppress against a different seller", () => {
    const outcome = assessOrder(makeState(), {
      now: NOW,
      existingOrders: [candidate({ sellerId: "org-someone-else" })],
    });

    expect(outcome.route).toBe("select_contact");
  });

  it("does not suppress against a different SKU", () => {
    const outcome = assessOrder(makeState(), {
      now: NOW,
      existingOrders: [candidate({ sku: "MED-OTHER" })],
    });

    expect(outcome.route).toBe("select_contact");
  });

  it("never suppresses an order against itself", () => {
    const outcome = assessOrder(makeState(), {
      now: NOW,
      existingOrders: [candidate({ id: "CR-1007", reference: "ORD-482" })],
    });

    expect(outcome.route).toBe("select_contact");
  });
});

describe("findDuplicate — precedence", () => {
  it("prefers a same-reference match over a same-SKU one", () => {
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1001", reference: "ORD-479" }),
      candidate({ id: "CR-1002", reference: "ORD-482" }),
    ]);

    expect(duplicate?.reference).toBe("ORD-482");
  });

  it("picks the most recent when several SKU matches exist", () => {
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1001", reference: "ORD-470", createdAt: "2026-09-12T04:00:00.000Z" }),
      candidate({ id: "CR-1002", reference: "ORD-479", createdAt: "2026-09-13T04:02:00.000Z" }),
    ]);

    expect(duplicate?.reference).toBe("ORD-479");
  });

  // The status filter used to guard only the SKU rule, so an earlier request
  // carrying the same reference suppressed this one whatever state it ended
  // in — and UNRESOLVED and HUMAN_REVIEW are excluded from COVERING_STATUSES
  // precisely so a fresh attempt IS allowed.

  it("does NOT suppress a retry of a reference that ended UNRESOLVED", () => {
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1002", reference: "ORD-482", status: "UNRESOLVED" }),
    ]);

    expect(duplicate).toBeNull();
  });

  it("does NOT suppress a retry of a reference parked for human review", () => {
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1002", reference: "ORD-482", status: "HUMAN_REVIEW" }),
    ]);

    expect(duplicate).toBeNull();
  });

  it("still suppresses a reference that IS already covered", () => {
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1002", reference: "ORD-482", status: "CONFIRMED" }),
    ]);

    expect(duplicate?.id).toBe("CR-1002");
  });

  it("falls through to the SKU rule when the reference match is not covering", () => {
    // An unresolved ORD-482 must not mask a live call for the same goods.
    const duplicate = findDuplicate(makeState(), [
      candidate({ id: "CR-1002", reference: "ORD-482", status: "UNRESOLVED" }),
      candidate({ id: "CR-1003", reference: "ORD-490", status: "CALLING" }),
    ]);

    expect(duplicate?.id).toBe("CR-1003");
  });
});
