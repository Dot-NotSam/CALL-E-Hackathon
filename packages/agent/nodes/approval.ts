/**
 * packages/agent/nodes/approval.ts
 * Node: approval
 * Owner: Aryan
 *
 * The supplier proposed a commercial change — almost always a new unit price.
 * The agent records it and stops. A person decides. Exits to: END.
 *
 * FR-5.3, PRD §17: the agent "must not invent prices, approve credit, accept
 * legal terms, or commit either business beyond the extracted authority and
 * configured limits."
 *
 * ── Why this is a node and not a prompt instruction ──────────────────────────
 *
 * The prompt does tell the model not to accept a price (see
 * `packages/calle/prompt.ts`), but an LLM instruction is not a safety control.
 * This node is what actually prevents a changed price reaching the order: the
 * only path that writes `unitPrice` is an explicit operator decision through
 * POST /orders/:id/approval. There is no autonomous branch that sets it.
 *
 * `APPROVAL_REQUIRED` is deliberately NOT terminal in the status machine — the
 * order is parked waiting on a person, and the backend resumes it when the
 * operator answers.
 */

import type { CoordinationState } from "../state";
import type { ApprovalRequest, OrderOutcome } from "../../types";
import { lastStructuredResult, lastConfidence } from "../state";

export interface ApprovalCallbacks {
  /** Emits `approval.required` and parks the order (FR-5.3). */
  requestApproval: (params: {
    orderId: string;
    traceId: string;
    contactId: string | null;
    approval: ApprovalRequest;
    /** CALL-E's exact words, so the operator decides on evidence not summary. */
    verbatim: string | null;
    evidence: string[];
  }) => Promise<void>;
  /** Emits `order.updated` with status APPROVAL_REQUIRED. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
}

export async function approval(
  state: CoordinationState,
  callbacks: ApprovalCallbacks
): Promise<Partial<CoordinationState>> {
  const result = lastStructuredResult(state);
  const confidence = lastConfidence(state);

  const proposedUnitPrice = result?.unit_price ?? state.item.unitPrice;
  const currency = result?.currency ?? state.item.currency;

  const request: ApprovalRequest = {
    reason: buildApprovalReason(state, proposedUnitPrice, currency),
    previousUnitPrice: state.item.unitPrice,
    proposedUnitPrice,
    currency,
  };

  const evidence = state.callHistory[state.callHistory.length - 1]?.evidence ?? [];

  await callbacks.requestApproval({
    orderId: state.orderId,
    traceId: state.traceId,
    contactId: state.currentContact?.id ?? null,
    approval: request,
    verbatim: result?.verbatim_commitment ?? null,
    evidence,
  });

  // The order moves to APPROVAL_REQUIRED carrying the quantities the supplier
  // offered — but NOT the price. The price on the order changes only after a
  // person approves it (contract doc §5.1).
  const outcome: OrderOutcome = {
    orderId: state.orderId,
    contactId: state.currentContact?.id ?? null,
    status: "APPROVAL_REQUIRED",
    committed: false,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: null,
    dispatchDate: result?.dispatch_date ?? null,
    deliveryEta: result?.delivery_eta ?? null,
    summary:
      `${state.currentContact?.name ?? state.seller.name} quoted ` +
      `${proposedUnitPrice} ${currency} against ${state.item.unitPrice} on the order. ` +
      `Awaiting approval before anything is confirmed.` +
      (confidence ? ` Extraction confidence ${confidence.score}.` : ""),
    operatorMinutesSaved: null,
  };

  await callbacks.updateOrder(outcome);

  return {
    pendingApproval: request,
    finalOutcome: outcome,
    requiresHumanReview: true,
  };
}

function buildApprovalReason(
  state: CoordinationState,
  proposed: number,
  currency: string
): string {
  const result = lastStructuredResult(state);
  const who = state.currentContact?.name ?? state.seller.name;

  if (proposed !== state.item.unitPrice) {
    const direction = proposed > state.item.unitPrice ? "increase" : "reduction";
    const delta = Math.abs(proposed - state.item.unitPrice);
    const pct = state.item.unitPrice
      ? ` (${((delta / state.item.unitPrice) * 100).toFixed(1)}%)`
      : "";

    return (
      `${who} quoted ${proposed} ${currency} per unit against ${state.item.unitPrice} ` +
      `on order ${state.reference} — a ${delta} ${currency} ${direction}${pct}. ` +
      "The agent recorded it and did not accept it."
    );
  }

  // requires_approval was set without a price change — credit or contractual
  // terms. We do not have a typed field for those, so the verbatim is the
  // evidence the operator works from.
  return (
    `${who} proposed a commercial condition the agent may not accept on order ` +
    `${state.reference}` +
    (result?.verbatim_commitment ? `: "${result.verbatim_commitment}"` : ".")
  );
}
