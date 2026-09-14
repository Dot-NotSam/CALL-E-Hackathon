/**
 * packages/agent/nodes/humanReview.ts
 * Node: human_review
 * Owner: Aryan
 *
 * Parks the order for an operator decision. Exits to: END.
 *
 * FR-5.6. This is where PRD §6's "ambiguous results auto-closed: 0%" target is
 * actually met — everything the agent cannot stand behind ends up here rather
 * than being written to the order.
 *
 * The order is parked with `confirmedQuantity: null` and
 * `remainingQuantity: null` DELIBERATELY (contract doc §5.3). A number the
 * agent is not confident about must not appear on the order at all: the
 * dashboard shows the claim as *claimed*, never as secured.
 *
 * The operator resumes through POST /orders/:id/override or
 * POST /orders/:id/approval (Sameer's endpoints).
 */

import type { CoordinationState } from "../state";
import type { OrderOutcome, WholesaleResult } from "../../types";
import { lastStructuredResult, lastConfidence } from "../state";
import { HUMAN_REVIEW_THRESHOLD } from "../../types";
import { reconcileQuantities, priceChanged } from "./decide";

export interface HumanReviewCallbacks {
  /** Parks the order with everything the operator needs to decide. */
  parkOrder: (params: {
    orderId: string;
    traceId: string;
    reason: string;
    confidenceScore: number;
    /** CALL-E's structured result, stored verbatim even though it is not trusted. */
    structuredResult: WholesaleResult | null;
    evidence: string[];
  }) => Promise<void>;
  /** Emits `order.updated` with status HUMAN_REVIEW. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
  alertOperator?: (params: {
    orderId: string;
    reference: string;
    reason: string;
  }) => Promise<void>;
}

export async function humanReview(
  state: CoordinationState,
  callbacks: HumanReviewCallbacks
): Promise<Partial<CoordinationState>> {
  const result = lastStructuredResult(state);
  const confidence = lastConfidence(state);
  const evidence = state.callHistory[state.callHistory.length - 1]?.evidence ?? [];

  const reason = buildReviewReason(state);

  await callbacks.parkOrder({
    orderId: state.orderId,
    traceId: state.traceId,
    reason,
    confidenceScore: confidence?.score ?? 0,
    structuredResult: result,
    evidence,
  });

  const outcome: OrderOutcome = {
    orderId: state.orderId,
    contactId: state.currentContact?.id ?? null,
    status: "HUMAN_REVIEW",
    committed: false,
    // Null, not the extracted values. See the file header — this is the rule
    // that stops a 0.58-confidence "should be fine" becoming a stock position.
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: null,
    dispatchDate: null,
    deliveryEta: null,
    summary: reason,
    operatorMinutesSaved: null,
  };

  await callbacks.updateOrder(outcome);

  await callbacks.alertOperator?.({
    orderId: state.orderId,
    reference: state.reference,
    reason,
  });

  return { finalOutcome: outcome, requiresHumanReview: true };
}

/**
 * Why this order needs a person. Shown verbatim in the outcome strip, so it
 * has to read as an explanation rather than an error code.
 */
function buildReviewReason(state: CoordinationState): string {
  const confidence = lastConfidence(state);
  const result = lastStructuredResult(state);
  const who = state.currentContact?.name ?? state.seller.name;

  if (state.callError) {
    return `The call to ${who} could not be completed: ${state.callError}`;
  }

  if (!confidence || !result) {
    return "No usable call result was returned. A person needs to make this call.";
  }

  // Conflicting quantities — PRD §9. Both statements are preserved above.
  const quantities = reconcileQuantities(state);
  if (quantities.conflicting && quantities.note) {
    return quantities.note;
  }

  if (confidence.score < HUMAN_REVIEW_THRESHOLD) {
    const claimed = result.verbatim_commitment
      ? ` They said: "${result.verbatim_commitment}".`
      : "";

    return (
      `${who} did not give a clear answer — extraction confidence ${confidence.score}, ` +
      `below the ${HUMAN_REVIEW_THRESHOLD} threshold.${claimed} ` +
      "Nothing has been written to the order."
    );
  }

  if (priceChanged(state)) {
    return (
      `${who} quoted ${result.unit_price} ${result.currency ?? state.item.currency} ` +
      `against ${state.item.unitPrice} on the order. A person must decide.`
    );
  }

  if (result.next_action === "HUMAN_REVIEW") {
    const verbatim = result.verbatim_commitment
      ? ` Verbatim: "${result.verbatim_commitment}".`
      : "";
    return `The call produced an outcome the agent will not action on its own.${verbatim}`;
  }

  return `Routed to review after the call with ${who}.`;
}
