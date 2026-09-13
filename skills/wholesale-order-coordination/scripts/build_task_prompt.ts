/**
 * skills/wholesale-order-coordination/scripts/build_task_prompt.ts
 *
 * Dynamic, rung-aware CALL-E task prompt composition.
 *
 * There is exactly ONE prompt builder in this project. This file re-exports it
 * rather than copying it: a forked prompt is how the self-identification rule,
 * the third-party protection rule, the no-commercial-authority rule, and the
 * 90-second ceiling quietly get lost.
 *
 * ── Why the prompt is composed, not templated ────────────────────────────────
 *
 * A static string is a robocall. The same order is framed differently at
 * rung 1 (first contact, factual), rung 2 (the primary could not commit, time
 * has been spent), and rung 3 (supervisor, the order is still unconfirmed) —
 * and the deadline language scales with the hours left before `requiredBy`.
 *
 * The prompt also encodes every conversational failure worth handling:
 *
 *   partial stock    → take it, then ALWAYS ask when the remainder follows
 *   price changed    → record it, never accept it, ask them to hold the stock
 *   "should be fine" → ask ONCE for something concrete, then stop pressing
 *   refusal          → get the reason, then the earliest alternative
 *   "call me back"   → get a time, repeat it back
 *   wrong person     → withhold every order detail, end
 *   voicemail        → minimal message, no reference/quantity/price
 *   IVR              → never navigate menus; end
 *
 * The partial-stock branch is the one that matters most: a supplier saying
 * "we only have 120" is the normal case, and an agent that treats it as a
 * failure throws away the answer the buyer actually needed.
 *
 * ── Before you edit ──────────────────────────────────────────────────────────
 *
 * Validate with scripts/plan_call.ts first. It is free, and it fails the build
 * on an unrendered template hole, a missing self-identification, a missing
 * third-party protection clause, or a missing price-authority clause.
 */

export {
  buildWholesaleCoordinationPrompt,
  buildFollowUpPrompt,
  buildCallPlanSummary,
  getMustAskQuestions,
} from "./lib/prompt";

export { WHOLESALE_COORDINATION_RESULT_SCHEMA } from "./lib/schema";

export type { WholesaleCoordinationContext, Contact } from "./lib/types";
