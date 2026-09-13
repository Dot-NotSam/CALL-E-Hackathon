/**
 * packages/agent/nodes/verify.ts
 * Node: verify
 * Owner: Aryan
 *
 * The follow-up call that checks a commitment was actually met (FR-5.4).
 * Exits to: "confirm" | "escalate"
 *
 * PRD §9 lists "commitment not fulfilled" as a failure mode in its own right —
 * a supplier saying "yes, today" and then not dispatching is the single most
 * expensive outcome for the buyer, because it is discovered late. Verifying is
 * what makes this an operations system rather than a dialler.
 *
 * This node runs when a VERIFICATION or REMAINING_QUANTITY follow-up fires. The
 * queue re-enters the graph here with the original order state plus the new
 * call's result.
 */

import type { CoordinationState } from "../state";
import type { Contact, FollowUp, OrderOutcome } from "../../types";
import { lastStructuredResult, toContext } from "../state";
import { buildFollowUpPrompt } from "../../calle/prompt";

export type VerifyResult = "confirm" | "escalate";

export interface VerifyCallbacks {
  /** Emits `order.updated` once the verification outcome is known. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
  /** Queues a further follow-up when the supplier gives a revised date. */
  scheduleFollowUp: (followUp: FollowUp) => Promise<void>;
  /** Marks the follow-up that triggered this run as done, so it leaves the panel. */
  completeFollowUp?: (followUpId: string) => Promise<void>;
}

export interface VerifyOptions {
  /** The follow-up that triggered this verification, if the backend tracked one. */
  followUpId?: string;
  now?: Date;
}

export interface VerifyOutcome {
  route: VerifyResult;
  updates: Partial<CoordinationState>;
  reason: string;
}

export async function verify(
  state: CoordinationState,
  callbacks: VerifyCallbacks,
  options: VerifyOptions = {}
): Promise<VerifyOutcome> {
  const now = options.now ?? new Date();
  const result = lastStructuredResult(state);

  if (options.followUpId) {
    await callbacks.completeFollowUp?.(options.followUpId);
  }

  // ── The commitment held ───────────────────────────────────────────────────
  const dispatched =
    result?.stock_status === "confirmed" || result?.stock_status === "partial";

  if (dispatched && result?.contact_reached === "yes") {
    const reason =
      `${state.currentContact?.name ?? state.seller.name} confirmed dispatch against ` +
      `${state.reference}.` +
      (result.verbatim_commitment ? ` "${result.verbatim_commitment}"` : "");

    // Write the verified outcome here rather than routing back through
    // `confirm`. Confirm would schedule a fresh VERIFICATION follow-up, and an
    // order that verifies itself forever never actually closes.
    //
    // The quantities are carried from the order, not re-read from this call:
    // a dispatch check confirms that what was already agreed went out, and it
    // is not an opportunity to renegotiate the amount.
    const outcome: OrderOutcome = {
      orderId: state.orderId,
      contactId: state.currentContact?.id ?? null,
      status:
        (state.item.remainingQuantity ?? 0) > 0 ? "PARTIALLY_CONFIRMED" : "CONFIRMED",
      committed: true,
      confirmedQuantity: state.item.confirmedQuantity,
      remainingQuantity: state.item.remainingQuantity,
      unitPrice: null,
      dispatchDate: result.dispatch_date ?? null,
      deliveryEta: result.delivery_eta ?? null,
      summary: reason,
      operatorMinutesSaved: null,
    };

    await callbacks.updateOrder(outcome);

    return { route: "confirm", updates: { finalOutcome: outcome }, reason };
  }

  // ── The commitment did not hold ───────────────────────────────────────────
  // A revised date is still information: queue one more check rather than
  // escalating straight away, but only once — a supplier who moves the date
  // twice is escalated, not chased indefinitely.
  // Have we already given them one second chance?
  //
  // The follow-up we schedule below has a fixed id, so if THIS run was
  // triggered by that id, we are the re-check and there is no third go.
  //
  // The `state.followUps` scan was the original guard and it never fired: a
  // follow-up run starts from `createInitialState`, which sets `followUps: []`,
  // and nothing in the graph marks a follow-up DONE — `completeFollowUp` is a
  // backend callback. So a supplier who moved the date every time was chased
  // indefinitely, one credit per round. It is kept as a second line of defence
  // for backends that do populate the array.
  const revisedFollowUpId = `${state.orderId}-verification-revised`;

  const alreadyChased =
    state.followUpId === revisedFollowUpId ||
    state.followUps.some((f) => f.kind === "VERIFICATION" && f.status === "DONE");

  if (result?.dispatch_date && !alreadyChased) {
    const followUp: FollowUp = {
      id: revisedFollowUpId,
      orderId: state.orderId,
      kind: "VERIFICATION",
      dueAt: new Date(
        Math.max(
          new Date(result.dispatch_date).getTime() + 30 * 60 * 1000,
          now.getTime() + 30 * 60 * 1000
        )
      ).toISOString(),
      contactId: state.currentContact?.id ?? "",
      note: `Re-verify ${state.reference} — supplier gave a revised dispatch date`,
      status: "SCHEDULED",
    };

    await callbacks.scheduleFollowUp(followUp);

    const reason =
      `Dispatch had not happened. ${state.currentContact?.name ?? state.seller.name} ` +
      `gave a revised date of ${result.dispatch_date}; re-checking once.`;

    const outcome: OrderOutcome = {
      orderId: state.orderId,
      contactId: state.currentContact?.id ?? null,
      status: "PARTIALLY_CONFIRMED",
      committed: true,
      confirmedQuantity: state.item.confirmedQuantity,
      remainingQuantity: state.item.remainingQuantity,
      unitPrice: null,
      dispatchDate: result.dispatch_date,
      deliveryEta: result.delivery_eta ?? null,
      summary: reason,
      operatorMinutesSaved: null,
    };

    await callbacks.updateOrder(outcome);

    return {
      route: "confirm",
      // `finalOutcome` belongs here as much as on the held path. Without it the
      // run ends with finalOutcome null while updateOrder has already written
      // the revised date — so the caller of runFollowUpCall cannot tell what
      // happened, and the two verify paths report inconsistently.
      updates: { finalOutcome: outcome, followUps: [...state.followUps, followUp] },
      reason,
    };
  }

  const reason =
    `Commitment on ${state.reference} was not met and no revised date was given. ` +
    "Escalating to the next contact.";

  return { route: "escalate", updates: {}, reason };
}

/**
 * Builds the task prompt for a follow-up call.
 *
 * There is exactly ONE follow-up prompt builder, in `packages/calle/prompt.ts`.
 * This is a thin adapter from graph state to it — do not inline a second copy.
 */
export function buildVerificationTaskPrompt(
  state: CoordinationState,
  contact: Contact,
  kind: "VERIFICATION" | "REMAINING_QUANTITY" = "VERIFICATION"
): string {
  const result = lastStructuredResult(state);

  return buildFollowUpPrompt(toContext(state), contact, kind, {
    confirmedQuantity: state.item.confirmedQuantity ?? result?.confirmed_quantity,
    remainingQuantity: state.item.remainingQuantity ?? result?.remaining_quantity,
    dispatchDate: result?.dispatch_date,
  });
}
