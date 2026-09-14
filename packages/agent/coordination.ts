/**
 * packages/agent/coordination.ts
 * Public entry points for the wholesale coordination agent.
 * Owner: Aryan
 *
 * The backend calls `runCoordinationAgent()` when an order needs a supplier
 * commitment, and `runFollowUpCall()` when a scheduled follow-up comes due.
 * Everything else in this package is internal.
 */

import { buildCoordinationGraph, type CoordinationDependencies } from "./coordinationGraph";
import {
  createInitialCoordinationState,
  type CoordinationState,
} from "./coordinationState";
import type { Order, FollowUp, Contact } from "../types/wholesale";

/**
 * Runs the full contact ladder for an order until it commits, parks, or
 * exhausts its rungs.
 *
 * The graph is pure: every side effect (DB write, SSE frame, notification)
 * happens through a callback on `deps`. That is what makes a run replayable
 * from its agent_events rows.
 */
export async function runCoordinationAgent(
  order: Order,
  deps: CoordinationDependencies
): Promise<CoordinationState> {
  const initialState = createInitialCoordinationState(order);
  const graph = buildCoordinationGraph(deps);

  return (await graph.invoke(initialState)) as CoordinationState;
}

export interface FollowUpDependencies extends CoordinationDependencies {
  /** Resolves the contact the follow-up is owed to. */
  getContact: (contactId: string) => Promise<Contact | null>;
  /** Marks the follow-up done or cancelled once the call has been made. */
  closeFollowUp: (params: {
    followUpId: string;
    status: "DONE" | "CANCELLED";
    reason: string;
  }) => Promise<void>;
}

/**
 * Places a scheduled follow-up call — a verification (F14, "confirmed but never
 * dispatched"), an agreed callback (F5), or a chase for the balance of a
 * partial confirmation.
 *
 * Deliberately reuses the full graph rather than dialling directly: a follow-up
 * that reaches nobody must escalate up the same ladder, under the same kill
 * switch, call cap and confidence rules as a first call. A second dialling path
 * with its own weaker rules is exactly how safety controls get bypassed.
 *
 * The follow-up's own contact is placed at rung 1 by seeding `attemptedContacts`
 * with everyone ahead of them, so the ladder resumes rather than restarts.
 */
export async function runFollowUpCall(
  order: Order,
  followUp: FollowUp,
  deps: FollowUpDependencies
): Promise<CoordinationState> {
  const contact = await deps.getContact(followUp.contactId);

  if (!contact) {
    await deps.closeFollowUp({
      followUpId: followUp.id,
      status: "CANCELLED",
      reason: `Contact ${followUp.contactId} is no longer in the consented directory.`,
    });

    deps.emitAgentEvent({
      orderId: order.id,
      node: "follow_up",
      decision: "cancelled",
      reason: `Follow-up ${followUp.id} cancelled — contact not found or consent withdrawn.`,
      traceId: order.traceId,
    });

    return createInitialCoordinationState(order);
  }

  deps.emitAgentEvent({
    orderId: order.id,
    node: "follow_up",
    decision: followUp.kind.toLowerCase(),
    reason: `${followUp.kind} follow-up due — calling ${contact.name}. ${followUp.note}`,
    traceId: order.traceId,
  });

  const state = createInitialCoordinationState(order);
  const graph = buildCoordinationGraph(deps);

  const finalState = (await graph.invoke({
    ...state,
    // Resume the ladder at this contact's rung rather than starting over.
    rung: Math.max(1, contact.escalationPriority),
  })) as CoordinationState;

  await deps.closeFollowUp({
    followUpId: followUp.id,
    status: "DONE",
    reason: `Follow-up call completed with outcome ${finalState.finalOutcome ?? "UNKNOWN"}.`,
  });

  return finalState;
}

export { buildCoordinationGraph, type CoordinationDependencies } from "./coordinationGraph";
export {
  createInitialCoordinationState,
  type CoordinationState,
} from "./coordinationState";
export {
  decideCoordination,
  type CoordinationDecision,
} from "./nodes/decideCoordination";
export { selectBestContact, isWithinWorkingHours } from "./nodes/selectContact";
