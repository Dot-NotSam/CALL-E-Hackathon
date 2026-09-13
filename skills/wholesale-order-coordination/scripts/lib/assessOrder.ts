/**
 * VENDORED — do not edit.
 *
 * Generated from packages/agent/nodes/assessOrder.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/agent/nodes/assessOrder.ts
 * Node: assess_order
 * Owner: Aryan
 *
 * Decides whether this coordination request actually warrants a phone call.
 * Exits to: "select_contact" | "suppress"
 *
 * Deterministic rule-based logic — the correlation engine (Sameer) already
 * filtered noise, and this is the agent's final gate before anyone's phone
 * rings. FR-2.1, FR-2.3.
 *
 * This runs BEFORE any call is planned, so a duplicate never costs a call
 * (contract doc §5.5). That ordering is the whole point of the node.
 */

import type { CoordinationState } from "./state";
import type { Order, OrderStatus, Urgency } from "./types";

export type AssessResult = "select_contact" | "suppress";

/**
 * Statuses that mean an earlier request for the same goods is already in
 * flight or already answered. A second call about them is noise to the
 * supplier and a wasted credit to us.
 *
 * `HUMAN_REVIEW` and `UNRESOLVED` are deliberately NOT here: those ended
 * without a usable commitment, so a fresh request should be allowed to try
 * again rather than being silently swallowed.
 */
const COVERING_STATUSES: readonly OrderStatus[] = [
  "CALLING",
  "CONFIRMED",
  "PARTIALLY_CONFIRMED",
  "APPROVAL_REQUIRED",
  "CALLBACK_SCHEDULED",
];

/** What the agent needs to know about other orders to spot a duplicate. */
export interface DuplicateCandidate {
  id: string;
  reference: string;
  sellerId: string;
  sku: string;
  status: OrderStatus;
  createdAt: string;
}

export interface AssessInput {
  /** Other open requests, so this one can be checked against them (FR-2.3). */
  existingOrders?: DuplicateCandidate[];
  /** Injected in tests. */
  now?: Date;
}

/**
 * FR-2.2 — urgency from the delivery window.
 *
 * The backend owns this rule for orders it creates (contract doc §6); the agent
 * recomputes it because a callback can fire hours after the order was opened,
 * and an order that was PRIORITY when it was raised may be URGENT by the time
 * the second call is placed.
 */
export function urgencyFor(requiredBy: string, now: Date = new Date()): Urgency {
  const hours = (new Date(requiredBy).getTime() - now.getTime()) / 3_600_000;
  if (Number.isNaN(hours)) return "PRIORITY";
  if (hours <= 24) return "URGENT";
  if (hours <= 72) return "PRIORITY";
  return "ROUTINE";
}

/**
 * Finds the earlier request this one duplicates, if any.
 *
 * The rule, in order (contract doc §5.5):
 *   1. An earlier request carrying the same business reference; otherwise
 *   2. The most recent request to the same seller for the same SKU whose
 *      status means it is already covered.
 */
export function findDuplicate(
  state: CoordinationState,
  existing: DuplicateCandidate[]
): DuplicateCandidate | null {
  const others = existing
    .filter((o) => o.id !== state.orderId)
    // The status filter applies to BOTH rules below, not just the SKU one.
    //
    // It used to guard only the SKU match, so an earlier request carrying the
    // same reference suppressed this one whatever state it ended in. An order
    // that went UNRESOLVED — the ladder exhausted, nobody confirmed anything —
    // permanently blocked every retry of the same reference, which is the exact
    // opposite of what COVERING_STATUSES exists to express: those two statuses
    // are excluded precisely so a fresh attempt is allowed.
    .filter((o) => COVERING_STATUSES.includes(o.status));

  const sameReference = others
    .filter((o) => o.reference === state.reference)
    .sort(byNewest)[0];

  if (sameReference) return sameReference;

  const covered = others
    .filter((o) => o.sellerId === state.seller.id)
    .filter((o) => o.sku === state.item.sku)
    .sort(byNewest)[0];

  return covered ?? null;
}

function byNewest(a: DuplicateCandidate, b: DuplicateCandidate): number {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export interface AssessOutcome {
  route: AssessResult;
  reason: string;
  duplicateOf: string | null;
  /** Recomputed urgency — written back onto state so the prompt uses it. */
  urgency: Urgency;
}

export function assessOrder(
  state: CoordinationState,
  input: AssessInput = {}
): AssessOutcome {
  const now = input.now ?? new Date();
  const urgency = urgencyFor(state.requiredBy, now);

  // ── Nothing to confirm ────────────────────────────────────────────────────
  // A zero or negative quantity is a malformed request, not a call.
  if (!(state.item.requestedQuantity > 0)) {
    return {
      route: "suppress",
      reason:
        `Requested quantity is ${state.item.requestedQuantity} ${state.item.unit} — ` +
        "nothing to confirm.",
      duplicateOf: null,
      urgency,
    };
  }

  // ── FR-2.3 — duplicate suppression, before any call is planned ───────────
  const duplicate = findDuplicate(state, input.existingOrders ?? []);
  if (duplicate) {
    const minutesAgo = Math.max(
      0,
      Math.round((now.getTime() - new Date(duplicate.createdAt).getTime()) / 60_000)
    );

    return {
      route: "suppress",
      reason:
        `Matches ${duplicate.reference}, received ${minutesAgo} min ago and already ` +
        `${describeStatus(duplicate.status)} with ${state.seller.name}.`,
      duplicateOf: duplicate.reference,
      urgency,
    };
  }

  // ── Everything else gets a call ───────────────────────────────────────────
  return {
    route: "select_contact",
    reason:
      `${state.item.requestedQuantity} ${state.item.unit} of ${state.item.description} ` +
      `needs confirmation from ${state.seller.name} — ${urgency.toLowerCase()}.`,
    duplicateOf: null,
    urgency,
  };
}

function describeStatus(status: OrderStatus): string {
  switch (status) {
    case "CALLING":
      return "being confirmed by an in-flight call";
    case "CONFIRMED":
      return "fully confirmed";
    case "PARTIALLY_CONFIRMED":
      return "partially confirmed";
    case "APPROVAL_REQUIRED":
      return "awaiting price approval";
    case "CALLBACK_SCHEDULED":
      return "awaiting a scheduled callback";
    default:
      return "open";
  }
}

/**
 * Narrows a full `Order` to the fields duplicate detection needs.
 * Lets the backend pass its own rows straight in.
 */
export function toDuplicateCandidate(order: Order): DuplicateCandidate {
  return {
    id: order.id,
    reference: order.reference,
    sellerId: order.seller.id,
    sku: order.item.sku,
    status: order.status,
    createdAt: order.createdAt,
  };
}
