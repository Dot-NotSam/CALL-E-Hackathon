/**
 * skills/wholesale-order-coordination/scripts/plan_call.ts
 *
 * FREE pre-flight validation of a composed task prompt. Spends no call budget.
 *
 * CALL-E's MCP server exposes `plan_call`, a dry run that validates a task +
 * resultSchema without dialling. Use it for every prompt change — a new
 * account has 20 free calls, and burning one to discover a typo is the most
 * expensive way to find a typo.
 *
 * Local checks run first, before the MCP round trip. Each of these is an
 * ERROR, not a warning, because each one reaches a real supplier's ear:
 *
 *   - unrendered template holes ("undefined", "[object Object]", "Invalid Date")
 *   - a missing "automated operations line" self-identification (FR-7.1)
 *   - a missing third-party protection clause (FR-7.5)
 *   - a missing price/terms authority clause (FR-5.3)
 *
 * The last three exist because they are the clauses most likely to be lost
 * while someone is tuning the wording for tone.
 *
 * A prompt long enough to push the call past its 90-second ceiling is a
 * warning. An MCP outage is also only a warning — prompt validation must never
 * be the reason a real order goes unconfirmed.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   const report = await planCoordinationCall(ctx, contact, mcpTransport);
 *   if (!report.ok) throw new Error(JSON.stringify(report.issues, null, 2));
 *
 * `mcpTransport` adapts whatever MCP client you already have:
 *
 *   const mcpTransport = (tool, args) => myMcpClient.callTool(tool, args);
 *
 * Omit it entirely to run local lint only.
 *
 * MCP server: https://seleven-mcp-sg.airudder.com/mcp/openagent_oauth
 * Tools: plan_call (dry run, free) · run_call (live) · get_call_run (status)
 */

export {
  planCoordinationCall,
  lintTaskPrompt,
  type PlanCallTransport,
  type PlanCallReport,
  type PlanCallIssue,
} from "./lib/planCall";
