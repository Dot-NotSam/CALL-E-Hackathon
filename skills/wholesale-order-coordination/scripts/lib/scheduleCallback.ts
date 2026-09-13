/**
 * VENDORED — do not edit.
 *
 * Generated from packages/agent/nodes/scheduleCallback.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/agent/nodes/scheduleCallback.ts
 * Node: schedule_callback
 * Owner: Aryan
 *
 * The contact asked to be called back. Schedules the retry and parks the order.
 * Exits to: END (the queue re-enters the graph when the callback is due).
 *
 * FR-5.4. Contract doc §5.2: the callback runs as a NEW call on the SAME order
 * carrying the SAME trace_id, so the dashboard shows one continuous story.
 */

import type { CoordinationState } from "./state";
import type { FollowUp, OrderOutcome, Contact } from "./types";
import { lastStructuredResult } from "./state";

export interface ScheduleCallbackCallbacks {
  /** Queues the retry job at `dueAt`, carrying the same trace_id. */
  scheduleCallbackJob: (params: {
    orderId: string;
    traceId: string;
    contactId: string;
    callbackAt: string;
    rung: number;
  }) => Promise<void>;
  /** Emits `followup.scheduled`. */
  scheduleFollowUp: (followUp: FollowUp) => Promise<void>;
  /** Emits `order.updated` with status CALLBACK_SCHEDULED. */
  updateOrder: (outcome: OrderOutcome) => Promise<void>;
  /**
   * PRD §9 — for an URGENT order only, try the backup contact in parallel
   * rather than waiting out the callback window.
   */
  triggerParallelRung?: (orderId: string) => Promise<void>;
}

export interface ScheduleCallbackOptions {
  now?: Date;
}

/** Default wait when the contact gave no usable time. */
const DEFAULT_CALLBACK_DELAY_MINUTES = 30;

export async function scheduleCallback(
  state: CoordinationState,
  callbacks: ScheduleCallbackCallbacks,
  options: ScheduleCallbackOptions = {}
): Promise<Partial<CoordinationState>> {
  const now = options.now ?? new Date();
  const result = lastStructuredResult(state);

  const { callbackAt, adjusted } = resolveCallbackTime(
    result?.callback_requested_at,
    state.currentContact,
    now
  );

  await callbacks.scheduleCallbackJob({
    orderId: state.orderId,
    traceId: state.traceId,
    contactId: state.currentContact?.id ?? "",
    callbackAt,
    rung: state.rung,
  });

  const followUp: FollowUp = {
    id: `${state.orderId}-callback`,
    orderId: state.orderId,
    kind: "CALLBACK",
    dueAt: callbackAt,
    contactId: state.currentContact?.id ?? "",
    note: adjusted
      ? `Call ${state.currentContact?.name ?? "the contact"} back — requested time fell outside their working hours, moved to the next opening`
      : `Call ${state.currentContact?.name ?? "the contact"} back as requested`,
    status: "SCHEDULED",
  };

  await callbacks.scheduleFollowUp(followUp);

  const outcome: OrderOutcome = {
    orderId: state.orderId,
    contactId: state.currentContact?.id ?? null,
    status: "CALLBACK_SCHEDULED",
    committed: false,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: null,
    dispatchDate: null,
    deliveryEta: null,
    summary:
      `${state.currentContact?.name ?? state.seller.name} asked to be called back. ` +
      `Callback queued for ${callbackAt}.` +
      (adjusted ? " Requested time was outside their working hours." : ""),
    operatorMinutesSaved: null,
  };

  await callbacks.updateOrder(outcome);

  // PRD §9 — parallel escalation is for URGENT orders only. On a routine order
  // it would ring a second supplier contact for no reason and burn a credit.
  if (state.urgency === "URGENT" && callbacks.triggerParallelRung) {
    await callbacks.triggerParallelRung(state.orderId);
  }

  // `finalOutcome` is set even though CALLBACK_SCHEDULED is not a dead end:
  // this graph run is over, and the backend reads the outcome to know how the
  // run terminated. The queued job starts a fresh run on the same order.
  return {
    finalOutcome: outcome,
    followUps: [...state.followUps, followUp],
  };
}

// ─── Callback timing ─────────────────────────────────────────────────────────

export interface ResolvedCallback {
  callbackAt: string;
  /** True when the requested time was moved to respect working hours. */
  adjusted: boolean;
}

/**
 * Turns what the contact said into a time we can queue.
 *
 * Three things can go wrong with `callback_requested_at`, and all three have
 * been seen in testing: it can be absent, it can be unparseable (the model
 * writing "after lunch" through), or it can be in the past by the time the
 * result is extracted. Each falls back rather than queueing a job that fires
 * immediately or never.
 *
 * Contract doc §5.2: a time outside the contact's working hours moves to their
 * next opening, and the follow-up note says so.
 */
export function resolveCallbackTime(
  requested: string | undefined,
  contact: Contact | null,
  now: Date = new Date()
): ResolvedCallback {
  const fallback = new Date(
    now.getTime() + DEFAULT_CALLBACK_DELAY_MINUTES * 60 * 1000
  );

  if (!requested) {
    return { callbackAt: fallback.toISOString(), adjusted: false };
  }

  const at = new Date(requested);
  if (Number.isNaN(at.getTime())) {
    return { callbackAt: fallback.toISOString(), adjusted: false };
  }

  // A requested time already in the past means the extraction resolved it
  // against the wrong day. Waiting the default beats firing instantly.
  if (at.getTime() <= now.getTime()) {
    return { callbackAt: fallback.toISOString(), adjusted: true };
  }

  if (!contact) {
    return { callbackAt: at.toISOString(), adjusted: false };
  }

  const opening = nextOpening(at, contact);
  return opening
    ? { callbackAt: opening.toISOString(), adjusted: true }
    : { callbackAt: at.toISOString(), adjusted: false };
}

/**
 * If `at` falls outside the contact's working hours, returns their next
 * opening time. Returns null when `at` is already inside the window.
 */
function nextOpening(at: Date, contact: Contact): Date | null {
  const zone = contact.workingHours.timezone;
  const minutesAt = wallClockMinutes(at, zone);
  const start = parseHHMM(contact.workingHours.start);
  const end = parseHHMM(contact.workingHours.end);

  if (minutesAt === null || start === null || end === null) return null;

  const inside =
    start <= end
      ? minutesAt >= start && minutesAt < end
      : minutesAt >= start || minutesAt < end;

  if (inside) return null;

  // Shift forward to the start of the window. When the requested time is
  // before opening it is the same day; when it is after closing it is the next.
  const minutesUntilOpen =
    minutesAt < start ? start - minutesAt : 24 * 60 - minutesAt + start;

  return new Date(at.getTime() + minutesUntilOpen * 60 * 1000);
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function wallClockMinutes(at: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).formatToParts(at);

    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

    return hour * 60 + minute;
  } catch {
    return null;
  }
}
