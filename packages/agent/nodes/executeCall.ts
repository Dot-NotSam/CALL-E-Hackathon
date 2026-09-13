/**
 * packages/agent/nodes/executeCall.ts
 * Node: execute_call
 * Owner: Aryan
 *
 * The core node — invokes CALL-E and persists all artifacts (FR-4.2, FR-4.4).
 * Exits to: "decide"
 *
 * RULE: This is the ONLY place in the codebase that places a CALL-E call.
 * Never dial from anywhere else.
 *
 * Uses the real SDK in production.
 * Uses the mock driver in development (CALLE_USE_MOCK=true in .env).
 *
 * We drive the call with create() + our own poll loop rather than
 * createAndWait(), because the dashboard needs live `call.state` transitions
 * while the phone is ringing (FR-4.3). See ../../calle/progress.ts.
 */

import type { WholesaleResult, Contact } from "../../types";
import type { MockScenario } from "../../calle/mock";
import type { CoordinationState } from "../state";
import { toContext } from "../state";
import { WHOLESALE_COORDINATION_RESULT_SCHEMA } from "../../calle/schema";
import { buildWholesaleCoordinationPrompt, buildFollowUpPrompt } from "../../calle/prompt";
import { lastStructuredResult } from "../state";
import {
  pollCallToCompletion,
  withRetry,
  toSentinelCallState,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type CallProgressHooks,
  type PollableCall,
  type RetryOptions,
} from "../../calle/progress";

// ─── Call result type — matches the real CALL-E SDK `Call` shape ────────────

export interface CallEResult {
  id?: string;
  status: string;
  taskCompleted: boolean | null;
  completionConfidence: { score: number; label: string } | null;
  evidence: string[];
  structuredResult: Record<string, unknown> | null;
}

// ─── Persistence callback ────────────────────────────────────────────────────
// The agent never writes to the DB directly — it calls back (Sameer implements).

export type PersistCallFn = (params: {
  orderId: string;
  traceId: string;
  contactId: string;
  rung: number;
  status: string;
  taskCompleted: boolean;
  confidence: { score: number; label: string };
  /** Stored verbatim — this is the audit trail (FR-4.4). */
  evidence: string[];
  structuredResult: Record<string, unknown>;
  taskPrompt: string;
}) => Promise<{ callId: string }>;

export interface ExecuteCallOptions {
  useMock?: boolean;
  /** FR-4.3 — live progress out to the SSE stream. */
  hooks?: CallProgressHooks;
  /** Hard ceiling on call duration. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Backoff policy for the two retried operations. Injected in tests so the
   * SDK-failure cases do not spend three real seconds asleep.
   */
  retry?: RetryOptions;
}

// ─── Main execute function ───────────────────────────────────────────────────

export async function executeCall(
  state: CoordinationState,
  persistCall: PersistCallFn,
  options: ExecuteCallOptions = {}
): Promise<{ callId: string; result: CallEResult }> {
  const contact = state.currentContact;
  if (!contact) {
    throw new Error(
      `execute_call: no currentContact set on state for order ${state.orderId}`
    );
  }

  const useMock = options.useMock ?? process.env.CALLE_USE_MOCK === "true";
  const hooks = options.hooks ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const retry = options.retry ?? {};

  const taskPrompt = buildPromptForRun(state, contact);

  // ── Place the call and follow it to completion ────────────────────────────
  //
  // ── What is retried, and what is NOT ─────────────────────────────────────
  //
  // Only `create()` is retried. Once a call EXISTS, no failure may re-enter
  // this block, because CALL-E has no cancel API (testing log F-013): retrying
  // after a successful create dials the supplier a second time while the first
  // conversation is still live.
  //
  // This used to wrap create + poll together. A transient failure from a
  // single `calls.get()` — one dropped poll out of ninety on a four-minute
  // call — would fall through to withRetry and place an entirely new call. The
  // poll loop deliberately does not swallow those errors (see progress.ts), so
  // the retry belongs on the individual GET, which is where it now sits.
  //
  // Residual risk: if create() itself succeeds server-side but the response is
  // lost in transit, the retry makes a duplicate call. Nothing in the API lets
  // us detect that — there is no idempotency key — so it is documented, not
  // solved.
  //
  // An arrow assigned to a const, not a hoisted declaration: a declaration
  // could in principle be called before the `if (!contact) throw` above, so
  // TypeScript discards the narrowing and `contact` reads as possibly null.
  const placeCall = async (): Promise<CallEResult> => {
    if (useMock) {
      // ── Dev harness — never in the demo or the deployed app ───────────────
      // SENTINEL_MOCK_SCENARIO selects which supplier behaviour to replay so
      // tests can drive every branch. Defaults to the hero scenario.
      const { mockCalle } = await import("../../calle/mock");
      const scenario = (process.env.SENTINEL_MOCK_SCENARIO ??
        "partial_stock") as MockScenario;
      const delayMs = Number(process.env.SENTINEL_MOCK_DELAY_MS ?? 1500);

      const mockResult = await mockCalle.runCall(
        { task: taskPrompt, resultSchema: WHOLESALE_COORDINATION_RESULT_SCHEMA },
        scenario,
        hooks,
        delayMs
      );

      return {
        status: mockResult.status,
        taskCompleted: mockResult.taskCompleted,
        completionConfidence: mockResult.completionConfidence,
        evidence: mockResult.evidence,
        structuredResult: mockResult.structuredResult as unknown as Record<string, unknown>,
      };
    }

    // ── Real CALL-E SDK ──────────────────────────────────────────────────────
    // RULE: Before this code path runs, you must have explicit confirmation.
    // Log every live call in docs/CALLE_TESTING_LOG.md (CLAUDE.md Rule 2).
    const { getCalle } = await import("../../calle/client");
    const calle = await getCalle();

    // Retried: no call exists yet, so a retry here cannot double-dial.
    const created = await withRetry(
      () =>
        calle.calls.create({
          task: taskPrompt,
          recipient: {
            phone: contact.phoneE164,
            locale: contact.preferredLanguage,
          },
          resultSchema:
            WHOLESALE_COORDINATION_RESULT_SCHEMA as unknown as Record<string, unknown>,
          metadata: {
            orderId: state.orderId,
            reference: state.reference,
            traceId: state.traceId,
            rung: state.rung,
          },
        }),
      retry
    );

    // Emit the opening state immediately so the dashboard reacts on dial, not
    // on the first poll tick. Hand it to the poller as `alreadyEmitted` so the
    // first tick doesn't repeat it.
    const openingState = toSentinelCallState(created as unknown as PollableCall);
    hooks.onState?.(openingState, created.id);

    // The retry is on the individual GET, inside the loop. A dropped poll
    // costs us three quick attempts at reading the call's state; it never
    // costs the supplier a second phone call.
    const final = (await pollCallToCompletion(
      created.id,
      async (id) =>
        withRetry(
          async () => (await calle.calls.get(id)) as unknown as PollableCall,
          retry
        ),
      hooks,
      { intervalMs: pollIntervalMs, timeoutMs, alreadyEmitted: openingState }
    )) as unknown as typeof created;

    return {
      id: final.id,
      // The MAPPED state, not CALL-E's raw task status.
      //
      // OBSERVED (live call 2026-09-09): the attempt failed with SIP 480 while
      // `task.status` was still "queued" — the task-level status lags the
      // attempt by several seconds. Persisting the raw value recorded a failed
      // call as "queued" in the audit trail, which is worse than useless.
      status: toSentinelCallState(final as unknown as PollableCall),
      taskCompleted: final.taskCompleted ?? false,
      completionConfidence: final.completionConfidence as
        | { score: number; label: string }
        | null,
      evidence: final.evidence,
      structuredResult: final.structuredResult,
    } satisfies CallEResult;
  };

  const result = await placeCall();

  // ── Persist call artifacts (Sameer's backend handles the DB write) ───────
  const confidence = result.completionConfidence ?? { score: 0, label: "none" };
  const structuredResult = result.structuredResult ?? {};

  const { callId } = await persistCall({
    orderId: state.orderId,
    traceId: state.traceId,
    contactId: contact.id,
    rung: state.rung,
    status: result.status,
    taskCompleted: result.taskCompleted ?? false,
    confidence,
    evidence: result.evidence,
    structuredResult,
    taskPrompt,
  });

  return { callId, result };
}

/**
 * Picks the prompt this run should use.
 *
 * A follow-up is a status check, not a briefing — the supplier already had the
 * full conversation, and re-reading the order to them is how a useful 45-second
 * call becomes an irritating 90-second one.
 *
 * Exported so `plan_call` can show the operator the same prompt that will
 * actually be sent (FR-4.1). There must be exactly one answer to "what will
 * this call say", and this is it.
 */
export function buildPromptForRun(state: CoordinationState, contact: Contact): string {
  const ctx = toContext(state);

  if (state.mode !== "VERIFY") {
    return buildWholesaleCoordinationPrompt(ctx, contact);
  }

  const result = lastStructuredResult(state);

  return buildFollowUpPrompt(
    ctx,
    contact,
    state.followUpKind === "REMAINING_QUANTITY" ? "REMAINING_QUANTITY" : "VERIFICATION",
    {
      confirmedQuantity: state.item.confirmedQuantity ?? result?.confirmed_quantity,
      remainingQuantity: state.item.remainingQuantity ?? result?.remaining_quantity,
      dispatchDate: result?.dispatch_date,
    }
  );
}

/**
 * Narrows CALL-E's untyped `structuredResult` to a `WholesaleResult`.
 *
 * CALL-E returns whatever the extraction produced; the schema is a request, not
 * a guarantee. A payload missing one of the three required fields is not a
 * usable result, and returning null here routes the order to human review
 * rather than letting `undefined` reach the decision table.
 */
export function narrowResult(raw: Record<string, unknown> | null): WholesaleResult | null {
  if (!raw) return null;

  const { contact_reached, stock_status, next_action } = raw as Partial<WholesaleResult>;
  if (!contact_reached || !stock_status || !next_action) return null;

  return raw as unknown as WholesaleResult;
}

/** Re-exported so the graph can type its contact without reaching into types. */
export type { Contact };
