/**
 * VENDORED — do not edit.
 *
 * Generated from packages/agent/nodes/unresolved.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/agent/nodes/unresolved.ts
 * Node: unresolved
 * Owner: Aryan
 *
 * The ladder is exhausted — no contact at this supplier produced a commitment.
 * Raises a loud alert and closes the run. Exits to: END.
 *
 * This is the worst-case terminal state, and it must be LOUD. An order that
 * quietly ends UNRESOLVED is worse than one that was never raised: the buyer
 * believes coordination is in hand when nothing is.
 */

import type { CoordinationState } from "./state";
import type { OrderOutcome } from "./types";

export interface UnresolvedCallbacks {
  /** Emits `order.unresolved` and `order.updated`. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
  /** The loud part. Must reach a person, not a dashboard panel. */
  alertOperations: (params: {
    orderId: string;
    reference: string;
    traceId: string;
    reason: string;
  }) => Promise<void>;
}

export async function unresolved(
  state: CoordinationState,
  callbacks: UnresolvedCallbacks
): Promise<Partial<CoordinationState>> {
  const reason = buildReason(state);

  const outcome: OrderOutcome = {
    orderId: state.orderId,
    contactId: null,
    status: "UNRESOLVED",
    committed: false,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: null,
    dispatchDate: null,
    deliveryEta: null,
    summary: reason,
    operatorMinutesSaved: null,
  };

  await callbacks.updateOrder(outcome);
  await callbacks.alertOperations({
    orderId: state.orderId,
    reference: state.reference,
    traceId: state.traceId,
    reason,
  });

  return { finalOutcome: outcome };
}

function buildReason(state: CoordinationState): string {
  const attempted = state.attemptedContacts.length;

  // The kill switch and the call cap both land here without the ladder
  // actually being walked, so the message must not claim contacts were tried
  // when they were not.
  if (attempted === 0) {
    return (
      `No contact at ${state.seller.name} could be called for order ${state.reference}` +
      (state.callError ? `: ${state.callError}` : ".") +
      ` ${state.item.requestedQuantity} ${state.item.unit} of ${state.item.description} ` +
      "remain unconfirmed."
    );
  }

  return (
    `Escalation exhausted after ${attempted} contact${attempted === 1 ? "" : "s"} at ` +
    `${state.seller.name} (rung ${state.rung} of ${state.maxRungs}). ` +
    `${state.item.requestedQuantity} ${state.item.unit} of ${state.item.description} ` +
    `for order ${state.reference} remain unconfirmed — a person must take this over.`
  );
}
