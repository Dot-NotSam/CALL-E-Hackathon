/**
 * VENDORED — do not edit.
 *
 * Generated from packages/agent/nodes/decide.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/agent/nodes/decide.ts
 * Node: decide
 * Owner: Aryan
 *
 * THE most important node. Routes the graph from CALL-E's structured output.
 * This is 100% deterministic code — NOT an LLM call (PRD §10.1).
 *
 * The model already did its job inside the conversation. Branching on its
 * output must be predictable, testable, and identical every time.
 *
 * Rule order is fixed and matches docs/FRONTEND_BACKEND_CONTRACT.md §2.2:
 *
 *   0. contact_reached != "yes"    → never commits (escalate, or review)
 *   1. confidence < 0.70          → human_review (beats every next_action)
 *   2. requires_approval / REQUEST_APPROVAL → approval
 *   3. CONFIRM_ORDER              → confirm
 *   4. PARTIAL_CONFIRMATION       → partial
 *   5. SCHEDULE_CALLBACK          → schedule_callback
 *   6. ESCALATE_NEXT_CONTACT      → escalate  (rung cap applied in escalate)
 *   7. HUMAN_REVIEW               → human_review
 *
 * Invariants:
 *   1. Low confidence never CLOSES an order — see CLOSING_ACTIONS.
 *   2. The rung cap is enforced in code, never in the prompt.
 *   3. A price change is never accepted autonomously (FR-5.3).
 *   4. An unverified answerer never commits the supplier (FR-7.4).
 *   5. Every branch is reachable and has a test.
 */

import type { CoordinationState } from "./state";
import { lastStructuredResult, lastConfidence } from "./state";
import { HUMAN_REVIEW_THRESHOLD } from "./types";

export type DecideResult =
  | "confirm"
  | "partial"
  | "approval"
  | "escalate"
  | "schedule_callback"
  | "human_review";

/**
 * Actions that COMMIT something to the order — a quantity, a price, a date.
 * A shaky extraction must never trigger one of these. That is what PRD §6's
 * "ambiguous results auto-closed: 0%" target protects.
 *
 * ESCALATE_NEXT_CONTACT is deliberately absent. An unanswered call has
 * confidence 0.0 by construction — nobody spoke — and parking it for an
 * operator strands the order. Escalating on a weak signal is fail-safe;
 * committing on one is not. So confidence gates *committing*, never *trying
 * the next human*.
 */
const CLOSING_ACTIONS = new Set([
  "CONFIRM_ORDER",
  "PARTIAL_CONFIRMATION",
  "REQUEST_APPROVAL",
  "SCHEDULE_CALLBACK",
]);

/**
 * Did the person on the call confirm they are the contact we meant to reach?
 *
 * Only an explicit "yes" counts. `wrong_person`, `voicemail` and `no` are
 * obviously not the contact; `unknown` means the question was never asked or
 * never clearly answered, which is also not a yes. Third-party protection is
 * only worth anything if the ambiguous case fails the check.
 */
function isVerifiedContact(contactReached: string): boolean {
  return contactReached === "yes";
}

export function decide(state: CoordinationState): DecideResult {
  const result = lastStructuredResult(state);
  const confidence = lastConfidence(state);

  // ── Guard: should never happen if execute_call ran correctly ─────────────
  if (!result || !confidence) {
    console.error(
      `decide: missing structuredResult or confidence for order ${state.orderId}. ` +
      "Routing to human_review."
    );
    return "human_review";
  }

  // ── Rule 0: an unverified answerer cannot commit the supplier ───────────
  // Ahead of confidence, because a wrong person can speak very confidently.
  //
  // OBSERVED (live calls #9 and #10): the agent opened by stating the order
  // reference, product and quantity to whoever picked up, never asked who they
  // were, and returned contact_reached "yes" — meaning "a human talked to me".
  // Nothing in the graph read that field, so an answer from the wrong person
  // would have been written to the order as a commitment.
  //
  // The prompt now asks first, but a prompt is not a control (SAFETY.md). This
  // is the control: no identity, no commitment. See isVerifiedContact.
  if (!isVerifiedContact(result.contact_reached) && CLOSING_ACTIONS.has(result.next_action)) {
    // "unknown" is the genuinely ambiguous case — we cannot tell whether the
    // question was asked and missed, or answered and misread — so a person
    // looks. The rest are clear enough to just try the next contact, which is
    // what the ladder is for.
    return result.contact_reached === "unknown" ? "human_review" : "escalate";
  }

  // ── Rule 1: low confidence blocks committing anything (FR-5.6) ──────────
  if (
    confidence.score < HUMAN_REVIEW_THRESHOLD &&
    CLOSING_ACTIONS.has(result.next_action)
  ) {
    return "human_review";
  }

  // ── Rule 2: a commercial change always goes to a person (FR-5.3) ────────
  // Checked BEFORE next_action, because `requires_approval` is the supplier
  // proposing new terms — and a model that sets it while still returning
  // CONFIRM_ORDER must not be able to talk the workflow into accepting them.
  if (result.requires_approval === true || result.next_action === "REQUEST_APPROVAL") {
    return "approval";
  }

  // ── Rules 3-7: route on next_action ─────────────────────────────────────
  switch (result.next_action) {
    case "CONFIRM_ORDER":
      return "confirm";

    case "PARTIAL_CONFIRMATION":
      return "partial";

    case "SCHEDULE_CALLBACK":
      return "schedule_callback";

    case "HUMAN_REVIEW":
      return "human_review";

    case "ESCALATE_NEXT_CONTACT":
      // The rung cap lives in escalate(), which owns both the cap check and
      // the attempt bookkeeping. Re-deriving it here would put the same rule
      // in two places.
      return "escalate";

    // REQUEST_APPROVAL has no case here: rule 2 above already returned for it,
    // and TypeScript narrows it out of this switch. Adding one is a type error.

    default:
      console.error(
        `decide: unknown next_action "${(result as { next_action: string }).next_action}" ` +
        `for order ${state.orderId}. Routing to human_review.`
      );
      return "human_review";
  }
}

// ─── Quantity reconciliation ─────────────────────────────────────────────────

/**
 * What the supplier actually committed to, reconciled against the order.
 *
 * CALL-E extracts what was *said*. This turns that into what can be *written*,
 * and it deliberately does not trust the two quantities to agree: a supplier
 * who says "120 today, 80 tomorrow" against a 200-case order is consistent,
 * but one who says "120 today, 100 tomorrow" is not, and quietly storing 220
 * against a 200-case order would corrupt the buyer's stock position.
 */
export interface ReconciledQuantities {
  confirmed: number | null;
  remaining: number | null;
  /** True when the supplier's numbers do not add up to the requested quantity. */
  conflicting: boolean;
  note: string | null;
}

export function reconcileQuantities(state: CoordinationState): ReconciledQuantities {
  const result = lastStructuredResult(state);
  const requested = state.item.requestedQuantity;

  if (!result) {
    return { confirmed: null, remaining: null, conflicting: false, note: null };
  }

  const confirmed = numberOrNull(result.confirmed_quantity);
  const statedRemaining = numberOrNull(result.remaining_quantity);

  if (confirmed === null && statedRemaining === null) {
    return { confirmed: null, remaining: null, conflicting: false, note: null };
  }

  // A confirmed quantity we can trust, with the remainder derived from the
  // order rather than taken on faith.
  if (confirmed !== null) {
    if (confirmed > requested) {
      return {
        confirmed: null,
        remaining: null,
        conflicting: true,
        note:
          `Supplier confirmed ${confirmed} ${state.item.unit} against a request for ` +
          `${requested}. Quantities do not reconcile — a person must check this.`,
      };
    }

    const derivedRemaining = requested - confirmed;

    if (statedRemaining !== null && statedRemaining !== derivedRemaining) {
      return {
        confirmed: null,
        remaining: null,
        conflicting: true,
        note:
          `Supplier stated ${confirmed} confirmed and ${statedRemaining} remaining, ` +
          `which does not sum to the ${requested} ${state.item.unit} requested ` +
          `(expected ${derivedRemaining} remaining).`,
      };
    }

    return {
      confirmed,
      remaining: derivedRemaining,
      conflicting: false,
      note: null,
    };
  }

  // Only a remainder was given — infer the confirmed quantity from it.
  if (statedRemaining !== null && statedRemaining <= requested) {
    return {
      confirmed: requested - statedRemaining,
      remaining: statedRemaining,
      conflicting: false,
      note: null,
    };
  }

  return {
    confirmed: null,
    remaining: null,
    conflicting: true,
    note:
      `Supplier stated ${statedRemaining} ${state.item.unit} remaining against a ` +
      `request for ${requested}. Quantities do not reconcile.`,
  };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─── FR-5.3 — price change detection ─────────────────────────────────────────

/**
 * True when the supplier quoted a price different from the one on the order.
 *
 * Computed in code rather than trusted from `requires_approval` alone: a model
 * that reports a new unit price while leaving the flag unset is exactly the
 * case that must not slip through into an auto-confirmation.
 */
export function priceChanged(state: CoordinationState): boolean {
  const quoted = lastStructuredResult(state)?.unit_price;
  if (typeof quoted !== "number" || !Number.isFinite(quoted)) return false;
  return quoted !== state.item.unitPrice;
}

/**
 * Whether the committed dispatch lands after the buyer needed the goods.
 * An unparseable or missing date counts as late: we cannot prove it is on
 * time, so we do not behave as though it is.
 */
export function dispatchMissesDeadline(state: CoordinationState): boolean {
  const dispatch = lastStructuredResult(state)?.dispatch_date;
  if (!dispatch) return true;

  const dispatchAt = new Date(dispatch).getTime();
  const requiredAt = new Date(state.requiredBy).getTime();
  if (Number.isNaN(dispatchAt) || Number.isNaN(requiredAt)) return true;

  return dispatchAt > requiredAt;
}

// ─── Audit explanation ───────────────────────────────────────────────────────

/** Human-readable reason for the routing decision. Written to agent_events. */
export function explainDecision(
  state: CoordinationState,
  decision: DecideResult
): string {
  const result = lastStructuredResult(state);
  const confidence = lastConfidence(state);

  if (!result || !confidence) {
    return "Missing result or confidence — routed to human_review as fallback.";
  }

  const base =
    `next_action="${result.next_action}", confidence=${confidence.score} (${confidence.label})`;

  if (!isVerifiedContact(result.contact_reached) && CLOSING_ACTIONS.has(result.next_action)) {
    return (
      `${base} → but contact_reached="${result.contact_reached}": the person on ` +
      `the call never confirmed they are the named contact, so "${result.next_action}" ` +
      "may not be written to the order. Nothing was committed."
    );
  }

  if (
    confidence.score < HUMAN_REVIEW_THRESHOLD &&
    CLOSING_ACTIONS.has(result.next_action)
  ) {
    return (
      `Confidence ${confidence.score} is below ${HUMAN_REVIEW_THRESHOLD} and ` +
      `"${result.next_action}" would commit to the order. → human_review. ` +
      "Nothing was written to the order."
    );
  }

  if (confidence.score < HUMAN_REVIEW_THRESHOLD) {
    return (
      `${base} → confidence is below ${HUMAN_REVIEW_THRESHOLD}, but escalating is ` +
      "fail-safe so the ladder advances rather than parking for an operator."
    );
  }

  switch (decision) {
    case "confirm":
      return `${base} → confirming ${result.confirmed_quantity ?? "the full quantity"} ${state.item.unit}.`;

    case "partial": {
      const { confirmed, remaining, conflicting } = reconcileQuantities(state);
      return conflicting
        ? `${base} → quantities do not reconcile; routing the partial to review.`
        : `${base} → partial: ${confirmed} ${state.item.unit} now, ${remaining} to follow.`;
    }

    case "approval":
      return (
        `${base} → supplier proposed ${result.unit_price ?? "a change"} ` +
        `${result.currency ?? state.item.currency} against ${state.item.unitPrice} ` +
        "on the order. The agent may not accept this (FR-5.3) → approval."
      );

    case "schedule_callback":
      return `${base} → callback at ${result.callback_requested_at ?? "the requested time"}.`;

    case "human_review":
      return `${base} → parking for operator review.`;

    case "escalate":
      return state.rung >= state.maxRungs
        ? `${base} → ladder exhausted (rung ${state.rung}/${state.maxRungs}) → UNRESOLVED.`
        : `${base} → advancing to rung ${state.rung + 1}.`;
  }
}
