/**
 * skills/wholesale-order-coordination/scripts/run_coordination.ts
 *
 * The coordination ladder, self-contained. Order in, confirmed supply
 * commitment out.
 *
 * Only dependency is `@call-e/calle`. All decision logic is vendored into
 * ./lib (generated from source — see the VENDORED banner in those files).
 *
 * ── Run it safely ────────────────────────────────────────────────────────────
 *
 *   CALLE_USE_MOCK=true npx ts-node scripts/run_coordination.ts
 *
 * That dials nobody and spends nothing. Change the outcome to watch the ladder
 * behave differently:
 *
 *   CALLE_USE_MOCK=true MOCK_OUTCOME=price_change  npx ts-node scripts/run_coordination.ts
 *   CALLE_USE_MOCK=true MOCK_OUTCOME=no_answer     npx ts-node scripts/run_coordination.ts
 *   CALLE_USE_MOCK=true MOCK_OUTCOME=vague         npx ts-node scripts/run_coordination.ts
 *
 * ── Run it for real ──────────────────────────────────────────────────────────
 *
 * CALLE_USE_MOCK=false RINGS A REAL BUSINESS. Read references/safety.md first.
 */

import {
  createInitialState,
  lastStructuredResult,
  toContext,
  type CoordinationState,
} from "./lib/state";
import { assessOrder } from "./lib/assessOrder";
import { selectBestContact, mayOverrideWorkingHours } from "./lib/selectContact";
import { decide, reconcileQuantities, priceChanged } from "./lib/decide";
import { escalate } from "./lib/escalate";
import { buildWholesaleCoordinationPrompt } from "./lib/prompt";
import { WHOLESALE_COORDINATION_RESULT_SCHEMA } from "./lib/schema";
import {
  pollCallToCompletion,
  withRetry,
  toSentinelCallState,
  DEFAULT_CALL_TIMEOUT_MS,
  type CallProgressHooks,
  type PollableCall,
} from "./lib/progress";
import type {
  Contact,
  Organization,
  OrderItem,
  Trigger,
  CallState,
  WholesaleResult,
} from "./lib/types";

import sampleContacts from "../assets/sample-contacts.json";

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface OrderInput {
  /** The business's own order number, e.g. ORD-482. Spoken on the call. */
  reference: string;
  sku: string;
  description: string;
  unit: string;
  requestedQuantity: number;
  unitPrice: number;
  currency: string;
  /** ISO-8601. Drives urgency. */
  requiredBy: string;
  orderId?: string;
  traceId?: string;
}

export interface CallResult {
  status: string;
  taskCompleted: boolean | null;
  completionConfidence: { score: number; label: string } | null;
  evidence: string[];
  structuredResult: WholesaleResult | null;
}

export interface RunCoordinationInput {
  order: OrderInput;
  buyer: Organization;
  seller: Organization;
  contacts: Contact[];
  /** Product category the contact must cover. Omit to skip the filter. */
  requiredCategory?: string;

  /**
   * FR-7.4 — checked immediately before EVERY dial. Fails closed: omit it and
   * nothing is called. See references/safety.md.
   */
  isKillSwitchActive?: () => Promise<boolean>;

  maxRungs?: number;
  /** Independent of the rung cap — callbacks and retries burn calls too. */
  maxCallsPerOrder?: number;
  callTimeoutMs?: number;
  /** FR-7.3 — permit an URGENT order to call outside working hours. */
  allowUrgentOutsideWorkingHours?: boolean;

  /** Swap the call layer. Defaults to the real CALL-E SDK. */
  placeCall?: (params: {
    task: string;
    contact: Contact;
    hooks: CallProgressHooks;
    timeoutMs: number;
  }) => Promise<CallResult>;

  hooks?: CallProgressHooks;
  onEvent?: (event: { node: string; decision: string; reason: string }) => void;
}

export interface CoordinationOutcome {
  status:
    | "CONFIRMED"
    | "PARTIALLY_CONFIRMED"
    | "APPROVAL_REQUIRED"
    | "CALLBACK_SCHEDULED"
    | "HUMAN_REVIEW"
    | "UNRESOLVED"
    | "SUPPRESSED";
  committed: boolean;
  confirmedQuantity: number | null;
  remainingQuantity: number | null;
  /** The price the supplier quoted, when it differs from the order's. */
  proposedUnitPrice: number | null;
  dispatchDate: string | null;
  rungsAttempted: number;
  /**
   * Every contact actually dialled, in order.
   *
   * Derived from the call history rather than from `attemptedContacts`, which
   * only records contacts the ladder MOVED PAST — on a successful first call
   * that list is empty, and reporting it would read as "nobody was called".
   */
  contactsCalled: string[];
  callsPlaced: number;
  committedContact: Contact | null;
  structuredResult: WholesaleResult | null;
  summary: string;
}

// ─── The real CALL-E call layer ──────────────────────────────────────────────

async function placeCallViaCalle(params: {
  task: string;
  contact: Contact;
  hooks: CallProgressHooks;
  timeoutMs: number;
}): Promise<CallResult> {
  // @call-e/calle is ESM-only (no "require" condition in its exports map).
  // A plain `await import()` is downlevelled to require() under CommonJS and
  // fails with ERR_PACKAGE_PATH_NOT_EXPORTED, so route through Function to
  // keep it a genuine dynamic ESM import.
  const importEsm = new Function("s", "return import(s);") as (
    s: string
  ) => Promise<typeof import("@call-e/calle")>;
  const { CalleClient } = await importEsm("@call-e/calle");

  if (!process.env.CALLE_API_KEY) {
    throw new Error(
      "CALLE_API_KEY is not set. Get one from dashboard.heycall-e.com/account/api-keys"
    );
  }

  const calle = new CalleClient({ apiKey: process.env.CALLE_API_KEY });

  // create() + poll rather than createAndWait(), so live state can be streamed
  // while the phone is ringing.
  const created = await calle.calls.create({
    task: params.task,
    recipient: {
      phone: params.contact.phoneE164,
      locale: params.contact.preferredLanguage,
    },
    resultSchema: WHOLESALE_COORDINATION_RESULT_SCHEMA as unknown as Record<string, unknown>,
  });

  params.hooks.onState?.(
    toSentinelCallState(created as unknown as PollableCall),
    created.id
  );

  const final = await pollCallToCompletion(
    created.id,
    async (id) => (await calle.calls.get(id)) as unknown as PollableCall,
    params.hooks,
    { timeoutMs: params.timeoutMs }
  );

  const call = final as unknown as {
    taskCompleted: boolean | null;
    completionConfidence: { score: number; label: string } | null;
    evidence: string[];
    structuredResult: unknown;
  };

  return {
    // The MAPPED state, not CALL-E's raw task status — the task-level status
    // lags the attempt by seconds, so a failed call reads as "queued".
    status: toSentinelCallState(final),
    taskCompleted: call.taskCompleted,
    completionConfidence: call.completionConfidence,
    evidence: call.evidence ?? [],
    structuredResult: (call.structuredResult as WholesaleResult) ?? null,
  };
}

// ─── The ladder ──────────────────────────────────────────────────────────────

export async function runCoordination(
  input: RunCoordinationInput
): Promise<CoordinationOutcome> {
  const emit = input.onEvent ?? (() => {});
  const maxCalls = input.maxCallsPerOrder ?? 5;
  const timeoutMs = input.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const placeCall = input.placeCall ?? placeCallViaCalle;

  const { order } = input;

  const item: OrderItem = {
    sku: order.sku,
    description: order.description,
    unit: order.unit,
    requestedQuantity: order.requestedQuantity,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: order.unitPrice,
    currency: order.currency,
  };

  const trigger: Trigger = {
    type: "ORDER",
    summary: `Order ${order.reference} needs supplier confirmation.`,
    receivedAt: new Date().toISOString(),
  };

  let state: CoordinationState = createInitialState(
    {
      orderId: order.orderId ?? `CR-${Date.now()}`,
      traceId: order.traceId ?? `trace-${Date.now()}`,
      reference: order.reference,
      // Recomputed by assess_order from requiredBy; this is only a seed.
      urgency: "PRIORITY",
      requiredBy: order.requiredBy,
      buyer: input.buyer,
      seller: input.seller,
      item,
      trigger,
      rung: 1,
    },
    input.maxRungs ?? 3
  );

  const outcome = (
    status: CoordinationOutcome["status"],
    summary: string
  ): CoordinationOutcome => {
    const result = lastStructuredResult(state);
    const quantities = reconcileQuantities(state);
    const committed = status === "CONFIRMED" || status === "PARTIALLY_CONFIRMED";

    return {
      status,
      committed,
      confirmedQuantity: committed ? quantities.confirmed : null,
      remainingQuantity: committed ? quantities.remaining : null,
      proposedUnitPrice: priceChanged(state) ? result?.unit_price ?? null : null,
      dispatchDate: committed ? result?.dispatch_date ?? null : null,
      rungsAttempted: state.rung,
      contactsCalled: state.callHistory.map((c) => c.contactId),
      callsPlaced: state.callHistory.length,
      committedContact: committed ? state.currentContact : null,
      structuredResult: result,
      summary,
    };
  };

  // ── assess_order ───────────────────────────────────────────────────────────
  const assessment = assessOrder(state);
  emit({ node: "assess_order", decision: assessment.route, reason: assessment.reason });

  if (assessment.route === "suppress") {
    return outcome("SUPPRESSED", assessment.reason);
  }

  // Urgency is recomputed from the required date, not taken on trust.
  state = { ...state, urgency: assessment.urgency };

  // ── the ladder ─────────────────────────────────────────────────────────────
  for (;;) {
    // select_contact
    const { contact, rejections } = selectBestContact(state, input.contacts, {
      requiredCategory: input.requiredCategory,
      allowOutsideWorkingHours: mayOverrideWorkingHours(
        state.urgency,
        input.allowUrgentOutsideWorkingHours ?? false
      ),
    });

    if (!contact) {
      const reason =
        `No eligible contact at ${input.seller.name}. ` +
        (rejections.length
          ? rejections.map((r) => `${r.name}: ${r.reason}`).join(" ")
          : "The directory is empty.");

      emit({ node: "select_contact", decision: "no_contact", reason });
      return outcome("UNRESOLVED", reason);
    }

    state = { ...state, currentContact: contact };
    emit({
      node: "select_contact",
      decision: "contact_found",
      reason: `Selected ${contact.name} (${contact.role}) — rung ${state.rung}.`,
    });

    // FR-7.4 — kill switch, before every dial, fails closed.
    let killSwitchActive = true;
    if (input.isKillSwitchActive) {
      try {
        killSwitchActive = await input.isKillSwitchActive();
      } catch {
        killSwitchActive = true;
      }
    }

    if (killSwitchActive) {
      const reason = input.isKillSwitchActive
        ? "Outbound calling is halted by the global kill switch."
        : "No kill switch check supplied — refusing to dial (fail-closed).";

      emit({ node: "execute_call", decision: "kill_switch_active", reason });
      // A deliberate stop must NOT walk the ladder looking for someone else.
      return outcome("UNRESOLVED", reason);
    }

    // FR-7.4 — call cap
    if (state.callHistory.length >= maxCalls) {
      const reason =
        `Call cap reached (${state.callHistory.length}/${maxCalls}) — refusing to dial again.`;
      emit({ node: "execute_call", decision: "call_cap_reached", reason });
      return outcome("UNRESOLVED", reason);
    }

    // plan_call
    const ctx = toContext(state);
    const task = buildWholesaleCoordinationPrompt(ctx, contact);
    emit({
      node: "plan_call",
      decision: "plan_ready",
      reason:
        `Rung ${state.rung}: call ${contact.name} re: ${state.reference} — ` +
        `${item.requestedQuantity} ${item.unit} of ${item.description}`,
    });

    // execute_call — retry with backoff, hard duration ceiling
    let call: CallResult;
    try {
      call = await withRetry(() =>
        placeCall({ task, contact, hooks: input.hooks ?? {}, timeoutMs })
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      emit({ node: "execute_call", decision: "call_error", reason });
      return outcome("HUMAN_REVIEW", `The call could not be completed: ${reason}`);
    }

    const confidence = call.completionConfidence ?? { score: 0, label: "none" };
    state = {
      ...state,
      // Appended unconditionally, null included, so index N of this array,
      // confidenceHistory and callHistory always describe the same call.
      // Skipping the null let a later call read an earlier one's extraction.
      structuredResults: [...state.structuredResults, call.structuredResult ?? null],
      confidenceHistory: [...state.confidenceHistory, confidence],
      callHistory: [
        ...state.callHistory,
        {
          callId: `call-${state.callHistory.length + 1}`,
          orderId: state.orderId,
          contactId: contact.id,
          rung: state.rung,
          state: call.status as CallState,
          taskCompleted: call.taskCompleted ?? false,
          confidenceScore: confidence.score,
          confidenceLabel: confidence.label,
          evidence: call.evidence,
          structuredResult: call.structuredResult,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationSeconds: null,
          traceId: state.traceId,
        },
      ],
    };

    emit({
      node: "execute_call",
      decision: call.status,
      reason: `taskCompleted=${call.taskCompleted}, confidence=${confidence.score}`,
    });

    // decide
    const decision = decide(state);
    emit({
      node: "decide",
      decision,
      reason:
        `next_action="${lastStructuredResult(state)?.next_action}", ` +
        `confidence=${confidence.score}`,
    });

    const result = lastStructuredResult(state);
    const quantities = reconcileQuantities(state);

    switch (decision) {
      case "confirm":
        return outcome(
          "CONFIRMED",
          `${contact.name} confirmed all ${quantities.confirmed ?? item.requestedQuantity} ` +
          `${item.unit}${result?.dispatch_date ? `, dispatching ${result.dispatch_date}` : ""}.`
        );

      case "partial":
        // Quantities that do not reconcile are a review case, not a commitment.
        if (quantities.conflicting) {
          return outcome("HUMAN_REVIEW", quantities.note ?? "Quantities did not reconcile.");
        }
        return outcome(
          "PARTIALLY_CONFIRMED",
          `${contact.name} confirmed ${quantities.confirmed} of ${item.requestedQuantity} ` +
          `${item.unit}; ${quantities.remaining} outstanding` +
          `${result?.delivery_eta ? ` (${result.delivery_eta})` : ""}.`
        );

      case "approval":
        return outcome(
          "APPROVAL_REQUIRED",
          `${contact.name} quoted ${result?.unit_price} ${result?.currency ?? item.currency} ` +
          `against ${item.unitPrice} on the order. The agent recorded it and did not accept it.`
        );

      case "schedule_callback":
        return outcome(
          "CALLBACK_SCHEDULED",
          `${contact.name} asked to be called back at ` +
          `${result?.callback_requested_at ?? "an unspecified time"}.`
        );

      case "human_review":
        return outcome(
          "HUMAN_REVIEW",
          `${contact.name} gave no clear answer (confidence ${confidence.score}). ` +
          "Nothing has been written to the order."
        );

      case "escalate": {
        const { nextNode, updatedState, reason } = escalate(state);
        state = { ...state, ...updatedState };
        emit({
          node: "escalate",
          decision: nextNode === "unresolved" ? "ladder_exhausted" : `rung_${state.rung}`,
          reason,
        });
        if (nextNode === "unresolved") {
          return outcome(
            "UNRESOLVED",
            `No contact at ${input.seller.name} could confirm order ${state.reference}. ` +
            `${item.requestedQuantity} ${item.unit} remain unconfirmed.`
          );
        }
        break;
      }
    }
  }
}

// ─── Runnable demo ───────────────────────────────────────────────────────────

/** ⚠️ SYNTHETIC fixtures. Every line is [MOCK]-labelled and none is real output. */
const MOCK_OUTCOMES: Record<string, CallResult> = {
  partial: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.91, label: "high" },
    evidence: [
      "[MOCK] The contact stated 120 cases were ready today.",
      "[MOCK] When asked about the balance, they committed to 80 tomorrow morning.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "partial",
      confirmed_quantity: 120,
      remaining_quantity: 80,
      unit_price: 1850,
      currency: "INR",
      dispatch_date: "2026-09-13T11:00:00.000Z",
      delivery_eta: "tomorrow morning for the balance",
      verbatim_commitment: "[MOCK] 120 today and the remaining 80 tomorrow morning.",
      next_action: "PARTIAL_CONFIRMATION",
    },
  },

  full: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.94, label: "high" },
    evidence: ["[MOCK] The contact confirmed all 200 cases in stock."],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      unit_price: 1850,
      currency: "INR",
      dispatch_date: "2026-09-13T12:30:00.000Z",
      verbatim_commitment: "[MOCK] All 200 are here, going out this evening.",
      next_action: "CONFIRM_ORDER",
    },
  },

  price_change: {
    status: "completed",
    taskCompleted: true,
    completionConfidence: { score: 0.89, label: "high" },
    evidence: [
      "[MOCK] The contact quoted 2050 per case against the order's 1850.",
      "[MOCK] The agent recorded the new price and did not accept it.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "confirmed",
      confirmed_quantity: 200,
      unit_price: 2050,
      currency: "INR",
      requires_approval: true,
      verbatim_commitment: "[MOCK] It's 2050 a case now, not 1850.",
      next_action: "REQUEST_APPROVAL",
    },
  },

  no_answer: {
    status: "no_answer",
    taskCompleted: false,
    completionConfidence: { score: 0, label: "none" },
    evidence: ["[MOCK] The call was not answered."],
    structuredResult: {
      contact_reached: "no",
      stock_status: "unknown",
      next_action: "ESCALATE_NEXT_CONTACT",
    },
  },

  vague: {
    status: "completed",
    taskCompleted: false,
    completionConfidence: { score: 0.58, label: "low" },
    evidence: [
      "[MOCK] The contact said stock 'should be fine' without a quantity.",
      "[MOCK] Asked again for a date, they said 'sometime this week'.",
    ],
    structuredResult: {
      contact_reached: "yes",
      stock_status: "unknown",
      verbatim_commitment: "[MOCK] Should be fine, sometime this week.",
      next_action: "CONFIRM_ORDER",
    },
  },
};

async function main() {
  const useMock = process.env.CALLE_USE_MOCK === "true";
  if (!useMock) {
    console.warn(
      "\n  CALLE_USE_MOCK is not 'true'. This will place a REAL phone call.\n" +
      "  Read references/safety.md, then re-run deliberately.\n"
    );
  }

  const contacts = sampleContacts as Contact[];
  const mockOutcome = MOCK_OUTCOMES[process.env.MOCK_OUTCOME ?? "partial"];
  if (!mockOutcome) {
    console.error(
      `Unknown MOCK_OUTCOME. Options: ${Object.keys(MOCK_OUTCOMES).join(", ")}`
    );
    process.exit(1);
  }

  const result = await runCoordination({
    order: {
      reference: "ORD-482",
      sku: "MED-TS-CASE",
      description: "temperature-sensitive medical supplies",
      unit: "cases",
      requestedQuantity: 200,
      unitPrice: 1850,
      currency: "INR",
      requiredBy: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    },
    buyer: { id: "org-northgate", name: "Northgate Distributors", role: "DISTRIBUTOR" },
    seller: { id: "org-metro-supply", name: "Metro Supply Co.", role: "WHOLESALER" },
    contacts,
    requiredCategory: "medical-supplies",
    isKillSwitchActive: async () => false,
    // The sample directory uses real business hours, so a demo run outside
    // 09:00–18:00 IST would otherwise find nobody to call.
    allowUrgentOutsideWorkingHours: true,

    placeCall: useMock
      ? async ({ hooks }) => {
          // The sequence CALL-E actually produces: `connected` never fires and
          // turns arrive at extraction, not during the call.
          const states: CallState[] =
            mockOutcome.status === "no_answer"
              ? ["queued", "dialling", "no_answer"]
              : ["queued", "dialling", "extracting", "completed"];

          for (const s of states) hooks.onState?.(s, "mock-call");
          return mockOutcome;
        }
      : undefined,

    hooks: {
      onState: (s) => console.log(`  [state] ${s}`),
      onTranscript: (t) => console.log(`  ${t.speaker}: ${t.text}`),
    },
    onEvent: ({ node, decision, reason }) =>
      console.log(`[${node}] ${decision} — ${reason}`),
  });

  console.log("\n─── Result ───");
  console.log("Status:             ", result.status);
  console.log("Committed:          ", result.committed);
  console.log("Confirmed quantity: ", result.confirmedQuantity ?? "none");
  console.log("Remaining quantity: ", result.remainingQuantity ?? "none");
  console.log("Proposed price:     ", result.proposedUnitPrice ?? "unchanged");
  console.log("Dispatch:           ", result.dispatchDate ?? "n/a");
  console.log("Rungs attempted:    ", result.rungsAttempted);
  console.log("Contacts called:    ", result.contactsCalled.join(", ") || "none");
  console.log("Calls placed:       ", result.callsPlaced);
  console.log("Summary:            ", result.summary);
}

// Run the demo when this file is executed directly, not when imported.
// `require.main` rather than `import.meta` — this file is compiled as
// CommonJS (see tsconfig.json), where import.meta is unavailable.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((err) => {
    console.error("Coordination failed:", err);
    process.exit(1);
  });
}
