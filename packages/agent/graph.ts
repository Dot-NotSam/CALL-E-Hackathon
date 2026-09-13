/**
 * packages/agent/graph.ts
 * LangGraph coordination agent — main graph definition.
 * Owner: Aryan
 *
 * Graph topology (PRD §10.1):
 *
 *   START
 *     │  mode=COORDINATE          mode=VERIFY (a follow-up firing)
 *     ▼                                    │
 *   assess_order                           │
 *        │                                 │
 *   ┌────┴────┐                            │
 * suppress   select_contact ◄────────┐     │
 *   │              │                 │     │
 *  END         plan_call ◄───────────┼─────┘
 *                  │                 │
 *             execute_call ──► CALL-E SDK (real phone call)
 *                  │                 │
 *               decide               │
 *      ┌──────┬────┴────┬────────┬───┴───┐
 *   confirm  approval  callback  human_  verify   (VERIFY runs only)
 *      │        │        │      review     │
 *     END      END      END      END    ┌──┴──┐
 *                                     END   escalate
 *                                             │
 *                                   [cap] → unresolved → END
 *
 * A follow-up (VERIFICATION or REMAINING_QUANTITY) is the SAME graph on the
 * SAME order carrying the SAME trace_id. It enters at plan_call because the
 * order was already assessed and the contact is the one who made the
 * commitment — not whoever the ladder would pick today.
 *
 * Every node emits an SSE event and an agent_events row carrying the same
 * trace_id (Rule 7).
 *
 * State channels use Annotation.Root — each field is a last-value channel, so a
 * node's returned update replaces the previous value. Do NOT hand-roll
 * `{ value: (x) => x }` reducers: LangGraph invokes a channel reducer as
 * `reducer(current, incoming)`, so a single-argument identity silently discards
 * every update after the first.
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { CoordinationState, CoordinationMode } from "./state";
import { lastStructuredResult, lastConfidence, toContext } from "./state";
import {
  assessOrder,
  type DuplicateCandidate,
} from "./nodes/assessOrder";
import { selectBestContact, mayOverrideWorkingHours } from "./nodes/selectContact";
import { executeCall, narrowResult, type PersistCallFn } from "./nodes/executeCall";
import { decide, explainDecision } from "./nodes/decide";
import { escalate } from "./nodes/escalate";
import { confirm, type ConfirmCallbacks } from "./nodes/confirm";
import { approval, type ApprovalCallbacks } from "./nodes/approval";
import { scheduleCallback, type ScheduleCallbackCallbacks } from "./nodes/scheduleCallback";
import { humanReview, type HumanReviewCallbacks } from "./nodes/humanReview";
import { unresolved, type UnresolvedCallbacks } from "./nodes/unresolved";
import { verify, type VerifyCallbacks } from "./nodes/verify";
import { buildCallPlanSummary, getMustAskQuestions } from "../calle/prompt";
import type {
  Contact,
  Organization,
  OrderItem,
  Trigger,
  Urgency,
  CallRecord,
  CallState,
  WholesaleResult,
  OrderOutcome,
  ApprovalRequest,
  FollowUp,
  Confidence,
  FollowUpKind,
} from "../types";

// ─── State channels ──────────────────────────────────────────────────────────
// One channel per CoordinationState field. Bare `Annotation<T>` = last value wins.

export const CoordinationAnnotation = Annotation.Root({
  orderId: Annotation<string>,
  traceId: Annotation<string>,
  reference: Annotation<string>,
  mode: Annotation<CoordinationMode>,
  followUpKind: Annotation<FollowUpKind | null>,
  followUpId: Annotation<string | null>,
  urgency: Annotation<Urgency>,
  requiredBy: Annotation<string>,
  buyer: Annotation<Organization>,
  seller: Annotation<Organization>,
  item: Annotation<OrderItem>,
  trigger: Annotation<Trigger>,
  rung: Annotation<number>,
  maxRungs: Annotation<number>,
  attemptedContacts: Annotation<string[]>,
  currentContact: Annotation<Contact | null>,
  callHistory: Annotation<CallRecord[]>,
  structuredResults: Annotation<(WholesaleResult | null)[]>,
  confidenceHistory: Annotation<Confidence[]>,
  finalOutcome: Annotation<OrderOutcome | null>,
  pendingApproval: Annotation<ApprovalRequest | null>,
  followUps: Annotation<FollowUp[]>,
  requiresHumanReview: Annotation<boolean>,
  suppressReason: Annotation<string | null>,
  duplicateOf: Annotation<string | null>,
  callError: Annotation<string | null>,
  ladderExhausted: Annotation<boolean>,
  route: Annotation<string | null>,
});

// Compile-time guard: the annotation and CoordinationState must not drift.
type AnnotationState = typeof CoordinationAnnotation.State;
type AssertExtends<A extends B, B> = true;
export type _StateMatchesAnnotation = AssertExtends<AnnotationState, CoordinationState> &
  AssertExtends<CoordinationState, AnnotationState>;

// ─── Graph dependencies (injected by Sameer's backend) ───────────────────────
// The agent never touches the DB or SSE directly. All side effects are
// callbacks — this keeps the graph pure and replayable.

export interface AgentDependencies {
  /** Consented contacts for the seller on this order (FR-3.1). */
  getContacts: (organizationId: string) => Promise<Contact[]>;
  /** Other open requests, for duplicate suppression (FR-2.3). */
  getOpenOrders?: (sellerId: string) => Promise<DuplicateCandidate[]>;
  /** Product category this order needs cover for. */
  requiredCategory?: string;

  // Persistence + side effects (Sameer implements these)
  persistCall: PersistCallFn;
  confirmCallbacks: ConfirmCallbacks;
  approvalCallbacks: ApprovalCallbacks;
  scheduleCallbackCallbacks: ScheduleCallbackCallbacks;
  humanReviewCallbacks: HumanReviewCallbacks;
  unresolvedCallbacks: UnresolvedCallbacks;
  /** FR-5.4 — only needed if follow-up (VERIFY) runs are invoked. */
  verifyCallbacks?: VerifyCallbacks;

  // ── SSE emitters (Sameer implements these) ──────────────────────────────
  emitAgentEvent: (params: {
    orderId: string;
    node: string;
    decision: string;
    reason: string;
    traceId: string;
  }) => void;

  emitSSEOrderSuppressed: (params: {
    orderId: string;
    reason: string;
    duplicateOf?: string;
  }) => void;

  emitSSEContactSelected: (params: {
    orderId: string;
    contact: Contact;
    rung: number;
  }) => void;

  emitSSEPlanComposed: (params: {
    orderId: string;
    summary: string;
    mustAsk: string[];
  }) => void;

  /** FR-4.3 — live call lifecycle, drives the call theatre visuals. */
  emitSSECallState?: (params: {
    orderId: string;
    callId: string;
    state: CallState;
    ts: string;
    traceId: string;
  }) => void;

  /** FR-4.3 — transcript turns as CALL-E reports them. */
  emitSSETranscriptDelta?: (params: {
    orderId: string;
    speaker: "AGENT" | "HUMAN";
    text: string;
    ts: string;
    traceId: string;
  }) => void;

  /** FR-4.4 — the typed extraction, confidence and evidence. */
  emitSSEResultExtracted?: (params: {
    orderId: string;
    structured: WholesaleResult;
    confidence: Confidence;
    evidence: string[];
    traceId: string;
  }) => void;

  emitSSEOrderEscalated?: (params: {
    orderId: string;
    fromRung: number;
    toRung: number;
    reason: string;
    traceId: string;
  }) => void;

  /**
   * FR-7.4 — the global kill switch. Checked immediately before every dial.
   *
   * If this is not supplied the agent FAILS CLOSED and refuses to call: a
   * missing kill switch is a broken kill switch, and SAFETY.md promises this
   * check exists. Sameer's backend wires it to POST /api/v1/killswitch.
   */
  isKillSwitchActive?: () => Promise<boolean>;

  /**
   * FR-7.4 — hard ceiling on total calls per order, independent of the rung
   * cap. Enforced in code so no prompt or model output can raise it.
   */
  maxCallsPerOrder?: number;

  /** Hard ceiling on any single call's duration. */
  callTimeoutMs?: number;

  /**
   * FR-7.3 — whether this facility permits an URGENT order to call outside a
   * contact's working hours. Defaults to false.
   */
  allowUrgentOutsideWorkingHours?: boolean;

  /** Use the mock CALL-E driver? (dev only) */
  useMock?: boolean;
}

/** PRD §7.4 / FR-7.4 — default ceiling on calls per order. */
export const DEFAULT_MAX_CALLS_PER_ORDER = 5;

// ─── Build the graph ─────────────────────────────────────────────────────────

export function buildCoordinationGraph(deps: AgentDependencies) {
  const graph = new StateGraph(CoordinationAnnotation)

    // ── Node: assess_order ───────────────────────────────────────────────────
    .addNode("assess_order", async (state) => {
      const existingOrders = deps.getOpenOrders
        ? await deps.getOpenOrders(state.seller.id)
        : [];

      const outcome = assessOrder(state, { existingOrders });

      if (outcome.route === "suppress") {
        deps.emitSSEOrderSuppressed({
          orderId: state.orderId,
          reason: outcome.reason,
          ...(outcome.duplicateOf ? { duplicateOf: outcome.duplicateOf } : {}),
        });
      }

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "assess_order",
        decision: outcome.route,
        reason: outcome.reason,
        traceId: state.traceId,
      });

      return {
        suppressReason: outcome.route === "suppress" ? outcome.reason : null,
        duplicateOf: outcome.duplicateOf,
        // Urgency is recomputed here: a callback can fire hours after the
        // order opened, and the prompt must frame the call on current time.
        urgency: outcome.urgency,
        route: outcome.route,
      };
    })

    // ── Node: select_contact ─────────────────────────────────────────────────
    .addNode("select_contact", async (state) => {
      const roster = await deps.getContacts(state.seller.id);

      const { contact, rejections } = selectBestContact(state, roster, {
        requiredCategory: deps.requiredCategory,
        allowOutsideWorkingHours: mayOverrideWorkingHours(
          state.urgency,
          deps.allowUrgentOutsideWorkingHours ?? false
        ),
      });

      if (contact) {
        deps.emitSSEContactSelected({
          orderId: state.orderId,
          contact,
          rung: state.rung,
        });
      }

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "select_contact",
        decision: contact ? "contact_found" : "no_contact",
        reason: contact
          ? `Selected ${contact.name} (${contact.role}) at ${state.seller.name} — rung ${state.rung}.`
          : `No eligible contact at ${state.seller.name}. ` +
            (rejections.length
              ? rejections.map((r) => `${r.name}: ${r.reason}`).join(" ")
              : "The roster is empty."),
        traceId: state.traceId,
      });

      return {
        currentContact: contact,
        route: contact ? "plan_call" : "unresolved",
      };
    })

    // ── Node: plan_call ──────────────────────────────────────────────────────
    .addNode("plan_call", async (state) => {
      // Guaranteed non-null: select_contact routes here only when set, and a
      // VERIFY run is created with the contact who made the commitment.
      const contact = state.currentContact!;
      const ctx = toContext(state);

      const isFollowUp = state.mode === "VERIFY";

      const summary = isFollowUp
        ? followUpPlanSummary(state, contact)
        : buildCallPlanSummary(ctx, contact);

      const mustAsk = isFollowUp
        ? followUpMustAsk(state)
        : getMustAskQuestions(ctx);

      deps.emitSSEPlanComposed({ orderId: state.orderId, summary, mustAsk });

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "plan_call",
        decision: "plan_ready",
        reason: summary,
        traceId: state.traceId,
      });

      return {};
    })

    // ── Node: execute_call ───────────────────────────────────────────────────
    .addNode("execute_call", async (state) => {
      // ── FR-7.4 — kill switch. Nothing dials past this point. ──────────────
      // Fails closed: if the check itself errors, or was never wired up, we
      // treat the switch as ACTIVE. A safety control that silently degrades to
      // "allow" is not a safety control.
      let killSwitchActive: boolean;
      if (!deps.isKillSwitchActive) {
        killSwitchActive = true;
      } else {
        try {
          killSwitchActive = await deps.isKillSwitchActive();
        } catch {
          killSwitchActive = true;
        }
      }

      if (killSwitchActive) {
        const reason = deps.isKillSwitchActive
          ? "Outbound calling is halted by the global kill switch."
          : "No kill switch check was wired into the agent — refusing to dial (fail-closed).";

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "execute_call",
          decision: "kill_switch_active",
          reason,
          traceId: state.traceId,
        });

        return { callError: reason };
      }

      // FR-7.4 — call cap, enforced before dialling. Separate from the rung
      // cap: callbacks and retries burn calls without advancing a rung.
      const maxCalls = deps.maxCallsPerOrder ?? DEFAULT_MAX_CALLS_PER_ORDER;
      if (state.callHistory.length >= maxCalls) {
        const reason =
          `Call cap reached (${state.callHistory.length}/${maxCalls}) for order ` +
          `${state.reference} — refusing to dial again.`;

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "execute_call",
          decision: "call_cap_reached",
          reason,
          traceId: state.traceId,
        });

        return { callError: reason };
      }

      const startedAt = new Date().toISOString();

      try {
        const { callId, result } = await executeCall(state, deps.persistCall, {
          useMock: deps.useMock,
          timeoutMs: deps.callTimeoutMs,
          hooks: {
            onState: (callState, calleCallId) =>
              deps.emitSSECallState?.({
                orderId: state.orderId,
                callId: calleCallId,
                state: callState,
                ts: new Date().toISOString(),
                traceId: state.traceId,
              }),
            onTranscript: (turn) =>
              deps.emitSSETranscriptDelta?.({
                orderId: state.orderId,
                speaker: turn.speaker,
                text: turn.text,
                ts: new Date().toISOString(),
                traceId: state.traceId,
              }),
          },
        });

        const structuredResult = narrowResult(result.structuredResult);
        const confidence = result.completionConfidence ?? { score: 0, label: "none" };

        if (structuredResult) {
          deps.emitSSEResultExtracted?.({
            orderId: state.orderId,
            structured: structuredResult,
            confidence,
            evidence: result.evidence,
            traceId: state.traceId,
          });
        }

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "execute_call",
          decision: result.status,
          reason:
            `taskCompleted=${result.taskCompleted}, confidence=${confidence.score}` +
            (structuredResult ? `, next_action=${structuredResult.next_action}` : ", no usable result"),
          traceId: state.traceId,
        });

        const endedAt = new Date().toISOString();

        return {
          // Appended unconditionally, null included, so index N of this array,
          // confidenceHistory and callHistory always describe the same call.
          structuredResults: [...state.structuredResults, structuredResult],
          confidenceHistory: [...state.confidenceHistory, confidence],
          callHistory: [
            ...state.callHistory,
            {
              callId,
              orderId: state.orderId,
              contactId: state.currentContact!.id,
              rung: state.rung,
              state: result.status as CallState,
              taskCompleted: result.taskCompleted ?? false,
              confidenceScore: confidence.score,
              confidenceLabel: confidence.label,
              evidence: result.evidence,
              structuredResult,
              startedAt,
              endedAt,
              durationSeconds: Math.round(
                (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000
              ),
              traceId: state.traceId,
            },
          ],
          callError: null,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "execute_call",
          decision: "call_error",
          reason: errorMsg,
          traceId: state.traceId,
        });

        return { callError: errorMsg };
      }
    })

    // ── Node: decide ─────────────────────────────────────────────────────────
    .addNode("decide", async (state) => {
      // A call we have no result for cannot produce a commitment. The kill
      // switch, the call cap, a poll timeout and an SDK failure all land here.
      //
      // Where it routes depends on WHY. A kill switch or cap is a deliberate
      // stop, and a timeout is an unknown outcome with a possibly-live call on
      // the line — neither may advance the ladder. An SDK error is a failure of
      // ours, and the ladder should advance (PRD §9 "call drops → retry, then
      // escalate"; withRetry has already exhausted its attempts by here).
      if (state.callError) {
        const route = mustNotAdvanceLadder(state.callError)
          ? "unresolved"
          : "escalate";

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "decide",
          decision: route,
          reason: `Call did not complete: ${state.callError}`,
          traceId: state.traceId,
        });

        return { route };
      }

      // A follow-up asks a different question — "did it actually dispatch?" —
      // so it is judged by the verify node, not the coordination decision
      // table. Routing it through `decide` would read a status check as a
      // fresh commitment and re-confirm an order that never shipped.
      if (state.mode === "VERIFY") {
        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "decide",
          decision: "verify",
          reason: "Follow-up call — routing to verification.",
          traceId: state.traceId,
        });

        return { route: "verify" };
      }

      const decision = decide(state);
      const reason = explainDecision(state, decision);

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "decide",
        decision,
        reason,
        traceId: state.traceId,
      });

      return {
        requiresHumanReview: decision === "human_review",
        route: decision,
      };
    })

    // ── Node: verify ─────────────────────────────────────────────────────────
    // FR-5.4 — did the commitment actually hold? Only reached on a VERIFY run.
    .addNode("verify", async (state) => {
      if (!deps.verifyCallbacks) {
        const reason =
          "A follow-up run was invoked without verifyCallbacks wired — cannot " +
          "record the verification outcome.";

        deps.emitAgentEvent({
          orderId: state.orderId,
          node: "verify",
          decision: "not_wired",
          reason,
          traceId: state.traceId,
        });

        return { route: "human_review", callError: reason };
      }

      const { route, updates, reason } = await verify(state, deps.verifyCallbacks, {
        followUpId: state.followUpId ?? undefined,
      });

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "verify",
        decision: route === "confirm" ? "commitment_held" : "commitment_missed",
        reason,
        traceId: state.traceId,
      });

      // `verify` already wrote the order on the paths where it had something to
      // say, so a held commitment ends the run rather than re-entering confirm.
      //
      // Escalating LEAVES VERIFY MODE. The ladder is about to pick a different
      // contact, and the follow-up prompt opens with "you confirmed 120 cases
      // previously" — said to someone who confirmed nothing, it is simply
      // false, and `decide` would route their answer straight back into
      // `verify` for a commitment they never made. A missed commitment
      // escalated to a new person is a fresh coordination call.
      if (route === "escalate") {
        return { ...updates, mode: "COORDINATE" as const, route: "escalate" };
      }

      return { ...updates, route: "done" };
    })

    // ── Node: escalate ───────────────────────────────────────────────────────
    .addNode("escalate", async (state) => {
      const { nextNode, updatedState, reason } = escalate(state);
      const exhausted = nextNode === "unresolved";

      if (!exhausted) {
        deps.emitSSEOrderEscalated?.({
          orderId: state.orderId,
          fromRung: state.rung,
          toRung: state.rung + 1,
          reason,
          traceId: state.traceId,
        });
      }

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "escalate",
        decision: exhausted ? "ladder_exhausted" : `rung_${state.rung}_to_${state.rung + 1}`,
        reason,
        traceId: state.traceId,
      });

      return { ...updatedState, ladderExhausted: exhausted, route: nextNode };
    })

    // ── Node: confirm (full and partial) ─────────────────────────────────────
    .addNode("confirm", async (state) => {
      const updates = await confirm(state, deps.confirmCallbacks);

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "confirm",
        decision: updates.finalOutcome?.status ?? "confirmed",
        reason: updates.finalOutcome?.summary ?? "Order updated.",
        traceId: state.traceId,
      });

      return updates;
    })

    // ── Node: approval ───────────────────────────────────────────────────────
    .addNode("approval", async (state) => {
      const updates = await approval(state, deps.approvalCallbacks);

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "approval",
        decision: "approval_required",
        reason: updates.pendingApproval?.reason ?? "A commercial change needs a person.",
        traceId: state.traceId,
      });

      return updates;
    })

    // ── Node: schedule_callback ──────────────────────────────────────────────
    .addNode("schedule_callback", async (state) => {
      const updates = await scheduleCallback(state, deps.scheduleCallbackCallbacks);
      const followUp = updates.followUps?.[updates.followUps.length - 1];

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "schedule_callback",
        decision: "callback_scheduled",
        reason: `Callback scheduled for ${followUp?.dueAt ?? "the requested time"}.`,
        traceId: state.traceId,
      });

      return updates;
    })

    // ── Node: human_review ───────────────────────────────────────────────────
    .addNode("human_review", async (state) => {
      const updates = await humanReview(state, deps.humanReviewCallbacks);

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "human_review",
        decision: "parked",
        reason:
          updates.finalOutcome?.summary ??
          `Parked for operator review. Confidence: ${lastConfidence(state)?.score ?? "N/A"}.`,
        traceId: state.traceId,
      });

      return updates;
    })

    // ── Node: unresolved ─────────────────────────────────────────────────────
    .addNode("unresolved", async (state) => {
      const updates = await unresolved(state, deps.unresolvedCallbacks);

      deps.emitAgentEvent({
        orderId: state.orderId,
        node: "unresolved",
        decision: "unresolved",
        reason: updates.finalOutcome?.summary ?? "Order unresolved.",
        traceId: state.traceId,
      });

      return updates;
    })

    // ── Edges ────────────────────────────────────────────────────────────────
    // Each edge reads `state.route`, written by the node that just ran, so the
    // branch taken is always the same value emitted to the audit log.

    // A follow-up run skips assessment and contact selection entirely: the
    // order was already assessed, and this call goes to the person who made
    // the commitment rather than to whoever the ladder would pick today.
    .addConditionalEdges(
      START,
      (state) => (state.mode === "VERIFY" ? "plan_call" : "assess_order"),
      { plan_call: "plan_call", assess_order: "assess_order" }
    )

    .addConditionalEdges(
      "assess_order",
      (state) => (state.route === "suppress" ? "suppress" : "select_contact"),
      { suppress: END, select_contact: "select_contact" }
    )

    .addConditionalEdges(
      "select_contact",
      (state) => (state.currentContact ? "plan_call" : "unresolved"),
      { plan_call: "plan_call", unresolved: "unresolved" }
    )

    .addEdge("plan_call", "execute_call")
    .addEdge("execute_call", "decide")

    .addConditionalEdges(
      "decide",
      (state) => state.route ?? "human_review",
      {
        // CONFIRM_ORDER and PARTIAL_CONFIRMATION share the confirm node — it
        // reads the quantities and picks the status. `decide` still returns
        // them separately so the audit trail distinguishes the two.
        confirm: "confirm",
        partial: "confirm",
        approval: "approval",
        escalate: "escalate",
        schedule_callback: "schedule_callback",
        human_review: "human_review",
        unresolved: "unresolved",
        // Only reachable on a VERIFY run.
        verify: "verify",
      }
    )

    // `verify` writes the order itself on both non-escalating paths, so a held
    // commitment simply ends. A missed one re-enters the ladder.
    .addConditionalEdges(
      "verify",
      (state) => {
        if (state.route === "escalate") return "escalate";
        // Reached only when verifyCallbacks was never wired — the run cannot
        // record its own outcome, so a person has to.
        if (state.route === "human_review") return "human_review";
        return "done";
      },
      { escalate: "escalate", human_review: "human_review", done: END }
    )

    // The rung cap is decided inside escalate() and carried on ladderExhausted.
    // Never re-derive it from `rung` here: after a successful advance the rung
    // already equals the value the next call should use.
    .addConditionalEdges(
      "escalate",
      (state) => (state.ladderExhausted ? "unresolved" : "select_contact"),
      { select_contact: "select_contact", unresolved: "unresolved" }
    )

    .addEdge("confirm", END)
    .addEdge("approval", END)
    .addEdge("schedule_callback", END)
    .addEdge("human_review", END)
    .addEdge("unresolved", END);

  return graph.compile();
}

/**
 * The operator-facing plan line for a follow-up call (FR-4.1).
 *
 * Kept separate from `buildCallPlanSummary` because a follow-up is a different
 * promise: the coordination plan says "we are going to ask for 200 cases", and
 * this one says "we are going to check the 120 they already promised".
 */
function followUpPlanSummary(state: CoordinationState, contact: Contact): string {
  const { item, reference } = state;

  if (state.followUpKind === "REMAINING_QUANTITY") {
    return (
      `Follow-up: chase ${contact.name} at ${state.seller.name} for the ` +
      `${item.remainingQuantity ?? "outstanding"} ${item.unit} still owed on ${reference}`
    );
  }

  return (
    `Follow-up: verify ${contact.name} at ${state.seller.name} dispatched ` +
    `${item.confirmedQuantity ?? item.requestedQuantity} ${item.unit} against ${reference}`
  );
}

function followUpMustAsk(state: CoordinationState): string[] {
  const { item } = state;

  if (state.followUpKind === "REMAINING_QUANTITY") {
    return [
      `Are the remaining ${item.remainingQuantity ?? ""} ${item.unit} available now?`.replace(
        /\s+/g,
        " "
      ),
      `When will they dispatch?`,
    ];
  }

  return [`Has the order dispatched?`, `Can you confirm the quantity that went out?`];
}

/**
 * Must this failure stop here rather than ring the next contact?
 *
 * Two different reasons land in the same place:
 *
 * 1. A DELIBERATE STOP — kill switch or call cap. A person already decided;
 *    escalating past it to ring the next contact would be a bypass.
 *
 * 2. AN UNKNOWN OUTCOME — a poll timeout. We stopped watching; the call did
 *    not stop. OBSERVED twice (2026-09-13, 2026-09-14): CALL-E completed both
 *    abandoned calls with valid results, and exposes no cancel API. So at the
 *    moment we would escalate, a supplier may be mid-sentence agreeing to the
 *    order — and rung 2 would ring a second person about it. An unknown
 *    outcome is not a failed call, and the only safe move is to hand it to a
 *    human, who can look the call up by id.
 *
 * 3. AN ACCOUNT-LEVEL FAILURE — no balance. Nothing about the next contact is
 *    different; the account is out of money for all of them. OBSERVED
 *    2026-09-14: the agent escalated on "Insufficient CALL-E balance" and, on
 *    a three-rung ladder, would have retried the same dead account three times
 *    and then reported "escalation exhausted after 3 contacts" — which reads
 *    as a supplier problem and is not one. Escalation is for when a DIFFERENT
 *    HUMAN might answer differently.
 *
 * Matched on the reasons `execute_call` and CallTimeoutError write, plus the
 * SDK's own balance message. String matching on a vendor message is brittle;
 * the cost of a miss is the old behaviour, which is why it is a substring and
 * not an exact compare.
 */
function mustNotAdvanceLadder(callError: string): boolean {
  const reason = callError.toLowerCase();

  return (
    reason.includes("kill switch") ||
    reason.includes("call cap reached") ||
    reason.includes("fail-closed") ||
    reason.includes("may still be live") ||
    reason.includes("balance") ||
    reason.includes("quota") ||
    reason.includes("insufficient")
  );
}

/** Re-exported for tests and the backend's own audit rendering. */
export { lastStructuredResult, lastConfidence };
