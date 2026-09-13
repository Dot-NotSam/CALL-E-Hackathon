/**
 * packages/agent/index.ts
 * Public entry point for the Sentinel Ops coordination agent.
 * Owner: Aryan
 *
 * Sameer's backend calls `runCoordinationAgent()` when an order needs a
 * supplier confirmation. Everything else is internal to this package.
 */

export {
  buildCoordinationGraph,
  CoordinationAnnotation,
  DEFAULT_MAX_CALLS_PER_ORDER,
  type AgentDependencies,
} from "./graph";

export {
  createInitialState,
  createFollowUpState,
  toContext,
  lastStructuredResult,
  lastConfidence,
  type CoordinationState,
  type CoordinationMode,
} from "./state";

export {
  assessOrder,
  urgencyFor,
  findDuplicate,
  toDuplicateCandidate,
  type AssessResult,
  type DuplicateCandidate,
} from "./nodes/assessOrder";

export {
  selectBestContact,
  isWithinWorkingHours,
  isOutOfCooldown,
  hasConsent,
  mayOverrideWorkingHours,
  type SelectContactResult,
} from "./nodes/selectContact";

export {
  decide,
  explainDecision,
  reconcileQuantities,
  priceChanged,
  dispatchMissesDeadline,
  type DecideResult,
} from "./nodes/decide";

export { escalate, type EscalateResult } from "./nodes/escalate";
export { confirm, verificationDueAt, nextBusinessMorning } from "./nodes/confirm";
export { approval } from "./nodes/approval";
export { scheduleCallback, resolveCallbackTime } from "./nodes/scheduleCallback";
export { humanReview } from "./nodes/humanReview";
export { unresolved } from "./nodes/unresolved";
export { verify, buildVerificationTaskPrompt, type VerifyResult } from "./nodes/verify";
export { narrowResult, type PersistCallFn } from "./nodes/executeCall";

import { buildCoordinationGraph, type AgentDependencies } from "./graph";
import { createInitialState, createFollowUpState, type CoordinationState } from "./state";
import type { WholesaleCoordinationContext, Contact, FollowUpKind } from "../types";

/**
 * Top-level function Sameer's backend calls to start a coordination run.
 *
 * @param ctx  The WholesaleCoordinationContext built by the ingest layer
 * @param deps All backend callbacks (DB, SSE, roster, kill switch)
 * @param maxRungs Ladder depth. Default 3: primary, backup, supervisor.
 * @returns Final CoordinationState after the graph terminates
 */
export async function runCoordinationAgent(
  ctx: WholesaleCoordinationContext,
  deps: AgentDependencies,
  maxRungs = 3
): Promise<CoordinationState> {
  const initialState = createInitialState(ctx, maxRungs);
  const graph = buildCoordinationGraph(deps);

  return await graph.invoke(initialState);
}

/**
 * Runs a follow-up call when a VERIFICATION or REMAINING_QUANTITY job fires
 * from the queue (FR-5.4).
 *
 * This is the same graph on the same order carrying the same `trace_id` — it
 * simply enters at `plan_call` instead of `assess_order`, uses the short
 * follow-up prompt, and routes through the `verify` node. The dashboard sees
 * one continuous story rather than a second order.
 *
 * `ctx.item` should carry the quantities already confirmed, so the call can say
 * "you confirmed 120, with 80 to come" rather than re-briefing the order.
 * `deps.verifyCallbacks` must be wired; without it the run parks for a person.
 *
 * @param contact  The contact who made the commitment — NOT re-selected.
 */
export async function runFollowUpCall(
  ctx: WholesaleCoordinationContext,
  contact: Contact,
  followUp: { id: string; kind: FollowUpKind },
  deps: AgentDependencies
): Promise<CoordinationState> {
  const initialState = createFollowUpState(ctx, contact, followUp);
  const graph = buildCoordinationGraph(deps);

  return await graph.invoke(initialState);
}
