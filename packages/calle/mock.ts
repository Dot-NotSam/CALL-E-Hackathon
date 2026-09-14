/**
 * packages/calle/mock.ts
 * Mock CALL-E driver for development and testing.
 * Owner: Aryan
 *
 * ⚠️  THIS IS A DEV HARNESS. It must NEVER appear in:
 *     - The demo recording
 *     - The deployed app
 *     - Any test fixture labelled as real output
 *
 * It satisfies the identical interface as the real SDK (FR-4.5) so five people
 * can build in parallel without spending live calls.
 *
 * Scenario names match the dashboard's replay scenarios in
 * `apps/web/src/lib/mock/scenarios/` one for one, so a scenario triggered in
 * the simulator and a scenario driven through the agent tell the same story.
 *
 * Usage:
 *   import { mockCalle } from "../calle/mock";
 *   await mockCalle.runCall({ task, resultSchema }, "partial_stock", hooks);
 */

import type { WholesaleResult, CallState } from "../types";
import type { CallProgressHooks } from "./progress";

export type MockScenario =
  /** The hero path: 120 of 200 today, the rest tomorrow morning. */
  | "partial_stock"
  /** Full quantity confirmed, dispatching today. */
  | "full_confirmation"
  /** Supplier quotes a higher price — must go to a human (FR-5.3). */
  | "price_change"
  /** Nobody picks up. Confidence 0.0 by construction — nobody spoke. */
  | "no_answer"
  /** Contact asks to be called back at a specific time. */
  | "callback_requested"
  /** "Should be fine" — vague after a second ask. Low confidence. */
  | "vague_answer"
  /** Supplier cannot supply at all. */
  | "unavailable"
  /** Voicemail picked up. Minimal message left, no order details. */
  | "voicemail"
  /** Someone other than the named contact answered. Details withheld. */
  | "wrong_person"
  /** An automated switchboard answered. The agent does not navigate menus. */
  | "gatekeeper"
  /** The line dropped mid-conversation. */
  | "call_drops";

interface MockCallResult {
  status: string;
  taskCompleted: boolean;
  completionConfidence: { score: number; label: string };
  evidence: string[];
  structuredResult: WholesaleResult;
}

/**
 * Fixture results. Every one of these is SYNTHETIC (Rule 8) — none is real
 * CALL-E output, and the transcripts below are prefixed [MOCK] so they can
 * never be mistaken for a real call in a screenshot.
 *
 * Quantities assume the hero order: 200 cases at 1850 INR.
 */
const SCENARIOS: Record<MockScenario, MockCallResult> = {
  partial_stock: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.91, label: "high" },
    evidence: [
      "The contact stated 120 cases were ready today.",
      "When asked about the balance, they committed to the remaining 80 tomorrow morning.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "partial",
      confirmed_quantity: 120,
      remaining_quantity: 80,
      unit_price: 1850,
      currency: "INR",
      dispatch_date: "2026-09-13T11:00:00.000Z",
      delivery_eta: "tomorrow morning for the balance",
      verbatim_commitment: "Yes, 120 today and the remaining 80 tomorrow morning.",
      next_action: "PARTIAL_CONFIRMATION",
    },
  },

  full_confirmation: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.94, label: "high" },
    evidence: [
      "The contact confirmed all 200 cases were in stock.",
      "Dispatch was committed for today's evening run.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      remaining_quantity: 0,
      unit_price: 1850,
      currency: "INR",
      dispatch_date: "2026-09-13T12:30:00.000Z",
      delivery_eta: "tomorrow by noon",
      verbatim_commitment: "All 200 are here, they'll go out on this evening's run.",
      next_action: "CONFIRM_ORDER",
    },
  },

  price_change: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.89, label: "high" },
    evidence: [
      "The contact quoted 2050 per case against the order's 1850.",
      "The agent recorded the new price and did not accept it.",
      "Stock was confirmed available at the revised price.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      unit_price: 2050,
      currency: "INR",
      dispatch_date: "2026-09-13T12:30:00.000Z",
      requires_approval: true,
      verbatim_commitment: "We can do all 200, but it's 2050 a case now, not 1850.",
      next_action: "REQUEST_APPROVAL",
    },
  },

  no_answer: {
    status: "no_answer",
    taskCompleted: false,
    // 0.0 by construction: nobody spoke, so there is nothing to be confident
    // about. This is exactly why low confidence must not block escalation.
    completionConfidence: { score: 0.0, label: "none" },
    evidence: ["The call was not answered."],
    structuredResult: {
      contact_reached: "no",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  callback_requested: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.84, label: "medium" },
    evidence: [
      "The contact said they were on the floor and asked to be called at four.",
      "The agent confirmed the callback time before ending.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unknown",
      callback_requested_at: "2026-09-13T10:30:00.000Z",
      verbatim_commitment: "I'm on the floor right now — call me at four.",
      next_action: "SCHEDULE_CALLBACK",
    },
  },

  vague_answer: {
    status: "completed",
    taskCompleted: false,
    // Deliberately below HUMAN_REVIEW_THRESHOLD while next_action is a CLOSING
    // action. This is the fixture that proves the confidence rule wins.
    completionConfidence: { score: 0.58, label: "low" },
    evidence: [
      "The contact said stock 'should be fine' without confirming a quantity.",
      "Asked a second time for a concrete date, they said 'sometime this week'.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unknown",
      verbatim_commitment: "Should be fine, we'll get it out sometime this week.",
      next_action: "CONFIRM_ORDER",
    },
  },

  unavailable: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.88, label: "high" },
    evidence: [
      "The contact stated they have no stock of this SKU.",
      "They gave a restocking date beyond the buyer's required date.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unavailable",
      confirmed_quantity: 0,
      remaining_quantity: 200,
      delay_reason: "Out of stock until the next shipment lands next week.",
      verbatim_commitment: "We're out entirely, nothing until next week's shipment.",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  voicemail: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.12, label: "low" },
    evidence: [
      "Voicemail answered. A minimal callback message was left.",
      "No order reference, quantity or price was disclosed on the recording.",
    ],
    structuredResult: {
      contact_reached: "voicemail",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  wrong_person: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.31, label: "low" },
    evidence: [
      "The person who answered was not the named contact.",
      "The agent asked only whether the contact was reachable and disclosed nothing.",
    ],
    structuredResult: {
      contact_reached: "wrong_person",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  gatekeeper: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.22, label: "low" },
    evidence: [
      "An automated switchboard answered and offered a menu of options.",
      "No human was reached. The agent did not navigate the menu.",
    ],
    structuredResult: {
      contact_reached: "no",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  call_drops: {
    status: "failed",
    taskCompleted: false,
    completionConfidence: { score: 0.0, label: "none" },
    evidence: ["The call dropped mid-conversation."],
    structuredResult: {
      contact_reached: "unknown",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },
};

/**
 * The `call.state` sequence each scenario walks through.
 *
 * ⚠️  THESE MATCH WHAT CALL-E ACTUALLY DOES, not what we wish it did.
 *
 * Verified against live calls on 2026-09-08/09 (docs/CALLE_TESTING_LOG.md
 * F-003, F-006). Two things a UI author needs to know:
 *
 *   - `connected` NEVER fires. The attempt goes straight from absent to
 *     `in_progress` to terminal; CALL-E exposes no "answered but not yet
 *     talking" signal.
 *   - `in_conversation` only fires once a transcript turn exists — and turns
 *     arrive in ONE BURST at completion, not during the call. So on a real
 *     call it is effectively skipped too.
 *
 * A dashboard built against an idealised sequence will show states that never
 * arrive in the demo. Set SENTINEL_MOCK_OPTIMISTIC=true to replay the fuller
 * sequence while developing those components — but do not ship a UI that
 * depends on it.
 */
const OBSERVED_TALKING: CallState[] = ["queued", "dialling", "extracting", "completed"];
const OPTIMISTIC_TALKING: CallState[] = [
  "queued", "dialling", "connected", "in_conversation", "extracting", "completed",
];

function talkingSequence(): CallState[] {
  return process.env.SENTINEL_MOCK_OPTIMISTIC === "true"
    ? OPTIMISTIC_TALKING
    : OBSERVED_TALKING;
}

const STATE_SEQUENCES: Record<MockScenario, () => CallState[]> = {
  partial_stock:      talkingSequence,
  full_confirmation:  talkingSequence,
  price_change:       talkingSequence,
  callback_requested: talkingSequence,
  vague_answer:       talkingSequence,
  unavailable:        talkingSequence,
  voicemail:          talkingSequence,
  wrong_person:       talkingSequence,
  gatekeeper:         talkingSequence,
  // SIP 480/486 and friends — observed on a real call (F-009).
  no_answer:          () => ["queued", "dialling", "no_answer"],
  call_drops:         () => ["queued", "dialling", "failed"],
};

/**
 * Illustrative transcripts. Clearly synthetic — every line is [MOCK]-prefixed
 * because these are dev fixtures and must never be presented as real CALL-E
 * transcripts (Rule 8).
 *
 * The partial_stock exchange is the PRD §4.1 hero dialogue.
 */
const MOCK_TRANSCRIPTS: Partial<
  Record<MockScenario, { speaker: "AGENT" | "HUMAN"; text: string }[]>
> = {
  partial_stock: [
    // The identity exchange leads every scenario because the real prompt now
    // opens with it, and the dashboard renders these transcripts. A mock that
    // skips it would show reviewers a call the agent no longer makes.
    { speaker: "AGENT", text: "[MOCK] This is the automated operations line for Northgate Distributors. Am I speaking with Rajesh Iyer?" },
    { speaker: "HUMAN", text: "[MOCK] Yes, this is Rajesh." },
    { speaker: "AGENT", text: "[MOCK] Thank you. I'm calling about order 482 for 200 cases of medical supplies. Can Metro Supply confirm the available quantity and dispatch date?" },
    { speaker: "HUMAN", text: "[MOCK] We only have 120 cases ready today." },
    { speaker: "AGENT", text: "[MOCK] Thank you. Can you dispatch the 120 cases today and confirm when the remaining 80 will be available?" },
    { speaker: "HUMAN", text: "[MOCK] Yes, 120 today and the remaining 80 tomorrow morning." },
    { speaker: "AGENT", text: "[MOCK] So that I record this correctly: 120 cases dispatching today, 80 tomorrow morning, against order 482. Is that right?" },
    { speaker: "HUMAN", text: "[MOCK] That's right." },
  ],

  price_change: [
    { speaker: "AGENT", text: "[MOCK] This is the automated operations line for Northgate Distributors. Am I speaking with Rajesh Iyer?" },
    { speaker: "HUMAN", text: "[MOCK] Speaking." },
    { speaker: "AGENT", text: "[MOCK] Thank you. I'm calling about order 482 for 200 cases." },
    { speaker: "HUMAN", text: "[MOCK] We can do all 200, but it's 2050 a case now, not 1850." },
    { speaker: "AGENT", text: "[MOCK] Thank you, I've noted 2050 per case. That is a change from our order, so it needs approval on our side before I can confirm. Can you still reserve the stock while that is checked?" },
    { speaker: "HUMAN", text: "[MOCK] Sure, I'll hold them until end of day." },
  ],

  // Third-party protection, shown rather than asserted. Note what is NOT in
  // these lines: no order reference, no product, no quantity, no price. The
  // agent ends the call knowing less than it started with, which is correct.
  wrong_person: [
    { speaker: "AGENT", text: "[MOCK] This is the automated operations line for Northgate Distributors. Am I speaking with Rajesh Iyer?" },
    { speaker: "HUMAN", text: "[MOCK] No, he's not at this desk. What's it regarding?" },
    { speaker: "AGENT", text: "[MOCK] I'm trying to reach Rajesh Iyer at Metro Supply Co. Is this the right number, and when is he available?" },
    { speaker: "HUMAN", text: "[MOCK] Try after four. Who did you say is calling?" },
    { speaker: "AGENT", text: "[MOCK] Thank you, I'll call back after four." },
  ],

  vague_answer: [
    { speaker: "AGENT", text: "[MOCK] Can you confirm you have 200 cases available?" },
    { speaker: "HUMAN", text: "[MOCK] Yeah, should be fine." },
    { speaker: "AGENT", text: "[MOCK] Just so I record it correctly — is that dispatching today, tomorrow, or later this week?" },
    { speaker: "HUMAN", text: "[MOCK] We'll get it out sometime this week." },
  ],
};

/**
 * Simulates placing a call and following it to completion, emitting the same
 * progress hooks the real driver does (FR-4.3).
 *
 * `delayMs` is the total simulated call duration, spread across the states.
 */
async function runCall(
  _params: { task: string; resultSchema: unknown },
  scenario: MockScenario = "partial_stock",
  hooks: CallProgressHooks = {},
  delayMs = 1500
): Promise<MockCallResult> {
  const result = SCENARIOS[scenario];
  if (!result) throw new Error(`Unknown mock scenario: ${scenario}`);

  const states = STATE_SEQUENCES[scenario]();
  const callId = `mock-call-${scenario}`;
  const perState = Math.max(0, Math.floor(delayMs / states.length));

  // Turns arrive in one burst at completion, not during the call — CALL-E
  // publishes `transcriptTurns` only once the attempt finishes (F-006).
  // Under SENTINEL_MOCK_OPTIMISTIC they stream at `in_conversation` instead,
  // for developing a UI against a future streaming API.
  const optimistic = process.env.SENTINEL_MOCK_OPTIMISTIC === "true";
  const emitTurnsAt: CallState = optimistic ? "in_conversation" : "extracting";

  for (const state of states) {
    if (perState > 0) await new Promise((res) => setTimeout(res, perState));
    hooks.onState?.(state, callId);

    if (state === emitTurnsAt) {
      for (const turn of MOCK_TRANSCRIPTS[scenario] ?? []) {
        hooks.onTranscript?.({ ...turn, offsetSeconds: null }, callId);
      }
    }
  }

  return result;
}

/**
 * Simulates calle.calls.createAndWait() with a configurable scenario.
 * Retained for direct unit tests that don't care about live progress.
 */
async function createAndWait(
  params: { task: string; resultSchema: unknown },
  scenario: MockScenario = "partial_stock",
  delayMs = 1500
): Promise<MockCallResult> {
  return runCall(params, scenario, {}, delayMs);
}

export const mockCalle = {
  runCall,
  calls: {
    createAndWait,
  },
  _scenarios: SCENARIOS,        // exposed for tests
  _stateSequences: STATE_SEQUENCES,
};
