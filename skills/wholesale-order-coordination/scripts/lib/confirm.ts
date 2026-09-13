/**
 * VENDORED — do not edit.
 *
 * Generated from packages/agent/nodes/confirm.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/agent/nodes/confirm.ts
 * Node: confirm  (handles both CONFIRM_ORDER and PARTIAL_CONFIRMATION)
 * Owner: Aryan
 *
 * Writes the supplier's commitment back onto the order and schedules the
 * follow-ups that actually close the loop (FR-5.1, FR-5.2, FR-5.4).
 * Exits to: END
 *
 * One node serves both outcomes because they differ only in the quantities and
 * which follow-ups get created — splitting them would duplicate the order
 * update and the follow-up scheduling. `decide` still distinguishes them in the
 * audit trail by returning "confirm" vs "partial".
 *
 * The actual DB write, SSE emission and queue insertion are the backend's
 * (Sameer's) job. This node decides WHAT should happen and calls back.
 */

import type { CoordinationState } from "./state";
import type { FollowUp, OrderOutcome, OrderStatus } from "./types";
import { lastStructuredResult } from "./state";
import { reconcileQuantities } from "./decide";

/**
 * PRD §1.3 — an operator spends 8–20 minutes on a supplier confirmation by
 * hand: the call itself, the hold, the callback, and typing the result into
 * the order. We credit the conservative end of that range.
 *
 * This is an ESTIMATE of labour replaced, not a measurement. It is reported as
 * "operator minutes saved" and never as elapsed time.
 */
const MANUAL_BASELINE_MINUTES = 12;

export interface ConfirmCallbacks {
  /** Writes the commitment onto the order and emits `order.updated`. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
  /** Creates a follow-up and emits `followup.scheduled` (FR-5.4). */
  scheduleFollowUp: (followUp: FollowUp) => Promise<void>;
  /** Tells the buyer's team the order moved. */
  notifyBuyer?: (orderId: string, outcome: OrderOutcome) => Promise<void>;
}

export interface ConfirmOptions {
  /** Injected in tests. */
  now?: Date;
  /** Overrides the labour-replaced estimate for a facility with real data. */
  manualBaselineMinutes?: number;
}

export async function confirm(
  state: CoordinationState,
  callbacks: ConfirmCallbacks,
  options: ConfirmOptions = {}
): Promise<Partial<CoordinationState>> {
  const now = options.now ?? new Date();
  const result = lastStructuredResult(state);
  const quantities = reconcileQuantities(state);

  // ── Quantities that do not add up are a review case, not an order update ──
  // PRD §9 "conflicting quantities → preserve both statements, route to
  // review". Writing a number we cannot reconcile would corrupt the buyer's
  // stock position, which is worse than leaving the order open.
  // A confirmation with no number in it is also a review case.
  //
  // `confirmed_quantity` is omitted whenever the supplier hedged — "about 200",
  // "approx 200" — which the prompt and schema now treat as not-a-commitment.
  // Without this guard the order was written CONFIRMED, committed: true, with
  // `confirmedQuantity: null`, and the summary filled the gap from the ORDER:
  // "Rajesh confirmed all 200 cases." Nobody said 200. Inventing the number in
  // the sentence an operator reads is the worst place to invent it.
  const unquantified = quantities.confirmed === null && quantities.remaining === null;

  if (quantities.conflicting || unquantified) {
    const outcome: OrderOutcome = {
      orderId: state.orderId,
      contactId: state.currentContact?.id ?? null,
      status: "HUMAN_REVIEW",
      committed: false,
      confirmedQuantity: null,
      remainingQuantity: null,
      unitPrice: null,
      dispatchDate: null,
      deliveryEta: null,
      summary:
        quantities.note ??
        (quantities.conflicting
          ? "Supplier quantities did not reconcile."
          : `${state.currentContact?.name ?? state.seller.name} agreed to the order but ` +
            `gave no firm quantity for the ${state.item.requestedQuantity} ` +
            `${state.item.unit} requested` +
            (result?.verbatim_commitment ? `: "${result.verbatim_commitment}"` : ".")),
      operatorMinutesSaved: null,
    };

    await callbacks.updateOrder(outcome);

    return { finalOutcome: outcome, requiresHumanReview: true };
  }

  const isPartial =
    result?.next_action === "PARTIAL_CONFIRMATION" ||
    result?.stock_status === "partial" ||
    (quantities.remaining ?? 0) > 0;

  const status: OrderStatus = isPartial ? "PARTIALLY_CONFIRMED" : "CONFIRMED";

  const operatorMinutesSaved =
    options.manualBaselineMinutes ?? MANUAL_BASELINE_MINUTES;

  const outcome: OrderOutcome = {
    orderId: state.orderId,
    contactId: state.currentContact?.id ?? null,
    status,
    committed: true,
    confirmedQuantity: quantities.confirmed,
    remainingQuantity: quantities.remaining,
    // The price only ever changes through the approval node. A confirmation
    // never rewrites it, even if the supplier quoted the same number back.
    unitPrice: null,
    dispatchDate: result?.dispatch_date ?? null,
    deliveryEta: result?.delivery_eta ?? null,
    summary: buildSummary(state, status, quantities.confirmed, quantities.remaining),
    operatorMinutesSaved,
  };

  await callbacks.updateOrder(outcome);
  await callbacks.notifyBuyer?.(state.orderId, outcome);

  // ── Follow-ups (contract doc §5.4) ───────────────────────────────────────
  const followUps: FollowUp[] = [];

  // The remainder gets chased the next business morning.
  if (isPartial && (quantities.remaining ?? 0) > 0) {
    followUps.push({
      id: `${state.orderId}-remaining`,
      orderId: state.orderId,
      kind: "REMAINING_QUANTITY",
      dueAt: nextBusinessMorning(now).toISOString(),
      contactId: state.currentContact?.id ?? "",
      note:
        `Confirm the remaining ${quantities.remaining} ${state.item.unit} have dispatched`,
      status: "SCHEDULED",
    });
  }

  // Every commitment gets verified — this is the loop closing twice, and it is
  // what makes this an operations system rather than a dialler.
  followUps.push({
    id: `${state.orderId}-verification`,
    orderId: state.orderId,
    kind: "VERIFICATION",
    dueAt: verificationDueAt(result?.dispatch_date, now).toISOString(),
    contactId: state.currentContact?.id ?? "",
    note: `Verify ${quantities.confirmed ?? state.item.requestedQuantity} ${state.item.unit} dispatched against ${state.reference}`,
    status: "SCHEDULED",
  });

  for (const followUp of followUps) {
    await callbacks.scheduleFollowUp(followUp);
  }

  return {
    finalOutcome: outcome,
    followUps: [...state.followUps, ...followUps],
  };
}

// ─── Timing helpers ──────────────────────────────────────────────────────────

/**
 * When to verify a dispatch. Just after the supplier said it would leave, so
 * the call lands when there is something to confirm.
 *
 * Falls back to two hours out when no concrete dispatch date was given — the
 * same default the dashboard's mock uses, so a replayed scenario and a real run
 * schedule alike.
 */
export function verificationDueAt(
  dispatchDate: string | undefined,
  now: Date = new Date()
): Date {
  const fallback = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  if (!dispatchDate) return fallback;

  const dispatchAt = new Date(dispatchDate).getTime();
  if (Number.isNaN(dispatchAt)) return fallback;

  // Half an hour after the stated dispatch, and never in the past.
  const due = new Date(dispatchAt + 30 * 60 * 1000);
  if (due.getTime() <= now.getTime()) return fallback;

  // A date-only dispatch ("2026-09-16") parses as UTC midnight, so +30 minutes
  // lands at 06:00 IST — before the contact opens. `select_contact` would then
  // reject them for being outside working hours and the whole verification run
  // would end UNRESOLVED, for no reason but arithmetic. Push those to the
  // business morning instead.
  // The morning AFTER the stated day: they said it goes out that day, and
  // "did yesterday's dispatch actually leave?" is a question with an answer.
  return isDateOnly(dispatchDate) ? nextBusinessMorning(new Date(dispatchAt)) : due;
}

/** "2026-09-16" carries no time of day; "2026-09-16T14:00:00Z" does. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * 10:00 IST on the next working day.
 *
 * Chasing a remainder at 23:00 because that is when the first call happened is
 * exactly the behaviour that gets an automated line blocked, so the follow-up
 * waits for business hours regardless of when the order ran.
 *
 * Weekends are skipped: the function is named for a BUSINESS morning, and a
 * Friday partial confirmation chased at 10:00 on Saturday reaches a warehouse
 * nobody is standing in. Saturday and Sunday both roll to Monday.
 */
export function nextBusinessMorning(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(4, 30, 0, 0); // 10:00 IST

  // getUTCDay at 04:30 UTC is the same calendar day in IST (+05:30), so the
  // weekday check does not need a separate timezone conversion.
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next;
}

// ─── Summary text ────────────────────────────────────────────────────────────

/**
 * The one sentence an operator reads in the queue. It states what was secured
 * and, on a partial, what is still outstanding — never just "confirmed".
 */
function buildSummary(
  state: CoordinationState,
  status: OrderStatus,
  confirmed: number | null,
  remaining: number | null
): string {
  const result = lastStructuredResult(state);
  const who = state.currentContact?.name ?? state.seller.name;
  const unit = state.item.unit;

  if (status === "PARTIALLY_CONFIRMED") {
    const when = result?.delivery_eta ? `, balance ${result.delivery_eta}` : "";
    return (
      `${who} confirmed ${confirmed} of ${state.item.requestedQuantity} ${unit}; ` +
      `${remaining} ${unit} outstanding${when}.`
    );
  }

  const dispatch = result?.dispatch_date ? ` dispatching ${result.dispatch_date}` : "";
  return `${who} confirmed all ${confirmed ?? state.item.requestedQuantity} ${unit}${dispatch}.`;
}
