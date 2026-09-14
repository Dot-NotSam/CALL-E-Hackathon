/* istanbul ignore file -- @preserve
 *
 * Excluded from coverage deliberately. This is an operator probe, not library
 * code: every line of it places a REAL call to a consented number, so covering
 * it means spending a credit and ringing someone's phone. Counting it in the
 * denominator would only invite a fake test that imports the module and
 * asserts nothing. It is verified by running it — see the log entries in
 * docs/CALLE_TESTING_LOG.md.
 */

/**
 * packages/agent/scripts/live-verify-callstate.ts
 * ONE live call, through the real agent path, to verify FR-4.2 and FR-4.3.
 *
 * ⚠️  THIS RINGS A REAL PHONE AND SPENDS ONE CREDIT.
 *
 * What it verifies:
 *   1. create() + poll emits real queued → dialling → … → completed
 *      transitions — the data the order call screen renders.
 *   2. That the WHOLESALE result schema extracts correctly from live speech.
 *      The v1 incident schema was confirmed on 2026-09-08 (testing log P-003);
 *      the wholesale schema has NOT been through a live call, and quantities
 *      and dates are harder to extract than a single ETA number.
 *
 * Safety rails, all belt-and-braces so this cannot run away:
 *   - roster contains exactly ONE consented number
 *   - maxRungs = 1 and maxCallsPerOrder = 1, so it cannot escalate
 *   - every raw CALL-E payload is written to docs/live-call-raw.json
 *
 * Run:  node dist-probe/packages/agent/scripts/live-verify-callstate.js
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCoordinationAgent } from "../index";
import type { AgentDependencies } from "../graph";
import type { WholesaleCoordinationContext, Contact } from "../../types";

// ─── The one consented number ────────────────────────────────────────────────
// Never hardcode a number here — this file is committed. Set CALLE_TEST_PHONE
// in .env, and only ever to a team member who has agreed to receive test calls.
//
// argv[2] overrides it for a one-off call to a second consented roster member,
// so testing another number does not mean editing .env and forgetting to put it
// back. Passing a number here is still a consent assertion (FR-7.2): the person
// holding it has agreed to receive test calls. It is not a way around the rule.
const CONSENTED_PHONE = process.argv[2] ?? process.env.CALLE_TEST_PHONE ?? "";

// The agent greets this name and refuses to discuss the order with anyone else,
// so it has to match whoever actually answers argv[2].
const CONSENTED_NAME = process.argv[3] ?? "Aryan";

const CONTACT: Contact = {
  id: "ct-live-probe",
  organizationId: "org-metro-supply",
  name: CONSENTED_NAME,
  role: "Dispatch Lead",
  phoneE164: CONSENTED_PHONE,
  productCategories: ["medical-supplies"],
  region: "West",
  workingHours: { start: "00:00", end: "23:59", timezone: "Asia/Kolkata" },
  escalationPriority: 1,
  preferredLanguage: "en-IN",
  consentAt: new Date().toISOString(),
  cooldownUntil: null,
};

const CONTEXT: WholesaleCoordinationContext = {
  orderId: `CR-LIVE-${Date.now()}`,
  traceId: `trace-live-${Date.now()}`,
  reference: "ORD-482",
  urgency: "URGENT",
  requiredBy: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  buyer: { id: "org-northgate", name: "Northgate Distributors", role: "DISTRIBUTOR" },
  seller: { id: "org-metro-supply", name: "Metro Supply Co.", role: "WHOLESALER" },
  item: {
    sku: "MED-TS-CASE",
    description: "temperature-sensitive medical supplies",
    unit: "cases",
    requestedQuantity: 200,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: 1850,
    currency: "INR",
  },
  trigger: {
    type: "INVENTORY",
    summary: "Available stock fell below the reorder point.",
    receivedAt: new Date().toISOString(),
  },
  rung: 1,
};

// ─── Raw payload capture ─────────────────────────────────────────────────────
// Test-harness instrumentation only — wraps the SDK from outside, so the
// shipped code path is exactly what runs.

const rawPolls: unknown[] = [];
const stateTransitions: { at: string; state: string }[] = [];
const transcript: { speaker: string; text: string }[] = [];

async function instrumentSdk() {
  const { getCalle } = await import("../../calle/client");
  const calle = await getCalle();
  const originalGet = calle.calls.get.bind(calle.calls);

  (calle.calls as { get: typeof originalGet }).get = async (callId: string) => {
    const call = await originalGet(callId);
    rawPolls.push({ at: new Date().toISOString(), call });
    const attempt = (call as unknown as {
      recipients?: { attempts?: { status: string; failureCode?: string | null }[] }[];
    }).recipients?.[0]?.attempts?.slice(-1)[0];
    console.log(
      `    raw: task.status=${call.status}` +
      (attempt ? `  attempt.status=${attempt.status}` : "  (no attempt yet)") +
      (attempt?.failureCode ? `  failureCode=${attempt.failureCode}` : "")
    );
    return call;
  };
}

// ─── Go ──────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env.CALLE_USE_MOCK === "true") {
    console.error("CALLE_USE_MOCK is true — this probe is pointless. Unset it.");
    process.exit(1);
  }

  if (!CONSENTED_PHONE) {
    console.error(
      "CALLE_TEST_PHONE is not set. Refusing to dial.\n" +
      "Set it in .env to a consented team member's number (FR-7.2)."
    );
    process.exit(1);
  }

  await instrumentSdk();

  console.log("\n  LIVE CALL — a real phone will ring and one credit is spent.");
  console.log(`  Calling ${CONSENTED_PHONE} (consented, roster of one).`);
  console.log("  Caps: 1 rung, 1 call. It cannot escalate.\n");
  console.log("  Pick up. You are a dispatch lead at Metro Supply Co.");
  console.log("  Try: \"we only have 120 cases ready today\" — then give a time");
  console.log("  for the remaining 80 when the agent asks.\n");

  const deps: AgentDependencies = {
    getContacts: async () => [CONTACT],
    getOpenOrders: async () => [],
    requiredCategory: "medical-supplies",

    isKillSwitchActive: async () => false,
    maxCallsPerOrder: 1,

    persistCall: async ({ status, confidence }) => {
      console.log(`\n  [persist] status=${status} confidence=${confidence.score}`);
      return { callId: "live-call-1" };
    },

    confirmCallbacks: {
      updateOrder: async (outcome) =>
        console.log(`  [order] ${outcome.status} — ${outcome.summary}`),
      scheduleFollowUp: async (f) =>
        console.log(`  [follow-up] ${f.kind} due ${f.dueAt} — ${f.note}`),
    },
    approvalCallbacks: {
      requestApproval: async ({ approval }) =>
        console.log(`  [approval] ${approval.reason}`),
      updateOrder: async (outcome) =>
        console.log(`  [order] ${outcome.status} — ${outcome.summary}`),
    },
    scheduleCallbackCallbacks: {
      scheduleCallbackJob: async ({ callbackAt }) =>
        console.log(`  [queue] callback at ${callbackAt}`),
      scheduleFollowUp: async (f) => console.log(`  [follow-up] ${f.kind} due ${f.dueAt}`),
      updateOrder: async (outcome) =>
        console.log(`  [order] ${outcome.status} — ${outcome.summary}`),
    },
    humanReviewCallbacks: {
      parkOrder: async ({ reason }) => console.log(`  [review] ${reason}`),
      updateOrder: async (outcome) =>
        console.log(`  [order] ${outcome.status} — ${outcome.summary}`),
    },
    unresolvedCallbacks: {
      updateOrder: async (outcome) =>
        console.log(`  [order] ${outcome.status} — ${outcome.summary}`),
      alertOperations: async ({ reason }) => console.log(`  [ALERT] ${reason}`),
    },

    emitSSECallState: ({ state }) => {
      const at = new Date().toISOString();
      stateTransitions.push({ at, state });
      console.log(`  >>> call.state = ${state}`);
    },
    emitSSETranscriptDelta: ({ speaker, text }) => {
      transcript.push({ speaker, text });
      console.log(`  ${speaker}: ${text}`);
    },
    emitSSEResultExtracted: ({ structured, confidence }) =>
      console.log(
        `  [extracted] next_action=${structured.next_action} confidence=${confidence.score}`
      ),

    emitAgentEvent: ({ node, decision, reason }) =>
      console.log(`[${node}] ${decision} — ${reason}`),
    emitSSEOrderSuppressed: ({ reason }) => console.log(`  [suppressed] ${reason}`),
    emitSSEPlanComposed: ({ summary }) => console.log(`  [plan] ${summary}`),
    emitSSEContactSelected: ({ contact }) => console.log(`  [contact] ${contact.name}`),
    emitSSEOrderEscalated: ({ toRung, reason }) =>
      console.log(`  [escalate] → rung ${toRung}: ${reason}`),

    useMock: false,
  };

  const final = await runCoordinationAgent(CONTEXT, deps, 1);

  // ── Findings ─────────────────────────────────────────────────────────────
  // Relative to the repo root, not __dirname — the compiled output lands at a
  // different depth than the source, and this file has already moved once.
  //
  // Named per call, NOT a fixed live-call-raw.json. That file was overwritten
  // by each successive probe, so the payloads the testing log cites as
  // "preserved verbatim" for F-001…F-004 were silently destroyed by call #9,
  // and #9's by #10. These are the only evidence we have for survey findings
  // and we cannot re-run a call to get them back — each one costs a credit and
  // rings a person.
  const callId = final.callHistory.at(-1)?.callId ?? `no-call-${Date.now()}`;
  const outPath = join(process.cwd(), "docs", `live-call-raw.${callId}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ stateTransitions, transcript, rawPolls }, null, 2)
  );

  console.log("\n─── What we learned ───");
  console.log("call.state sequence :", stateTransitions.map((s) => s.state).join(" → ") || "(none)");
  console.log("transcript turns    :", transcript.length);
  console.log("polls               :", rawPolls.length);
  console.log("calls placed        :", final.callHistory.length);
  console.log("confidence          :", final.confidenceHistory.at(-1)?.score ?? "n/a");
  console.log("structured result   :", JSON.stringify(final.structuredResults.at(-1), null, 2));
  console.log("evidence            :", JSON.stringify(final.callHistory.at(-1)?.evidence, null, 2));
  console.log(`\nRaw payloads written to ${outPath}`);
  console.log("Log this call in docs/CALLE_TESTING_LOG.md.\n");
}

main().catch((err) => {
  console.error("\nProbe failed:", err);
  process.exit(1);
});
