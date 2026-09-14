/**
 * Domain types — wholesale coordination (PRD v2.0 §7.2, §12).
 * Owners: Sameer + Aryan.
 *
 * STATUS: FROZEN (CLAUDE.md Rule 4). This is the single definition of the
 * wholesale model, imported by the dashboard, the agent and the CALL-E layer
 * alike. `apps/web/src/lib/contracts/domain.ts` re-exports this file and adds
 * nothing — if a shape is missing, it is added HERE, never redeclared there.
 *
 * Field-by-field documentation lives in `docs/FRONTEND_BACKEND_CONTRACT.md`,
 * which is what the backend implements.
 *
 * `WholesaleResult` is the PRD §7.2 CALL-E `resultSchema`, transcribed
 * verbatim. Nothing else here may redefine what a call extracts — the runtime
 * schema handed to CALL-E is `WHOLESALE_COORDINATION_RESULT_SCHEMA` in
 * `packages/calle/wholesale.ts`, and the two must move together.
 *
 * The v1 incident model in `./index.ts` is retained for the escalation agent
 * and its tests; new work targets this file.
 */

/* ─── Organisations and contacts ─────────────────────────────────────────── */

export type OrganizationRole = "WHOLESALER" | "DISTRIBUTOR";

export interface Organization {
  id: string;
  name: string;
  role: OrganizationRole;
}

/*
 * Shapes that travel inside SSE events are `type` aliases, not interfaces: the
 * event validators are loose objects (they keep unknown keys), and TypeScript
 * only treats type aliases as assignable to an index-signature type.
 */

export type WorkingHours = {
  /** HH:mm, local to `timezone`. */
  start: string;
  end: string;
  timezone: string;
};

/** A consented business contact. Only these numbers are ever callable (FR-7.2). */
export type Contact = {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  phoneE164: string;
  productCategories: string[];
  region: string;
  workplaceLocation?: string;
  livingLocation?: string;
  shopName?: string;
  workingHours: WorkingHours;
  /** 1 = primary, 2 = backup, 3 = supervisor. */
  escalationPriority: number;
  preferredLanguage: string;
  consentAt: string;
  cooldownUntil: string | null;
};

/* ─── Orders ─────────────────────────────────────────────────────────────── */

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
  confirmedQuantity: number | null;
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
  item: OrderItem;
  status: OrderStatus;
  urgency: Urgency;
  requiredBy: string;
  trigger: Trigger;
  createdAt: string;
  closedAt: string | null;
  currentRung: number;
  maxRungs: number;
  outcome: string | null;
  operatorMinutesSaved: number | null;
  scenarioId: string;
}

/* ─── The call ───────────────────────────────────────────────────────────── */

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
 * FR-6.3 / PRD §6 — a result below this confidence is never auto-applied to the
 * order; it goes to a person. Enforced in code, never in the prompt.
 */
export const HUMAN_REVIEW_THRESHOLD = 0.7;

export interface TranscriptTurn {
  id: string;
  speaker: Speaker;
  text: string;
  ts: string;
}

export interface AgentEvent {
  id: string;
  node: string;
  label: string;
  detail?: string;
  ts: string;
  state: "done" | "live" | "pending" | "failed";
}

/** One rung of the contact ladder, as rendered on the order screen. */
export interface LadderRung {
  rung: number;
  contact: Contact;
  state: "pending" | "active" | "declined" | "no_answer" | "committed" | "deferred";
  detail?: string;
}

/** A commercial change the agent is not allowed to accept (FR-5.3, PRD §17). */
export interface ApprovalRequest {
  reason: string;
  previousUnitPrice: number;
  proposedUnitPrice: number;
  currency: string;
}
