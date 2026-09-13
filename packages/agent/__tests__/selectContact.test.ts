/**
 * packages/agent/__tests__/selectContact.test.ts
 *
 * FR-3.2/3.3/3.4 and FR-7.2/7.3 — who may be called, and when.
 *
 * These are consent and safety boundaries, not preferences. Every filter here
 * exists to stop a real phone ringing that should not have.
 */

import {
  selectBestContact,
  isWithinWorkingHours,
  isOutOfCooldown,
  hasConsent,
  mayOverrideWorkingHours,
} from "../nodes/selectContact";
import { makeState, makeContact, PRIMARY, BACKUP, SUPERVISOR, LADDER } from "./fixtures";

/** 11:30 IST — inside a 09:00–18:00 working day. */
const DURING_HOURS = new Date("2026-09-13T06:00:00.000Z");
/** 03:30 IST — the middle of the night in Asia/Kolkata. */
const AT_NIGHT = new Date("2026-09-12T22:00:00.000Z");

const BUSINESS_HOURS = { start: "09:00", end: "18:00", timezone: "Asia/Kolkata" };

describe("isWithinWorkingHours", () => {
  it("compares against the contact's timezone, not the server's", () => {
    const contact = makeContact({ workingHours: BUSINESS_HOURS });

    expect(isWithinWorkingHours(contact, DURING_HOURS)).toBe(true);
    expect(isWithinWorkingHours(contact, AT_NIGHT)).toBe(false);
  });

  it("handles a window that crosses midnight", () => {
    const nightShift = makeContact({
      workingHours: { start: "22:00", end: "06:00", timezone: "Asia/Kolkata" },
    });

    expect(isWithinWorkingHours(nightShift, AT_NIGHT)).toBe(true);
    expect(isWithinWorkingHours(nightShift, DURING_HOURS)).toBe(false);
  });

  it("fails closed on an invalid timezone rather than widening the window", () => {
    const broken = makeContact({
      workingHours: { start: "00:00", end: "23:59", timezone: "Mars/Olympus_Mons" },
    });

    expect(isWithinWorkingHours(broken, DURING_HOURS)).toBe(false);
  });

  it("fails closed on a malformed time", () => {
    const broken = makeContact({
      workingHours: { start: "9am", end: "6pm", timezone: "Asia/Kolkata" },
    });

    expect(isWithinWorkingHours(broken, DURING_HOURS)).toBe(false);
  });
});

describe("isOutOfCooldown (FR-3.4)", () => {
  it("allows a contact with no cooldown", () => {
    expect(isOutOfCooldown(makeContact(), DURING_HOURS)).toBe(true);
  });

  it("blocks a contact still inside their cooldown", () => {
    const contact = makeContact({ cooldownUntil: "2026-09-13T08:00:00.000Z" });
    expect(isOutOfCooldown(contact, DURING_HOURS)).toBe(false);
  });

  it("allows a contact whose cooldown has passed", () => {
    const contact = makeContact({ cooldownUntil: "2026-09-13T05:00:00.000Z" });
    expect(isOutOfCooldown(contact, DURING_HOURS)).toBe(true);
  });

  it("fails closed on an unparseable cooldown", () => {
    const contact = makeContact({ cooldownUntil: "later today" });
    expect(isOutOfCooldown(contact, DURING_HOURS)).toBe(false);
  });
});

describe("hasConsent (FR-7.2)", () => {
  it("requires a consent timestamp", () => {
    expect(hasConsent(makeContact())).toBe(true);
    expect(hasConsent(makeContact({ consentAt: "" }))).toBe(false);
    expect(hasConsent(makeContact({ consentAt: "yes" }))).toBe(false);
  });
});

describe("selectBestContact", () => {
  it("picks the lowest escalationPriority", () => {
    const { contact } = selectBestContact(makeState(), [SUPERVISOR, BACKUP, PRIMARY], {
      now: DURING_HOURS,
    });

    expect(contact?.id).toBe(PRIMARY.id);
  });

  it("skips contacts already tried on this order", () => {
    const state = makeState({ attemptedContacts: [PRIMARY.id] });
    const { contact } = selectBestContact(state, LADDER, { now: DURING_HOURS });

    expect(contact?.id).toBe(BACKUP.id);
  });

  it("refuses a contact with no recorded consent, even if they are otherwise perfect", () => {
    const unconsented = makeContact({ consentAt: "" });
    const { contact, rejections } = selectBestContact(makeState(), [unconsented], {
      now: DURING_HOURS,
    });

    expect(contact).toBeNull();
    expect(rejections[0].reason).toMatch(/consent/i);
  });

  it("refuses a contact who works for a different organisation", () => {
    const outsider = makeContact({ organizationId: "org-somewhere-else" });
    const { contact } = selectBestContact(makeState(), [outsider], { now: DURING_HOURS });

    expect(contact).toBeNull();
  });

  it("filters by product category when one is required", () => {
    const wrongCategory = makeContact({ productCategories: ["industrial"] });
    const { contact } = selectBestContact(makeState(), [wrongCategory], {
      now: DURING_HOURS,
      requiredCategory: "medical-supplies",
    });

    expect(contact).toBeNull();
  });

  it("does not call outside working hours by default", () => {
    const contact = makeContact({ workingHours: BUSINESS_HOURS });
    const selection = selectBestContact(makeState(), [contact], { now: AT_NIGHT });

    expect(selection.contact).toBeNull();
    expect(selection.rejections[0].reason).toMatch(/working hours/i);
  });

  it("calls outside working hours only when explicitly allowed", () => {
    const contact = makeContact({ workingHours: BUSINESS_HOURS });
    const { contact: selected } = selectBestContact(makeState(), [contact], {
      now: AT_NIGHT,
      allowOutsideWorkingHours: true,
    });

    expect(selected?.id).toBe(contact.id);
  });

  it("records why every skipped contact was skipped", () => {
    const state = makeState({ attemptedContacts: [PRIMARY.id] });
    const { rejections } = selectBestContact(
      state,
      [PRIMARY, makeContact({ id: "ct-x", consentAt: "" })],
      { now: DURING_HOURS }
    );

    expect(rejections).toHaveLength(2);
    expect(rejections.map((r) => r.reason)).toEqual([
      expect.stringMatching(/Already tried/),
      expect.stringMatching(/consent/i),
    ]);
  });

  it("returns null once the whole ladder has been tried", () => {
    const state = makeState({
      attemptedContacts: [PRIMARY.id, BACKUP.id, SUPERVISOR.id],
    });
    const { contact } = selectBestContact(state, LADDER, { now: DURING_HOURS });

    expect(contact).toBeNull();
  });
});

describe("mayOverrideWorkingHours (FR-7.3)", () => {
  it("only ever applies to URGENT, and only when the policy permits it", () => {
    expect(mayOverrideWorkingHours("URGENT", true)).toBe(true);
    expect(mayOverrideWorkingHours("URGENT", false)).toBe(false);
    expect(mayOverrideWorkingHours("PRIORITY", true)).toBe(false);
    expect(mayOverrideWorkingHours("ROUTINE", true)).toBe(false);
  });
});
