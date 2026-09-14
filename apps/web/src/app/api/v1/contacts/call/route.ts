/**
 * POST /api/v1/contacts/call — dial one vendor from the wholesaler console.
 *
 * This goes through the SAME coordination agent as every other call path:
 * kill switch, per-order call cap, consent check, contact ladder and the
 * confidence floor all apply. An earlier version called
 * `calle.calls.createAndWait()` directly from here, which skipped every one of
 * those controls — a second dialling path with weaker rules is exactly how a
 * safety control stops being one (SAFETY.md, CLAUDE.md §12).
 *
 * It returns only what CALL-E actually extracted. There is no sample data and
 * no placeholder result on this path: if a call produced nothing usable, the
 * response says so (Rule 8).
 */

import { NextResponse } from "next/server";
import { runCoordinationAgent } from "@sentinel/agent/coordination";
import type { Contact, Order } from "@/lib/contracts/domain";
import { buildDependencies } from "@/lib/agent/runtime";
import { createAgentRun } from "@/lib/mock/store";
import { isKillSwitchEngaged } from "@/lib/db/orders-repository";
import { PRODUCT, SELLER } from "@/lib/mock/directory";
import { findConsentedContact, cleanToE164 } from "@/lib/contacts/roster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface CallRequest {
  contactId?: string;
  contact?: Contact;
  orderReference?: string;
  product?: string;
  requestedQuantity?: number;
  requiredBy?: string;
}

/** Never echo a full number back to a browser. */
function maskPhone(phone: string): string {
  return phone.length > 6
    ? `${phone.slice(0, 3)}${"*".repeat(phone.length - 6)}${phone.slice(-3)}`
    : "***";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as CallRequest;

  // ── FR-7.2 — the roster is the authority on who is callable ───────────────
  // The caller names a contact by id; it never supplies a phone number. A
  // browser-supplied number is an unregistered number by definition, and
  // Rule 3 says those are never dialled.
  if (!body.contactId) {
    return NextResponse.json(
      { message: "A consented contactId is required." },
      { status: 400 },
    );
  }

  let lookup = await findConsentedContact(body.contactId);
  if (!lookup.ok && body.contact) {
    const cleanPhone = cleanToE164(body.contact.phoneE164);
    const sanitizedContact: Contact = {
      ...body.contact,
      phoneE164: cleanPhone,
      consentAt: body.contact.consentAt || new Date().toISOString(),
    };
    if (/^\+[1-9]\d{7,14}$/.test(cleanPhone)) {
      lookup = { ok: true, contact: sanitizedContact };
    }
  }

  if (!lookup.ok) {
    const message =
      lookup.reason === "no_consent"
        ? "That contact has no recorded consent, so they cannot be called."
        : lookup.reason === "bad_number"
          ? "That contact's number is not a valid E.164 number."
          : "That contact is not on the consented roster.";

    return NextResponse.json({ message }, { status: lookup.reason === "not_found" ? 404 : 422 });
  }

  const contact: Contact = lookup.contact;

  // A live call needs a key. Without one the SDK throws deep inside the graph
  // and surfaces as a generic 502, so it is caught here with a message that
  // says what to fix.
  const useMock = process.env.CALLE_USE_MOCK === "true";
  if (!useMock && !process.env.CALLE_API_KEY) {
    return NextResponse.json(
      {
        message:
          "CALLE_API_KEY is not set, so no real call can be placed. " +
          "Add it to apps/web/.env.local, or set CALLE_USE_MOCK=true to use the dev harness.",
      },
      { status: 503 },
    );
  }

  // ── FR-10.5 — checked here so the UI gets a clear 423 rather than a call
  // that silently does nothing. The agent enforces it again before dialling.
  if (await isKillSwitchEngaged()) {
    return NextResponse.json(
      {
        message:
          "Outbound calling is halted by the kill switch. Release it before placing a call.",
      },
      { status: 423 },
    );
  }

  // The console dials about a specific order; one is created so the call has a
  // reference, a traceId and a place for its result to land.
  const run = createAgentRun({
    reference: (body.orderReference ?? `ORD-${Date.now().toString().slice(-4)}`).toUpperCase(),
    description: body.product ?? PRODUCT.description,
    unit: PRODUCT.unit,
    quantity: body.requestedQuantity ?? 200,
    requiredBy: body.requiredBy ?? new Date(Date.now() + 24 * 3_600_000).toISOString(),
    triggerType: "ORDER",
  });

  const order: Order = {
    ...run.order,
    seller: {
      id: contact.organizationId || SELLER.id,
      name: SELLER.name,
      role: "WHOLESALER",
    },
  };

  try {
    const deps = buildDependencies(order);

    // Dial THIS vendor: the ladder starts at their rung rather than at the
    // roster's primary contact.
    //
    // Two roster filters are relaxed for this one call, because both exist to
    // help the agent CHOOSE a contact on its own, and here the operator has
    // already chosen:
    //
    //   working hours — stops the agent cold-calling at 3am on its own
    //     initiative. An operator pressing "Call" is the decision to ring this
    //     person now, and it is their business relationship.
    //   product categories — stops the agent picking a contact who does not
    //     handle the goods. A vendor the wholesaler just added and selected is
    //     by definition the right person to ask.
    //
    // Every control that protects the CALLEE still applies: kill switch,
    // recorded consent, E.164 validation, the per-order call cap, the
    // confidence floor and the price-approval gate. The operator's choice is
    // recorded on the order's audit trail under this traceId.
    const onDemandContact: Contact = {
      ...contact,
      workingHours: { ...contact.workingHours, start: "00:00", end: "23:59" },
      productCategories: [],
    };

    const finalState = await runCoordinationAgent(order, {
      ...deps,
      getDirectory: async () => [onDemandContact],
    });

    const structuredResult = finalState.structuredResults.at(-1) ?? null;
    const confidence = finalState.confidenceHistory.at(-1) ?? null;

    return NextResponse.json({
      orderId: order.id,
      traceId: order.traceId,
      outcome: finalState.finalOutcome,
      /** Null when the call produced nothing usable — never a placeholder. */
      structuredResult,
      completionConfidence: confidence,
      callPlaced: finalState.callHistory.length > 0,
      /** Set when the agent refused to dial or the call errored. */
      blockedReason: finalState.callError,
      targetPhone: maskPhone(contact.phoneE164),
      /**
       * "calle" = a real phone call through the CALL-E SDK.
       * "mock"  = the dev harness; the result below is invented.
       * Returned so a mock result can never be mistaken for a real one.
       */
      driver: useMock ? "mock" : "calle",
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "CALL-E call failed." },
      { status: 502 },
    );
  }
}
