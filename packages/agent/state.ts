/**
 * packages/agent/state.ts
 * LangGraph agent state definition — wholesale coordination.
 * Owner: Aryan
 *
 * This is the single source of truth for what data flows through
 * every node in the coordination graph.
 */

import type {
  Urgency,
  Organization,
  OrderItem,
  Trigger,
  Contact,
  CallRecord,
  WholesaleResult,
  OrderOutcome,
  Confidence,
  ApprovalRequest,
  FollowUp,
  FollowUpKind,
  WholesaleCoordinationContext,
} from "../types";

/**
 * Which job this graph run is doing.
 *
 * `COORDINATE` is a fresh order: assess it, pick a contact, call, decide.
 * `VERIFY` is a follow-up firing from the queue — a VERIFICATION or
 * REMAINING_QUANTITY call to the contact who already committed. It skips
 * assessment and contact selection (the contact is already known), uses the
 * short follow-up prompt, and routes through the `verify` node.
 *
 * Both are runs of the same graph on the same order carrying the same
 * trace_id, which is what makes a callback hours later part of one story
 * rather than a second incident (contract doc §5.4).
 */
export type CoordinationMode = "COORDINATE" | "VERIFY";

export interface CoordinationState {
  // ── Core identifiers ──────────────────────────────────────────────────────
  orderId: string;
  traceId: string;
  /** The business's own order number, e.g. ORD-482. Spoken on the call. */
  reference: string;

  // ── What this run is doing ────────────────────────────────────────────────
  mode: CoordinationMode;
  /** On a VERIFY run: which kind of follow-up triggered it. */
  followUpKind: FollowUpKind | null;
  /** On a VERIFY run: the follow-up's id, so it can be marked done. */
  followUpId: string | null;

  // ── Order facts (set once at entry, never mutated) ────────────────────────
  urgency: Urgency;
  requiredBy: string;
  buyer: Organization;
  seller: Organization;
  item: OrderItem;
  trigger: Trigger;

  // ── Escalation progress ───────────────────────────────────────────────────
  /** 1 = primary, 2 = backup, 3 = supervisor. 1-indexed. */
  rung: number;
  maxRungs: number;
  /** Contact IDs already tried on this order. */
  attemptedContacts: string[];
  currentContact: Contact | null;

  // ── Call history ──────────────────────────────────────────────────────────
  callHistory: CallRecord[];
  /**
   * One entry per call, INCLUDING calls whose payload was unusable — those are
   * `null`.
   *
   * The null matters. This array used to be appended to only when a call
   * produced a usable result, while `confidenceHistory` and `callHistory` were
   * appended to unconditionally. The three then drifted out of step, and
   * `lastStructuredResult()` would hand a LATER call the PREVIOUS call's
   * extraction — so `decide`, `escalate` and every summary reasoned about a
   * commitment made by a different contact on a different call.
   */
  structuredResults: (WholesaleResult | null)[];
  confidenceHistory: Confidence[];

  // ── Outcome ───────────────────────────────────────────────────────────────
  finalOutcome: OrderOutcome | null;
  /** Set when a commercial change needs a person (FR-5.3). */
  pendingApproval: ApprovalRequest | null;
  /** Follow-ups this run committed to (FR-5.4). */
  followUps: FollowUp[];
  requiresHumanReview: boolean;

  // ── Internal flags ────────────────────────────────────────────────────────
  /** Set if assess_order suppressed the request. */
  suppressReason: string | null;
  /** The order this one duplicates, when suppressed as a duplicate. */
  duplicateOf: string | null;
  /** Set if execute_call failed. */
  callError: string | null;
  /** Set by escalate when the rung cap is hit. */
  ladderExhausted: boolean;
  /** The branch a node chose; read by its edge. */
  route: string | null;
}

/**
 * Creates the initial state when an order enters the agent.
 * Called by the backend (Sameer) when invoking the graph.
 *
 * `maxRungs` defaults to 3 (PRD §18): primary, backup, supervisor.
 */
export function createInitialState(
  ctx: WholesaleCoordinationContext,
  maxRungs = 3
): CoordinationState {
  return {
    orderId: ctx.orderId,
    traceId: ctx.traceId,
    reference: ctx.reference,
    mode: "COORDINATE",
    followUpKind: null,
    followUpId: null,
    urgency: ctx.urgency,
    requiredBy: ctx.requiredBy,
    buyer: ctx.buyer,
    seller: ctx.seller,
    item: ctx.item,
    trigger: ctx.trigger,
    rung: ctx.rung,
    maxRungs,
    attemptedContacts: [],
    currentContact: null,
    callHistory: [],
    structuredResults: [],
    confidenceHistory: [],
    finalOutcome: null,
    pendingApproval: null,
    followUps: [],
    requiresHumanReview: false,
    suppressReason: null,
    duplicateOf: null,
    callError: null,
    ladderExhausted: false,
    route: null,
  };
}

/**
 * Creates the state for a follow-up run when a VERIFICATION or
 * REMAINING_QUANTITY job fires from the queue (FR-5.4).
 *
 * The contact is supplied rather than selected: this call goes to the person
 * who made the commitment, not to whoever the ladder would pick today. The
 * trace_id comes from the original order, so the follow-up appears on the same
 * stream and the same audit trail.
 *
 * `item` should carry the quantities already confirmed, so the prompt can say
 * "you confirmed 120, with 80 still to come" rather than re-briefing the order.
 */
export function createFollowUpState(
  ctx: WholesaleCoordinationContext,
  contact: Contact,
  followUp: { id: string; kind: FollowUpKind },
  maxRungs = 3
): CoordinationState {
  return {
    ...createInitialState(ctx, maxRungs),
    mode: "VERIFY",
    followUpKind: followUp.kind,
    followUpId: followUp.id,
    currentContact: contact,
  };
}

/** Rebuilds the context the prompt and call layers consume from graph state. */
export function toContext(state: CoordinationState): WholesaleCoordinationContext {
  return {
    orderId: state.orderId,
    traceId: state.traceId,
    reference: state.reference,
    urgency: state.urgency,
    requiredBy: state.requiredBy,
    buyer: state.buyer,
    seller: state.seller,
    item: state.item,
    trigger: state.trigger,
    rung: state.rung,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The extraction from the MOST RECENT call — null when that call produced
 * nothing usable.
 *
 * Deliberately does NOT fall back to an earlier call's result. A caller asking
 * "what did they say?" means the call that just happened; answering with a
 * different contact's answer is worse than answering "nothing".
 */
export function lastStructuredResult(state: CoordinationState): WholesaleResult | null {
  return state.structuredResults[state.structuredResults.length - 1] ?? null;
}

export function lastConfidence(state: CoordinationState): Confidence | null {
  return state.confidenceHistory[state.confidenceHistory.length - 1] ?? null;
}
