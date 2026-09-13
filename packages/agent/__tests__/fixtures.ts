/**
 * packages/agent/__tests__/fixtures.ts
 * Shared test fixtures for the coordination agent.
 *
 * ⚠️  EVERYTHING HERE IS SYNTHETIC (Rule 8). None of it is real CALL-E output.
 * The numbers mirror the PRD §4.1 hero scenario — 200 cases of medical
 * supplies from Metro Supply Co. to Northgate Distributors — so a failing test
 * reads against the same story the demo tells.
 */

import type {
  Contact,
  Organization,
  OrderItem,
  Trigger,
  WholesaleResult,
  Confidence,
  WholesaleCoordinationContext,
} from "../../types";
import type { CoordinationState } from "../state";
import { createInitialState } from "../state";

export const BUYER: Organization = {
  id: "org-northgate",
  name: "Northgate Distributors",
  role: "DISTRIBUTOR",
};

export const SELLER: Organization = {
  id: "org-metro-supply",
  name: "Metro Supply Co.",
  role: "WHOLESALER",
};

export const ITEM: OrderItem = {
  sku: "MED-TS-CASE",
  description: "temperature-sensitive medical supplies",
  unit: "cases",
  requestedQuantity: 200,
  confirmedQuantity: null,
  remainingQuantity: null,
  unitPrice: 1850,
  currency: "INR",
};

export const TRIGGER: Trigger = {
  type: "INVENTORY",
  summary: "Available stock fell below the reorder point.",
  receivedAt: "2026-09-13T04:00:00.000Z",
};

/** A contact who is always callable: 24h window, consented, no cooldown. */
export function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "ct-rajesh-iyer",
    organizationId: SELLER.id,
    name: "Rajesh Iyer",
    role: "Dispatch Lead",
    phoneE164: "+919820000207",
    productCategories: ["medical-supplies"],
    region: "West",
    workingHours: { start: "00:00", end: "23:59", timezone: "Asia/Kolkata" },
    escalationPriority: 1,
    preferredLanguage: "en-IN",
    consentAt: "2026-09-01T00:00:00.000Z",
    cooldownUntil: null,
    ...overrides,
  };
}

export const PRIMARY = makeContact();

export const BACKUP = makeContact({
  id: "ct-priya-nair",
  name: "Priya Nair",
  role: "Sales Manager",
  phoneE164: "+919820000208",
  escalationPriority: 2,
});

export const SUPERVISOR = makeContact({
  id: "ct-vikram-shah",
  name: "Vikram Shah",
  role: "Operations Head",
  phoneE164: "+919820000209",
  escalationPriority: 3,
});

export const LADDER = [PRIMARY, BACKUP, SUPERVISOR];

export function makeContext(
  overrides: Partial<WholesaleCoordinationContext> = {}
): WholesaleCoordinationContext {
  return {
    orderId: "CR-1007",
    traceId: "trace-cr-1007",
    reference: "ORD-482",
    urgency: "URGENT",
    // 6 hours out — comfortably URGENT under FR-2.2.
    requiredBy: "2026-09-13T12:30:00.000Z",
    buyer: BUYER,
    seller: SELLER,
    item: ITEM,
    trigger: TRIGGER,
    rung: 1,
    ...overrides,
  };
}

/** A state mid-run: a contact selected, ready for a call result to be applied. */
export function makeState(overrides: Partial<CoordinationState> = {}): CoordinationState {
  return {
    ...createInitialState(makeContext()),
    currentContact: PRIMARY,
    ...overrides,
  };
}

/** Applies a call result to a state, as execute_call would. */
export function withResult(
  state: CoordinationState,
  result: WholesaleResult,
  confidence: Confidence = { score: 0.91, label: "high" },
  evidence: string[] = ["[FIXTURE] synthetic evidence"]
): CoordinationState {
  return {
    ...state,
    structuredResults: [...state.structuredResults, result],
    confidenceHistory: [...state.confidenceHistory, confidence],
    callHistory: [
      ...state.callHistory,
      {
        callId: `call-${state.callHistory.length + 1}`,
        orderId: state.orderId,
        contactId: state.currentContact?.id ?? "",
        rung: state.rung,
        state: "completed",
        taskCompleted: true,
        confidenceScore: confidence.score,
        confidenceLabel: confidence.label,
        evidence,
        structuredResult: result,
        startedAt: "2026-09-13T06:00:00.000Z",
        endedAt: "2026-09-13T06:01:00.000Z",
        durationSeconds: 60,
        traceId: state.traceId,
      },
    ],
  };
}

// ─── Result fixtures, one per PRD §9 outcome ─────────────────────────────────

export const RESULTS = {
  fullConfirmation: {
    contact_reached: "yes",
    stock_status: "confirmed",
    confirmed_quantity: 200,
    unit_price: 1850,
    currency: "INR",
    dispatch_date: "2026-09-13T11:00:00.000Z",
    verbatim_commitment: "[FIXTURE] All 200 are here, going out this evening.",
    next_action: "CONFIRM_ORDER",
  },

  partialStock: {
    contact_reached: "yes",
    stock_status: "partial",
    confirmed_quantity: 120,
    remaining_quantity: 80,
    unit_price: 1850,
    currency: "INR",
    dispatch_date: "2026-09-13T11:00:00.000Z",
    delivery_eta: "tomorrow morning for the balance",
    verbatim_commitment: "[FIXTURE] 120 today and the remaining 80 tomorrow morning.",
    next_action: "PARTIAL_CONFIRMATION",
  },

  priceChange: {
    contact_reached: "yes",
    stock_status: "confirmed",
    confirmed_quantity: 200,
    unit_price: 2050,
    currency: "INR",
    requires_approval: true,
    verbatim_commitment: "[FIXTURE] It's 2050 a case now, not 1850.",
    next_action: "REQUEST_APPROVAL",
  },

  /** A price change the model reported WITHOUT setting requires_approval. */
  sneakyPriceChange: {
    contact_reached: "yes",
    stock_status: "confirmed",
    confirmed_quantity: 200,
    unit_price: 2050,
    currency: "INR",
    verbatim_commitment: "[FIXTURE] Sure, 200 cases, 2050 each.",
    next_action: "CONFIRM_ORDER",
  },

  noAnswer: {
    contact_reached: "no",
    stock_status: "unknown",
    next_action: "ESCALATE_NEXT_CONTACT",
  },

  voicemail: {
    contact_reached: "voicemail",
    stock_status: "unknown",
    next_action: "ESCALATE_NEXT_CONTACT",
  },

  wrongPerson: {
    contact_reached: "wrong_person",
    stock_status: "unknown",
    next_action: "ESCALATE_NEXT_CONTACT",
  },

  unavailable: {
    contact_reached: "yes",
    stock_status: "unavailable",
    confirmed_quantity: 0,
    remaining_quantity: 200,
    delay_reason: "[FIXTURE] Out of stock until next week's shipment.",
    next_action: "ESCALATE_NEXT_CONTACT",
  },

  callback: {
    contact_reached: "yes",
    stock_status: "unknown",
    callback_requested_at: "2026-09-13T10:30:00.000Z",
    verbatim_commitment: "[FIXTURE] Call me at four.",
    next_action: "SCHEDULE_CALLBACK",
  },

  /** Vague: next_action would COMMIT, but confidence is below threshold. */
  vague: {
    contact_reached: "yes",
    stock_status: "unknown",
    verbatim_commitment: "[FIXTURE] Should be fine, sometime this week.",
    next_action: "CONFIRM_ORDER",
  },

  /** 120 + 100 against a 200-case order — does not reconcile. */
  conflictingQuantities: {
    contact_reached: "yes",
    stock_status: "partial",
    confirmed_quantity: 120,
    remaining_quantity: 100,
    next_action: "PARTIAL_CONFIRMATION",
  },

  explicitReview: {
    contact_reached: "yes",
    stock_status: "unknown",
    verbatim_commitment: "[FIXTURE] You'll need to speak to accounts about this.",
    next_action: "HUMAN_REVIEW",
  },
} satisfies Record<string, WholesaleResult>;

export const HIGH: Confidence = { score: 0.91, label: "high" };
export const LOW: Confidence = { score: 0.58, label: "low" };
export const NONE: Confidence = { score: 0.0, label: "none" };
