/**
 * packages/calle/planCall.ts
 * FR-4.1 — pre-flight validation of a composed task prompt.
 * Owner: Aryan
 *
 * ── What this can and cannot check ──────────────────────────────────────────
 *
 * CORRECTED 2026-09-14, after listing the tool schema on the live MCP server.
 * This file previously assumed `plan_call(task, resultSchema)` — a dry run of
 * the exact payload we send CALL-E. **No such parameter exists.**
 *
 * The MCP surface and the SDK surface are DIFFERENT PRODUCTS:
 *
 *   SDK (what we ship)  calle.calls.create({ task, resultSchema })
 *                       → our composed prompt, our typed extraction schema
 *   MCP (this file)     plan_call({ user_input, goal, language, region,
 *                                   to_phones })
 *                       → a conversational planner that builds a plan card,
 *                         returns ready_to_run + a confirm_token for run_call
 *
 * So `plan_call` CANNOT validate `WHOLESALE_COORDINATION_RESULT_SCHEMA`, and
 * nothing here proves the typed extraction works. Only a live call does that
 * (testing log entries #9 and #10). The mistake went unnoticed because the
 * transport is optional and every caller so far passed none, taking the
 * local-lint-only branch.
 *
 * What remains genuinely useful:
 *
 *   1. `lintTaskPrompt` — a local pre-flight that costs nothing and catches
 *      the failures we have actually shipped: an unrendered context field
 *      reaching a supplier's ear, a missing safety clause, an over-long
 *      briefing. This is now the ONLY automated pre-flight we have.
 *   2. FR-4.1 — a plan an operator can read before the phone rings.
 *
 * MCP server: https://seleven-mcp-sg.airudder.com/mcp/openagent_oauth
 * Tools: plan_call (plan) · run_call (live) · get_call_run (status)
 */

// NOTE: the result schema is deliberately NOT imported here any more.
// `plan_call` has no parameter to put it in — see the header.
import { buildWholesaleCoordinationPrompt } from "./prompt";
import type { WholesaleCoordinationContext, Contact } from "../types";

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * Arguments the REAL `plan_call` tool accepts.
 *
 * Verified against the live MCP server on 2026-09-14 by listing the tool
 * schema. Every field is optional; the tool asks for whatever is missing.
 */
export interface PlanCallArgs {
  /** The user's latest message, verbatim. The tool asks for this explicitly. */
  user_input: string;
  /** The instruction for the calling agent. */
  goal?: string;
  /** e.g. "English". Omitted rather than guessed. */
  language?: string;
  /** e.g. "IN". Omitted rather than guessed. */
  region?: string;
  /**
   * DELIBERATELY NOT SENT by `planCoordinationCall` — see the note there.
   * Present on the type only so the contract is complete and honest.
   */
  to_phones?: string[];
}

/**
 * Minimal shape of an MCP tool invocation. Whatever MCP client the host uses,
 * it can be adapted to this in a few lines.
 */
export type PlanCallTransport = (
  toolName: "plan_call",
  args: PlanCallArgs
) => Promise<unknown>;

// ─── Result ──────────────────────────────────────────────────────────────────

export interface PlanCallIssue {
  severity: "error" | "warning";
  message: string;
}

export interface PlanCallReport {
  ok: boolean;
  issues: PlanCallIssue[];
  /** Raw MCP response, kept verbatim for the audit trail. */
  raw: unknown;
}

// ─── Local pre-checks ────────────────────────────────────────────────────────
// These run before we bother the MCP server. They catch the mistakes that
// actually happened during development — an empty contact name leaking
// "undefined" into the opening line, a prompt so long the call runs past 90s.

/** PRD §7.3 — the call must stay under 90 seconds. */
const MAX_PROMPT_CHARS = 8_000;

/**
 * Literals that mean a context field did not render. Each of these reaches a
 * real supplier's ear if it ships, which is why they are errors rather than
 * warnings.
 *
 * "Invalid Date" is here because `formatForSpeech` deliberately degrades rather
 * than throwing on a malformed `requiredBy` — this is the check that catches it.
 */
const UNRENDERED_LITERALS = [
  "undefined",
  "null",
  "NaN",
  "[object Object]",
  "Invalid Date",
];

export function lintTaskPrompt(task: string): PlanCallIssue[] {
  const issues: PlanCallIssue[] = [];

  if (!task.trim()) {
    issues.push({ severity: "error", message: "Task prompt is empty." });
    return issues;
  }

  for (const hole of UNRENDERED_LITERALS) {
    if (task.includes(hole)) {
      issues.push({
        severity: "error",
        message: `Task prompt contains the literal "${hole}" — a context field did not render.`,
      });
    }
  }

  // FR-7.1 — the agent must always self-identify.
  if (!/automated operations line/i.test(task)) {
    issues.push({
      severity: "error",
      message:
        "Task prompt does not identify the caller as an automated operations line (FR-7.1).",
    });
  }

  // FR-7.5 — third-party protection must survive every prompt edit.
  if (!/never disclose order details/i.test(task)) {
    issues.push({
      severity: "error",
      message:
        "Task prompt does not forbid disclosing order details to an unverified " +
        "person (FR-7.5).",
    });
  }

  // FR-5.3 / PRD §17 — the agent may record a price change but never accept it.
  if (!/never agree to a price/i.test(task)) {
    issues.push({
      severity: "error",
      message:
        "Task prompt does not forbid agreeing to a price or terms change (FR-5.3).",
    });
  }

  if (task.length > MAX_PROMPT_CHARS) {
    issues.push({
      severity: "warning",
      message:
        `Task prompt is ${task.length} chars (soft limit ${MAX_PROMPT_CHARS}). ` +
        "Long briefings push the call past the 90-second ceiling.",
    });
  }

  return issues;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Checks the plan for a coordination call WITHOUT placing it.
 *
 * Spends zero call budget. Safe to run on every order, and safe to run in a
 * loop while tuning the prompt.
 *
 * The local lint is the substantive part. The MCP round-trip is a secondary
 * sanity check that CALL-E accepts the goal text at all — it does NOT see the
 * result schema and cannot tell you the extraction will work. Read the header
 * of this file before relying on it for anything.
 *
 * If no transport is supplied, the local lint still runs and the report says
 * so — an MCP outage must never block a real coordination call.
 */
export async function planCoordinationCall(
  ctx: WholesaleCoordinationContext,
  contact: Contact,
  transport?: PlanCallTransport
): Promise<PlanCallReport> {
  const task = buildWholesaleCoordinationPrompt(ctx, contact);
  const issues = lintTaskPrompt(task);

  if (!transport) {
    issues.push({
      severity: "warning",
      message: "No MCP transport supplied — ran local lint only, skipped plan_call.",
    });
    return { ok: !issues.some((i) => i.severity === "error"), issues, raw: null };
  }

  let raw: unknown = null;
  try {
    // ── `to_phones` is deliberately omitted ─────────────────────────────────
    //
    // Not an oversight. CALL-E's own tool description says a ready plan card
    // may "continue execution" on its own, so a validation call carrying a
    // real phone number is a validation call that can ring someone. We never
    // transmit the contact's number here, which means no plan built from this
    // request has a destination to dial — whatever the host does with it.
    //
    // What we have NOT verified: whether the server refuses ready_to_run
    // without a destination. The MCP tool schema marks `to_phones` optional,
    // but the `@call-e/cli` wrapper rejects a plan without one
    // (`invalid_arguments: Missing required --to-phone`, observed 2026-09-14),
    // so the two disagree and we could not test the tool's own behaviour.
    // The guarantee above rests on what we send, not on how CALL-E responds —
    // which is the only half we control.
    raw = await transport("plan_call", {
      user_input: `Validate this coordination call plan. Do not place the call.`,
      goal: task,
      language: contact.preferredLanguage,
    });
  } catch (err) {
    issues.push({
      severity: "warning",
      message: `plan_call failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, raw };
}
