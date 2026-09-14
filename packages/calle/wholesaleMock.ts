/**
 * packages/calle/wholesaleMock.ts
 * Mock CALL-E driver for the wholesale coordination agent.
 * Owner: Aryan
 *
 * The v2 counterpart of `./mock.ts`. It returns results in the wholesale
 * schema (`WHOLESALE_COORDINATION_RESULT_SCHEMA`) rather than the v1 escalation
 * one, so the graph is exercised against the shapes it will really see.
 *
 * ── This is a DEV HARNESS ────────────────────────────────────────────────────
 * CLAUDE.md Rule 1: it never appears in the demo, the recorded video, or the
 * deployed app. Every result below is INVENTED. Nothing here is a transcript of
 * a real call, and no confidence score here was produced by CALL-E — they are
 * hand-written so the failure branches can be driven without spending credits.
 */

import type { CallProgressHooks } from "./progress";
import type { CallState as SentinelCallState } from "../types";
import type { WholesaleResult } from "../types/wholesale";

export type WholesaleScenario =
  | "confirm_immediately" // stock on hand, dispatches tomorrow
  | "confirm_after_pushback" // "I'm slammed" → still commits to a date
  | "partial_stock" // some now, balance later
  | "price_change" // quotes a higher unit price → needs approval
  | "callback_requested" // asks to be called back at a set time
  | "vague_answer" // "should be fine" → low confidence
  | "no_answer" // nobody picks up
  | "voicemail" // answering machine
  | "wrong_person" // someone else answers
  | "out_of_stock"; // flat no, nothing available

export interface WholesaleMockResult {
  status: string;
  taskCompleted: boolean;
  completionConfidence: { score: number; label: string };
  evidence: string[];
  structuredResult: WholesaleResult;
}

/** FIXTURE DATA — invented, never a real call. */
const SCENARIOS: Record<WholesaleScenario, WholesaleMockResult> = {
  confirm_immediately: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.95, label: "high" },
    evidence: [
      "[FIXTURE] Supplier stated 200 units are in the warehouse.",
      "[FIXTURE] Supplier committed to dispatch on Tuesday.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      remaining_quantity: 0,
      dispatch_date: "Tuesday",
      verbatim_commitment: "All 200 are here, I'll send them Tuesday morning.",
      next_action: "CONFIRM_ORDER",
    },
  },

  // The money shot: the supplier says no, and the agent negotiates anyway.
  confirm_after_pushback: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.91, label: "high" },
    evidence: [
      "[FIXTURE] Supplier initially said they were too busy to check.",
      "[FIXTURE] Agent asked for a specific date; supplier committed to Thursday.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      remaining_quantity: 0,
      dispatch_date: "Thursday",
      verbatim_commitment: "Fine — Thursday, I'll have all 200 on the truck.",
      next_action: "CONFIRM_ORDER",
    },
  },

  partial_stock: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.88, label: "high" },
    evidence: [
      "[FIXTURE] Supplier confirmed 120 units available now.",
      "[FIXTURE] Remaining 80 expected the following week.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "partial",
      confirmed_quantity: 120,
      remaining_quantity: 80,
      dispatch_date: "Wednesday",
      delay_reason: "Awaiting their own inbound shipment.",
      verbatim_commitment: "I can do 120 Wednesday, the other 80 next week.",
      next_action: "PARTIAL_CONFIRMATION",
    },
  },

  // FR-5.3 — the agent must hand this to a person, never accept it.
  price_change: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.92, label: "high" },
    evidence: ["[FIXTURE] Supplier quoted 520 per unit, up from 450."],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      unit_price: 520,
      currency: "INR",
      requires_approval: true,
      delay_reason: "Supplier raised the unit price.",
      verbatim_commitment: "I can supply, but it's 520 a unit now.",
      next_action: "REQUEST_APPROVAL",
    },
  },

  callback_requested: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.86, label: "high" },
    evidence: ["[FIXTURE] Supplier asked to be called back after 4pm."],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unknown",
      callback_requested_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      verbatim_commitment: "Call me back after four, I'll have checked by then.",
      next_action: "SCHEDULE_CALLBACK",
    },
  },

  // FR-6.3 — deliberately below the 0.7 floor, so it must not auto-close.
  vague_answer: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.41, label: "low" },
    evidence: ["[FIXTURE] Supplier said 'should be fine' without a quantity or date."],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unknown",
      verbatim_commitment: "Yeah, should be fine.",
      next_action: "CONFIRM_ORDER",
    },
  },

  no_answer: {
    status: "no_answer",
    taskCompleted: false,
    completionConfidence: { score: 0, label: "none" },
    evidence: ["[FIXTURE] No answer after 6 rings."],
    structuredResult: {
      contact_reached: "no",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  voicemail: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.2, label: "low" },
    evidence: ["[FIXTURE] Reached voicemail; left order reference only."],
    structuredResult: {
      contact_reached: "voicemail",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  // F7 — order details are withheld from an unverified answerer.
  wrong_person: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.3, label: "low" },
    evidence: ["[FIXTURE] Answerer was not the named contact; no details disclosed."],
    structuredResult: {
      contact_reached: "wrong_person",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  out_of_stock: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.9, label: "high" },
    evidence: ["[FIXTURE] Supplier stated they hold none of this SKU."],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unavailable",
      confirmed_quantity: 0,
      delay_reason: "No stock of this SKU.",
      verbatim_commitment: "Nothing in the building, try someone else.",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },
};

/** The call-state sequence each scenario walks through. */
const STATE_SEQUENCES: Record<WholesaleScenario, SentinelCallState[]> = {
  confirm_immediately: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  confirm_after_pushback: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  partial_stock: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  price_change: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  callback_requested: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  vague_answer: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  no_answer: ["queued", "dialling", "no_answer"],
  voicemail: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  wrong_person: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
  out_of_stock: ["queued", "dialling", "connected", "in_conversation", "extracting", "completed"],
};

/** FIXTURE TRANSCRIPTS — written by hand, not produced by any real call. */
const TRANSCRIPTS: Partial<Record<WholesaleScenario, { speaker: "AGENT" | "HUMAN"; text: string }[]>> = {
  confirm_after_pushback: [
    { speaker: "AGENT", text: "This is an automated operations line calling for Northgate Distributors about order ORD-482." },
    { speaker: "HUMAN", text: "I'm in the middle of a delivery, can this wait?" },
    { speaker: "AGENT", text: "It's one question — can you dispatch 200 crates, and on what date?" },
    { speaker: "HUMAN", text: "Fine — Thursday, I'll have all 200 on the truck." },
    { speaker: "AGENT", text: "Thursday for all 200. Thank you, that's all I needed." },
  ],
  partial_stock: [
    { speaker: "AGENT", text: "This is an automated operations line calling about order ORD-482." },
    { speaker: "HUMAN", text: "I've only got about 120 in the building right now." },
    { speaker: "AGENT", text: "When would the remaining 80 be available?" },
    { speaker: "HUMAN", text: "I can do 120 Wednesday, the other 80 next week." },
  ],
  price_change: [
    { speaker: "AGENT", text: "This is an automated operations line calling about order ORD-482." },
    { speaker: "HUMAN", text: "I can supply, but it's 520 a unit now." },
    { speaker: "AGENT", text: "I'm not able to agree a price change. I'll pass that to the buyer." },
  ],
};

/**
 * Simulates placing a call and following it to completion, emitting the same
 * progress hooks the real driver does (FR-5.2).
 */
async function runCall(
  _params: { task: string; resultSchema: unknown },
  scenario: WholesaleScenario = "confirm_after_pushback",
  hooks: CallProgressHooks = {},
  delayMs = 1500,
): Promise<WholesaleMockResult> {
  const result = SCENARIOS[scenario];
  if (!result) throw new Error(`Unknown wholesale mock scenario: ${scenario}`);

  const states = STATE_SEQUENCES[scenario];
  const callId = `mock-wholesale-${scenario}`;
  const perState = Math.max(0, Math.floor(delayMs / states.length));

  // Turns arrive in one burst at extraction, not during the call — CALL-E
  // publishes `transcriptTurns` only once the attempt finishes (F-006).
  for (const state of states) {
    if (perState > 0) await new Promise((res) => setTimeout(res, perState));
    hooks.onState?.(state, callId);

    if (state === "extracting") {
      for (const turn of TRANSCRIPTS[scenario] ?? []) {
        hooks.onTranscript?.({ ...turn, offsetSeconds: null }, callId);
      }
    }
  }

  return result;
}

export const wholesaleMock = {
  runCall,
  _scenarios: SCENARIOS,
  _stateSequences: STATE_SEQUENCES,
};
