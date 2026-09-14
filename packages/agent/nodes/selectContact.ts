/**
 * packages/agent/nodes/selectContact.ts
 * Node: select_contact
 * Owner: Aryan
 *
 * Picks the right business contact for the current escalation rung.
 * Exits to: "plan_call" | "unresolved" (no eligible contact left)
 *
 * Selection criteria (FR-3.2, all must pass):
 *   1. Works for the seller on this order
 *   2. Has recorded consent to receive coordination calls (FR-7.2)
 *   3. Not already tried on this order
 *   4. Covers the product category
 *   5. Inside their working hours (FR-7.3)
 *   6. Not in cooldown (FR-3.4)
 *   7. Ordered by escalationPriority ascending (1 = primary)
 *
 * The roster comes from the backend (Sameer) via AgentDependencies.getContacts.
 * This node never reads a database.
 */

import type { Contact, Urgency } from "../../types";
type ContactSelectionState = {
  seller: { id: string; name: string };
  attemptedContacts: string[];
};

type GraphSelectionState = {
  seller?: { id: string; name: string };
  order?: { seller: { id: string; name: string } };
  attemptedContacts: string[];
};

export type SelectContactResult = "plan_call" | "unresolved";

/**
 * Why a contact was skipped. Surfaced in the audit trail so an operator can see
 * that the ladder was exhausted for a *reason*, not by accident.
 */
export interface ContactRejection {
  contactId: string;
  name: string;
  reason: string;
}

export interface SelectContactOptions {
  /** Product category this order needs cover for. Defaults to the item SKU's category. */
  requiredCategory?: string;
  /** Injected in tests. */
  now?: Date;
  /**
   * FR-7.3 — whether an URGENT order may call outside working hours.
   *
   * Defaults to FALSE. Working hours are a consent boundary for a business
   * contact, not a convenience setting, so overriding them is an explicit
   * decision the backend makes per facility — never a default the agent
   * assumes.
   */
  allowOutsideWorkingHours?: boolean;
}

/**
 * Is `now` inside the contact's working hours, in THEIR timezone?
 *
 * Working hours are stored as HH:mm local to `workingHours.timezone`, so we
 * compare against the wall-clock time in that zone rather than the server's.
 * Getting this wrong rings a supplier in Mumbai at 3 a.m. because the server
 * runs in UTC.
 */
export function isWithinWorkingHours(contact: Contact, now: Date = new Date()): boolean {
  const minutesNow = wallClockMinutes(now, contact.workingHours.timezone);
  if (minutesNow === null) return false;

  const start = parseHHMM(contact.workingHours.start);
  const end = parseHHMM(contact.workingHours.end);
  if (start === null || end === null) return false;

  // Windows that cross midnight (e.g. 22:00 → 06:00).
  return start <= end
    ? minutesNow >= start && minutesNow < end
    : minutesNow >= start || minutesNow < end;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** Minutes since midnight at `now`, in `timezone`. Null if the zone is invalid. */
function wallClockMinutes(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).formatToParts(now);

    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

    return hour * 60 + minute;
  } catch {
    // An invalid timezone must not silently widen the calling window.
    return null;
  }
}

/** FR-3.4 — a contact inside their cooldown window is not called again. */
export function isOutOfCooldown(contact: Contact, now: Date = new Date()): boolean {
  if (!contact.cooldownUntil) return true;

  const until = new Date(contact.cooldownUntil).getTime();
  // An unparseable cooldown fails closed: we do not call.
  if (Number.isNaN(until)) return false;

  return now.getTime() >= until;
}

/** FR-7.2 — no consent record, no call. There is no override path. */
export function hasConsent(contact: Contact): boolean {
  if (!contact.consentAt) return false;
  return !Number.isNaN(new Date(contact.consentAt).getTime());
}

export interface SelectionOutcome {
  contact: Contact | null;
  /** Every contact considered and why it was skipped. Audit trail. */
  rejections: ContactRejection[];
}

/**
 * Selects the best eligible contact from the roster.
 * Returns null when none is eligible, which routes to unresolved.
 */
export function selectBestContact(
  state: ContactSelectionState,
  roster: Contact[],
  options: SelectContactOptions = {}
): SelectionOutcome {
  const now = options.now ?? new Date();
  const requiredCategory = options.requiredCategory;
  const rejections: ContactRejection[] = [];

  const eligible = roster.filter((contact) => {
    const reject = (reason: string) => {
      rejections.push({ contactId: contact.id, name: contact.name, reason });
      return false;
    };

    if (contact.organizationId !== state.seller.id) {
      return reject(`Works for ${contact.organizationId}, not ${state.seller.id}.`);
    }
    if (!hasConsent(contact)) {
      return reject("No recorded consent to receive coordination calls (FR-7.2).");
    }
    if (state.attemptedContacts.includes(contact.id)) {
      return reject("Already tried on this order.");
    }
    if (requiredCategory && !contact.productCategories.includes(requiredCategory)) {
      return reject(`Does not cover product category "${requiredCategory}".`);
    }
    if (!isOutOfCooldown(contact, now)) {
      return reject(`In cooldown until ${contact.cooldownUntil} (FR-3.4).`);
    }
    if (!options.allowOutsideWorkingHours && !isWithinWorkingHours(contact, now)) {
      return reject(
        `Outside working hours ${contact.workingHours.start}–${contact.workingHours.end} ` +
        `${contact.workingHours.timezone} (FR-7.3).`
      );
    }

    return true;
  });

  eligible.sort((a, b) => a.escalationPriority - b.escalationPriority);

  return { contact: eligible[0] ?? null, rejections };
}

/**
 * FR-7.3 — whether this order's urgency justifies calling outside working
 * hours, given a facility policy that permits it at all.
 *
 * Kept separate from `selectBestContact` so the policy decision is visible and
 * testable rather than buried in a filter. Only URGENT ever qualifies.
 */
export function mayOverrideWorkingHours(
  urgency: Urgency,
  policyAllowsOverride: boolean
): boolean {
  return policyAllowsOverride && urgency === "URGENT";
}

/** Compatibility adapter for the coordination graph's audit-oriented result. */
export function selectContactWithReason(
  state: GraphSelectionState,
  roster: Contact[],
): { contact: Contact | null; reason: string | null; detail: string } {
  const seller = state.seller ?? state.order?.seller;
  if (!seller) {
    return { contact: null, reason: "none_at_seller", detail: "Seller context is missing." };
  }

  const outcome = selectBestContact({ attemptedContacts: state.attemptedContacts, seller }, roster, {
    requiredCategory: undefined,
    allowOutsideWorkingHours: false,
  });

  if (outcome.contact) {
    return {
      contact: outcome.contact,
      reason: null,
      detail: `Selected ${outcome.contact.name}.`,
    };
  }

  const rejection = outcome.rejections[0];
  const reason = rejection?.reason.toLowerCase().includes("working hours")
    ? "outside_working_hours"
    : rejection?.reason.toLowerCase().includes("category")
      ? "no_product_match"
      : rejection?.reason.toLowerCase().includes("cooldown")
        ? "in_cooldown"
        : "none_at_seller";

  return {
    contact: null,
    reason,
    detail: rejection?.reason ?? `No eligible contact for ${seller.name}.`,
  };
}
