/**
 * packages/agent/nodes/selectContact.ts
 * Node: select_contact (wholesale coordination)
 * Owner: Aryan
 *
 * Picks the right supplier-side contact for the current ladder rung.
 * Exits to: "plan_call" | "escalate" (when no eligible contact remains)
 *
 * Selection criteria (all must pass):
 *   1. Belongs to the seller organisation on this order
 *   2. Not already dialled for this order
 *   3. Carries the product category the order is for
 *   4. Within their stated working hours, in THEIR timezone
 *   5. Not in cooldown (FR-7.3 — rate limiting, enforced in code)
 *   6. Ordered by escalationPriority ascending (1 = primary)
 *
 * Consent is NOT checked here — it is enforced one layer down, immediately
 * before dialling, so that no path into the call layer can skip it.
 */

import type { Contact } from "../../types/wholesale";
import type { CoordinationState } from "../coordinationState";

/**
 * Minutes since midnight in an IANA timezone, for "is it their working day?".
 *
 * Uses Intl rather than arithmetic on the UTC offset, because offsets shift
 * with daylight saving and a hard-coded one silently calls people at 03:00
 * twice a year.
 */
function minutesOfDayIn(timezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? NaN);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return NaN;

    return hour * 60 + minute;
  } catch {
    // An invalid timezone string must not be read as "always available".
    return NaN;
  }
}

/** "HH:mm" → minutes since midnight, or NaN if malformed. */
function parseHHMM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return NaN;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return NaN;

  return hour * 60 + minute;
}

/**
 * Is this contact inside their working hours right now?
 *
 * Fails CLOSED: if the timezone or the hours cannot be parsed we treat the
 * contact as unavailable rather than dialling them on a guess.
 */
export function isWithinWorkingHours(contact: Contact, now = new Date()): boolean {
  const nowMinutes = minutesOfDayIn(contact.workingHours.timezone, now);
  const start = parseHHMM(contact.workingHours.start);
  const end = parseHHMM(contact.workingHours.end);

  if (Number.isNaN(nowMinutes) || Number.isNaN(start) || Number.isNaN(end)) {
    return false;
  }

  // A window that crosses midnight (e.g. 22:00 → 06:00) wraps.
  return start <= end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/** FR-7.3 — has this contact's rate-limit cooldown expired? */
export function isNotInCooldown(contact: Contact, now = new Date()): boolean {
  if (!contact.cooldownUntil) return true;

  const until = new Date(contact.cooldownUntil);
  // An unparseable cooldown is treated as still active — fail closed.
  if (Number.isNaN(until.getTime())) return false;

  return now > until;
}

/**
 * Selects the next contact to dial, or null when the ladder is out of people.
 *
 * A null return is not an error — it is how the graph learns to escalate and,
 * once the rungs are spent, to mark the order UNRESOLVED.
 */
export function selectBestContact(
  state: CoordinationState,
  directory: Contact[],
  now = new Date()
): Contact | null {
  return selectContactWithReason(state, directory, now).contact;
}

/** Why the ladder produced nobody. Drives an honest outcome, not a guess. */
export type NoContactReason =
  | "none_at_seller"
  | "all_attempted"
  | "no_product_match"
  | "outside_working_hours"
  | "in_cooldown";

export interface ContactSelection {
  contact: Contact | null;
  /** Null when a contact was found. */
  reason: NoContactReason | null;
  /** Human-readable, for the audit trail and the operator. */
  detail: string;
}

/**
 * Selects the next contact AND explains a null.
 *
 * The explanation matters: "everyone is off shift until 09:00" and "we have
 * called everyone and nobody committed" both produce no contact, but they are
 * different situations for the operator — one waits, the other needs a person
 * now. Reporting both as "ladder exhausted" would be a lie of omission.
 */
export function selectContactWithReason(
  state: CoordinationState,
  directory: Contact[],
  now = new Date()
): ContactSelection {
  const sellerId = state.order.seller.id;
  const sku = state.order.item.sku;
  const description = state.order.item.description;

  const atSeller = directory.filter((c) => c.organizationId === sellerId);
  if (atSeller.length === 0) {
    return {
      contact: null,
      reason: "none_at_seller",
      detail: `No consented contacts on file for ${state.order.seller.name}.`,
    };
  }

  const notYetTried = atSeller.filter((c) => !state.attemptedContacts.includes(c.id));
  if (notYetTried.length === 0) {
    return {
      contact: null,
      reason: "all_attempted",
      detail: `Every contact at ${state.order.seller.name} has already been called for this order.`,
    };
  }

  const rightProduct = notYetTried.filter((c) => coversProduct(c, sku, description));
  if (rightProduct.length === 0) {
    return {
      contact: null,
      reason: "no_product_match",
      detail: `No remaining contact at ${state.order.seller.name} handles ${description}.`,
    };
  }

  const onShift = rightProduct.filter((c) => isWithinWorkingHours(c, now));
  if (onShift.length === 0) {
    const next = rightProduct[0].workingHours;
    return {
      contact: null,
      reason: "outside_working_hours",
      detail:
        `Every remaining contact at ${state.order.seller.name} is outside working hours ` +
        `(${next.start}–${next.end} ${next.timezone}).`,
    };
  }

  const available = onShift
    .filter((c) => isNotInCooldown(c, now))
    .sort((a, b) => a.escalationPriority - b.escalationPriority);

  if (available.length === 0) {
    return {
      contact: null,
      reason: "in_cooldown",
      detail: `Every remaining contact at ${state.order.seller.name} is in call-rate cooldown.`,
    };
  }

  return { contact: available[0], reason: null, detail: "" };
}

/**
 * Does this contact handle the product on the order?
 *
 * A contact with no declared categories is a generalist and matches anything;
 * otherwise we look for a category token appearing in the SKU or description.
 * Matching is deliberately loose — the cost of a false negative (nobody gets
 * called) is higher than a false positive (the wrong specialist redirects us).
 */
function coversProduct(contact: Contact, sku: string, description: string): boolean {
  if (contact.productCategories.length === 0) return true;

  const haystack = `${sku} ${description}`.toLowerCase();
  return contact.productCategories.some((category) =>
    haystack.includes(category.toLowerCase())
  );
}
