/**
 * packages/agent/nodes/escalate.ts
 * Node: escalate
 * Owner: Aryan
 *
 * Advances to the next contact on the supplier's ladder and raises urgency.
 * Exits to: "select_contact" | "unresolved" (when the ladder is exhausted)
 *
 * This node owns the rung cap. `decide` routes here without re-deriving it, so
 * the cap exists in exactly one place (PRD §18: max 3 rungs).
 */

import type { CoordinationState } from "../state";
import { lastStructuredResult } from "../state";

export type EscalateResult = "select_contact" | "unresolved";

export interface EscalateOutcome {
  nextNode: EscalateResult;
  updatedState: Partial<CoordinationState>;
  reason: string;
}

export function escalate(state: CoordinationState): EscalateOutcome {
  const nextRung = state.rung + 1;

  // ── Record the attempt first ──────────────────────────────────────────────
  // This happens even when the ladder is exhausted: the contact on the final
  // rung was still called, and the UNRESOLVED alert must name everyone tried.
  const attemptedContacts = state.currentContact
    ? [...state.attemptedContacts, state.currentContact.id]
    : state.attemptedContacts;

  const why = escalationReason(state);

  // ── Rung cap ──────────────────────────────────────────────────────────────
  if (nextRung > state.maxRungs) {
    return {
      nextNode: "unresolved",
      updatedState: { attemptedContacts },
      reason:
        `${why} Rung cap reached (${state.rung}/${state.maxRungs}) — no contacts left.`,
    };
  }

  return {
    nextNode: "select_contact",
    updatedState: {
      rung: nextRung,
      attemptedContacts,
      // Cleared so select_contact must choose afresh. Leaving the previous
      // contact here would let a failure re-dial the same person.
      currentContact: null,
    },
    reason: `${why} Advancing to rung ${nextRung} of ${state.maxRungs}.`,
  };
}

/**
 * Why this order is escalating, in the supplier's own terms where we have them.
 * This text lands on the `order.escalated` event, which is what makes the
 * ladder animation on the dashboard legible rather than decorative.
 */
function escalationReason(state: CoordinationState): string {
  if (state.callError) {
    return `Call to ${contactName(state)} failed: ${state.callError}.`;
  }

  const result = lastStructuredResult(state);
  if (!result) {
    return `No usable result from ${contactName(state)}.`;
  }

  switch (result.contact_reached) {
    case "no":
      return `${contactName(state)} did not answer.`;
    case "voicemail":
      return `Reached voicemail for ${contactName(state)}; no details were left.`;
    case "wrong_person":
      return `Someone other than ${contactName(state)} answered; no details were disclosed.`;
    default:
      break;
  }

  if (result.stock_status === "unavailable") {
    return (
      `${contactName(state)} cannot supply` +
      (result.delay_reason ? `: ${result.delay_reason}` : ".")
    );
  }

  return `${contactName(state)} produced no usable commitment.`;
}

function contactName(state: CoordinationState): string {
  return state.currentContact?.name ?? "the contact";
}
