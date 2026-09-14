/**
 * Domain types — wholesale coordination (PRD v2.0 §7.2, §12).
 *
 * This file is a RE-EXPORT. The definitions now live in
 * `packages/types/wholesale.ts`, which the agent and the CALL-E layer import
 * directly, so the dashboard and the backend cannot drift apart (CLAUDE.md
 * Rule 4 — one definition, never two).
 *
 * Add a shape THERE, not here. Nothing in this file may redeclare a type;
 * if you find yourself wanting to, the shared contract is the thing to change,
 * with its owners' agreement (Sameer + Aryan).
 *
 * The import path stays `@/lib/contracts/domain` so the 30-odd dashboard
 * modules that import it are untouched.
 */

export * from "@sentinel/types/wholesale";
