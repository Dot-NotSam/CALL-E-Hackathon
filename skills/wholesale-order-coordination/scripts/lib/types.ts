/**
 * VENDORED — do not edit.
 *
 * Generated from packages/types/index.ts by packages/agent/scripts/vendor-skill.mjs.
 * Edit the source file and re-run the generator; edits here are overwritten.
 */

/**
 * packages/types/index.ts
 * Shared contracts for Sentinel Ops — wholesale coordination (PRD v2.0).
 * Owner: Sameer (contracts) — Aryan consumes these in the agent.
 *
 * FROZEN: do not change without owner agreement (CLAUDE.md Rule 4).
 *
 * ── Provenance ───────────────────────────────────────────────────────────────
 *
 * These shapes are the canonical home of the contract documented field by field
 * in `docs/FRONTEND_BACKEND_CONTRACT.md`. The dashboard currently declares a
 * faithful mirror in `apps/web/src/lib/contracts/`, because this package still
 * held the v1 incident model when the dashboard was built (contract doc §8 #4).
 * That mirror is now redundant: the dashboard should switch its imports here
 * and delete the folder. Until it does, a field changes in BOTH places or in
 * neither.
 *
 * `WholesaleResult` is the PRD §7.2 CALL-E `resultSchema` transcribed verbatim.
 * Nothing else in the codebase may redefine what a call extracts — the runtime
 * JSON Schema handed to CALL-E lives in `packages/calle/schema.ts` and is
 * compile-time checked against this type.
 */

// ─── Organisations and contacts ──────────────────────────────────────────────

export type OrganizationRole = "WHOLESALER" | "DISTRIBUTOR";

export interface Organization {
  id: string;
  name: string;
  role: OrganizationRole;
}

/*
 * Shapes that travel inside SSE events are `type` aliases, not interfaces: the
 * dashboard's event validators are loose objects (they keep unknown keys), and
 * TypeScript only treats type aliases as assignable to an index-signature type.
 * Changing one of these to an `interface` breaks the dashboard's validation.
 */

export type WorkingHours = {
  /** HH:mm, local to `timezone`. */
  start: string;
  end: string;
  timezone: string;
};

/**
 * A consented business contact. Only these numbers are ever callable (FR-7.2).
 *
 * `consentAt` is not decorative — `selectContact` refuses to return a contact
 * without it, so an un-consented row added straight to the database cannot be
 * dialled.
 */
export type Contact = {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  /** E.164, e.g. +919876543210. */
  phoneE164: string;
  productCategories: string[];
  region: string;
  workplaceLocation?: string;
  livingLocation?: string;
  shopName?: string;
  workingHours: WorkingHours;
  /** 1 = primary, 2 = backup, 3 = supervisor. */
  escalationPriority: number;
  /** e.g. "en-IN", "hi-IN". */
  preferredLanguage: string;
  /** When consent to receive coordination calls was recorded. */
  consentAt: string;
  /** ISO-8601, or null when the contact is immediately callable (FR-3.4). */
  cooldownUntil: string | null;
};

// ─── Orders ──────────────────────────────────────────────────────────────────

export type OrderStatus =
  | "AWAITING_CONFIRMATION"
  | "CALLING"
  | "CONFIRMED"
  | "PARTIALLY_CONFIRMED"
  | "APPROVAL_REQUIRED"
  | "CALLBACK_SCHEDULED"
  | "HUMAN_REVIEW"
  | "UNRESOLVED"
  | "SUPPRESSED";

/** FR-2.2 — derived from the required date, stock risk and delivery window. */
export type Urgency = "ROUTINE" | "PRIORITY" | "URGENT";

/** FR-1.1 — what created the coordination request. */
export type TriggerType = "ORDER" | "INVENTORY" | "DELIVERY" | "EXCEPTION" | "IOT";

export interface OrderItem {
  sku: string;
  description: string;
  unit: string;
  requestedQuantity: number;
  /** Set when a call confirms stock. Null until then. */
  confirmedQuantity: number | null;
  /** Set on a partial confirmation. Null until then. */
  remainingQuantity: number | null;
  unitPrice: number;
  currency: string;
}

export interface Trigger {
  type: TriggerType;
  summary: string;
  receivedAt: string;
}

export type FollowUpKind = "VERIFICATION" | "CALLBACK" | "REMAINING_QUANTITY";
export type FollowUpStatus = "SCHEDULED" | "DONE" | "CANCELLED";

/** A call or check the system has committed to make later (FR-5.4). */
export type FollowUp = {
  id: string;
  orderId: string;
  kind: FollowUpKind;
  dueAt: string;
  contactId: string;
  note: string;
  status: FollowUpStatus;
};

export interface Order {
  /** System id of the coordination request, e.g. CR-1007. Routes and events use this. */
  id: string;
  /** The business's own order number, e.g. ORD-482 (PRD §12 `external_order_id`). */
  reference: string;
  traceId: string;
  buyer: Organization;
  seller: Organization;
  /** One line item per order in v2.0 (contract doc §8 #6). */
  item: OrderItem;
  status: OrderStatus;
  urgency: Urgency;
  requiredBy: string;
  trigger: Trigger;
  createdAt: string;
  closedAt: string | null;
  currentRung: number;
  maxRungs: number;
  /** One human-readable sentence, shown in the queue. */
  outcome: string | null;
  operatorMinutesSaved: number | null;
}

// ─── The call ────────────────────────────────────────────────────────────────

/**
 * Note the deliberate spelling shift from CALL-E's own vocabulary: CALL-E says
 * "dialing", this contract says "dialling". `packages/calle/progress.ts` owns
 * the mapping. Do not "fix" either side independently.
 */
export type CallState =
  | "queued"
  | "dialling"
  | "connected"
  | "in_conversation"
  | "extracting"
  | "completed"
  | "failed"
  | "no_answer";

export type Speaker = "AGENT" | "HUMAN";

// ─── CALL-E result schema types (frozen contract — PRD §7.2) ─────────────────

export type ContactReached = "yes" | "no" | "wrong_person" | "voicemail" | "unknown";

export type StockStatus = "confirmed" | "partial" | "unavailable" | "unknown";

export type NextAction =
  | "CONFIRM_ORDER"
  | "PARTIAL_CONFIRMATION"
  | "REQUEST_APPROVAL"
  | "SCHEDULE_CALLBACK"
  | "ESCALATE_NEXT_CONTACT"
  | "HUMAN_REVIEW";

/** PRD §7.2 — `WHOLESALE_COORDINATION_RESULT_SCHEMA`, as CALL-E returns it. */
export interface WholesaleResult {
  contact_reached: ContactReached;
  stock_status: StockStatus;
  confirmed_quantity?: number;
  remaining_quantity?: number;
  unit_price?: number;
  currency?: string;
  dispatch_date?: string;
  delivery_eta?: string;
  delay_reason?: string;
  callback_requested_at?: string;
  requires_approval?: boolean;
  verbatim_commitment?: string;
  next_action: NextAction;
}

export interface Confidence {
  score: number;
  label: string;
}

/**
 * FR-5.6 / PRD §6 — a result below this confidence is never auto-applied to an
 * order; it goes to a person. Enforced in code, never in the prompt.
 *
 * PRD §6 sets the target for "ambiguous results auto-closed" at 0%. This
 * constant is how that target is met, so it is exported rather than inlined —
 * the agent, the backend and the dashboard must all gate on the same number.
 */
export const HUMAN_REVIEW_THRESHOLD = 0.7;

export interface TranscriptTurn {
  id: string;
  speaker: Speaker;
  text: string;
  ts: string;
}

/** One CALL-E call, persisted verbatim for the audit trail (FR-4.4). */
export interface CallRecord {
  callId: string;
  orderId: string;
  contactId: string;
  /** 1 = primary, 2 = backup, 3 = supervisor. */
  rung: number;
  state: CallState;
  taskCompleted: boolean;
  confidenceScore: number;
  confidenceLabel: string;
  /** CALL-E `evidence`, stored verbatim. Never normalised. */
  evidence: string[];
  /** CALL-E `structuredResult`, stored verbatim. Never normalised. */
  structuredResult: WholesaleResult | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  traceId: string;
}

// ─── WholesaleCoordinationContext — backend → agent (PRD §14.1) ─────────────

/**
 * What Sameer's backend hands the agent to start a coordination run.
 *
 * Resolves contract doc §8 #3, which named this type but left it undefined.
 * It carries `orderId` and `traceId` so every event the agent emits reaches the
 * right SSE stream and the right audit rows (Rule 7).
 *
 * `contact` is absent at entry: choosing it is `select_contact`'s job, and it
 * changes on every rung. The backend supplies the roster to choose from through
 * `AgentDependencies.getContacts`, not through this context.
 */
export interface WholesaleCoordinationContext {
  orderId: string;
  traceId: string;
  reference: string;
  urgency: Urgency;
  requiredBy: string;
  buyer: Organization;
  seller: Organization;
  item: OrderItem;
  trigger: Trigger;
  /** 1-indexed. A fresh order starts at rung 1. */
  rung: number;
}

// ─── Outcome ─────────────────────────────────────────────────────────────────

/**
 * What a coordination run produced. Written by the terminal nodes and persisted
 * by the outcome engine.
 */
export interface OrderOutcome {
  orderId: string;
  contactId: string | null;
  status: OrderStatus;
  /** Whether the supplier committed to anything at all. */
  committed: boolean;
  confirmedQuantity: number | null;
  remainingQuantity: number | null;
  /** Set only when an operator approved a price change. */
  unitPrice: number | null;
  dispatchDate: string | null;
  deliveryEta: string | null;
  /** One human-readable sentence. Shown verbatim in the outcome strip. */
  summary: string;
  operatorMinutesSaved: number | null;
}

/** A commercial change the agent is not allowed to accept (FR-5.3, PRD §17). */
export interface ApprovalRequest {
  reason: string;
  previousUnitPrice: number;
  proposedUnitPrice: number;
  currency: string;
}

// ─── SSE event schema (frozen — docs/FRONTEND_BACKEND_CONTRACT.md §4.3) ─────

/**
 * The 13 events the dashboard listens for. The call-level events keep their v1
 * names — they are domain-neutral — and only the id field moved from
 * `incidentId` to `orderId`.
 *
 * Every event carries enough context to render its panel without a refetch.
 * Validate with Zod at both ends; the dashboard drops and counts a malformed
 * frame rather than throwing.
 */
export type SentinelEvent =
  /* ── Assessment ─────────────────────────────────────────────── */
  | { type: "event.received"; orderId: string; triggerType: TriggerType; summary: string; ts: string }
  | { type: "order.opened"; orderId: string; urgency: Urgency; requiredBy: string }
  | { type: "order.suppressed"; orderId: string; reason: string; duplicateOf?: string }

  /* ── Contact selection and the call ─────────────────────────── */
  | { type: "contact.selected"; orderId: string; contact: Contact; rung: number }
  | { type: "plan.composed"; orderId: string; summary: string; mustAsk: string[] }
  | { type: "call.state"; orderId: string; callId: string; state: CallState; ts?: string }
  | { type: "transcript.delta"; orderId: string; speaker: Speaker; text: string; ts: string }
  | {
      type: "result.extracted";
      orderId: string;
      structured: WholesaleResult;
      confidence: Confidence;
      evidence: string[];
    }

  /* ── Decisions and outcomes ─────────────────────────────────── */
  | { type: "order.escalated"; orderId: string; fromRung: number; toRung: number; reason: string }
  | {
      type: "approval.required";
      orderId: string;
      reason: string;
      previousUnitPrice: number;
      proposedUnitPrice: number;
      currency: string;
    }
  | { type: "followup.scheduled"; orderId: string; followUp: FollowUp }
  | {
      type: "order.updated";
      orderId: string;
      status: OrderStatus;
      confirmedQuantity: number | null;
      remainingQuantity: number | null;
      /** Present only when an approved change replaces the price. */
      unitPrice?: number;
      summary: string;
      operatorMinutesSaved: number | null;
    }
  | { type: "order.unresolved"; orderId: string; reason: string };
