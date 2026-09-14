/**
 * packages/agent/nodes/decideCoordination.ts
 * Node: decide (wholesale coordination)
 * Owner: Aryan
 *
 * THE most important node. Routes the graph on CALL-E's extracted result.
 * 100% deterministic code — NOT an LLM call (CLAUDE.md §5.3). The model already
 * did its job inside the conversation; routing on its output must be
 * predictable and testable.
 *
 * Invariants:
 *   1. Confidence below HUMAN_REVIEW_THRESHOLD never lets the agent close or
 *      commercially alter an order. It overrides every action except
 *      ESCALATE_NEXT_CONTACT — see COMMITTING_ACTIONS.
 *   2. The rung cap is enforced here, not in the prompt.
 *   3. A price change is never auto-accepted, at any confidence (FR-5.3).
 *   4. Every branch is reachable and has a test.
 *
 * Exits to:
 *   "confirm" | "partial" | "escalate" | "human_review"
 *   | "schedule_callback" | "request_approval"
 */

import type { CoordinationState } from "../coordinationState";
import { lastWholesaleResult, lastCoordinationConfidence } from "../coordinationState";
import { HUMAN_REVIEW_THRESHOLD } from "../../types/wholesale";

export type CoordinationDecision =
  | "confirm"
  | "partial"
  | "escalate"
  | "human_review"
  | "schedule_callback"
  | "request_approval";

/**
 * Actions that commit the business to something — closing the order, booking
 * stock, or promising a callback. A shaky extraction must never trigger one;
 * that is what FR-6.3 protects.
 *
 * ESCALATE_NEXT_CONTACT is deliberately absent. Escalating on a low-confidence
 * result is fail-safe — we simply try the next human. Parking it for an
 * operator is fail-dangerous: a no-answer has confidence 0.0 by construction,
 * and §9 F1/F2/F9 require those to advance the ladder immediately rather than
 * wait for a person who may not be at their desk.
 */
const COMMITTING_ACTIONS = new Set([
  "CONFIRM_ORDER",
  "PARTIAL_CONFIRMATION",
  "SCHEDULE_CALLBACK",
  "REQUEST_APPROVAL",
]);

export function decideCoordination(state: CoordinationState): CoordinationDecision {
  const result = lastWholesaleResult(state);
  const confidence = lastCoordinationConfidence(state);

  // ── Guard: should never happen if execute_call ran correctly ──────────────
  if (!result || !confidence) {
    console.error(
      `decideCoordination: missing structuredResult or confidence for order ${state.orderId}. ` +
        "Routing to human_review."
    );
    return "human_review";
  }

  // ── Invariant 1: low confidence blocks any commitment (FR-6.3) ────────────
  if (
    confidence.score < HUMAN_REVIEW_THRESHOLD &&
    COMMITTING_ACTIONS.has(result.next_action)
  ) {
    return "human_review";
  }

  // ── Invariant 3: a price change is a person's call, always (FR-5.3) ───────
  // Checked before the switch so it cannot be routed around by next_action.
  // The agent is allowed to *hear* a new price; it is never allowed to accept
  // one, no matter how confidently it was extracted.
  if (result.requires_approval === true) {
    return "request_approval";
  }

  // ── Route on next_action ──────────────────────────────────────────────────
  switch (result.next_action) {
    case "CONFIRM_ORDER":
      return "confirm";

    case "PARTIAL_CONFIRMATION":
      // FR-6.4 — partial stock is accepted, but the remainder is still owed.
      // The partial node books what was confirmed and schedules a follow-up
      // for the balance rather than closing the order outright.
      return "partial";

    case "REQUEST_APPROVAL":
      return "request_approval";

    case "SCHEDULE_CALLBACK":
      return "schedule_callback";

    case "HUMAN_REVIEW":
      return "human_review";

    case "ESCALATE_NEXT_CONTACT":
      // ── Invariant 2: rung cap enforced here, never in the prompt ──────────
      // The escalate node reads `ladderExhausted` and routes to unresolved.
      return "escalate";

    default: {
      // An unrecognised action means CALL-E returned something outside the
      // frozen schema. Never guess — hand it to a person.
      const unexpected: string = result.next_action;
      console.error(
        `decideCoordination: unknown next_action "${unexpected}" for order ${state.orderId}. ` +
          "Routing to human_review."
      );
      return "human_review";
    }
  }
}

/** Human-readable reason for the agent_events row and the audit timeline. */
export function explainCoordinationDecision(
  state: CoordinationState,
  decision: CoordinationDecision
): string {
  const result = lastWholesaleResult(state);
  const confidence = lastCoordinationConfidence(state);

  if (!result || !confidence) {
    return "No structured result was extracted from the call — routed to human review.";
  }

  const pct = Math.round(confidence.score * 100);

  switch (decision) {
    case "human_review":
      if (confidence.score < HUMAN_REVIEW_THRESHOLD) {
        return (
          `Extraction confidence ${pct}% is below the ${Math.round(
            HUMAN_REVIEW_THRESHOLD * 100
          )}% threshold — "${result.next_action}" was not applied automatically.`
        );
      }
      return "The call did not produce a usable commitment — routed to human review.";

    case "request_approval":
      return result.unit_price !== undefined
        ? `A unit price of ${result.unit_price} was quoted. Price changes need a person to approve them.`
        : "The supplier raised a commercial change the agent may not accept.";

    case "confirm":
      return `Stock confirmed at ${pct}% confidence${
        result.dispatch_date ? `, dispatching ${result.dispatch_date}` : ""
      }.`;

    case "partial":
      return (
        `Partial confirmation: ${result.confirmed_quantity ?? "some"} units now, ` +
        `${result.remaining_quantity ?? "the balance"} outstanding.`
      );

    case "schedule_callback":
      return result.callback_requested_at
        ? `Contact asked to be called back at ${result.callback_requested_at}.`
        : "Contact asked to be called back.";

    case "escalate":
      return state.rung >= state.maxRungs
        ? `Contact ladder exhausted after ${state.rung} of ${state.maxRungs} rungs.`
        : `No commitment from rung ${state.rung} — advancing to the next contact.`;
  }
}
