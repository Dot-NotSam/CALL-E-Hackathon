# CALL-E Testing Log

**Owners:** Vishal + Tanmay
**Purpose:** Capture genuine, reproducible findings while building. Feeds the CALL-E Feedback Survey — a separate prize category (5 × $200).

> **Rule: only real findings.** No manufactured criticism. Fabricated feedback is worse than none — it damages credibility with the same team that judges the main prizes.

---

## How to use this file

Add a row the moment you hit something. Do not batch it up at the end — the friction you feel on day 3 is invisible by day 18, and that early-onboarding friction is exactly the most valuable feedback a new platform can receive.

**High-value categories:**

- Documentation gaps found during first-time onboarding
- `resultSchema` edge cases (nested objects, optional fields, enums, nulls)
- MCP OAuth flow friction
- Error messages that don't say what actually went wrong
- Call status granularity — states you needed but couldn't observe
- CLI DX papercuts
- Anything where you expected X and got Y

---

## Call budget tracker

Track every **live** call. Budget policy: [PRD §7.7](PRD_CALL_E_HACKATHON.md).

| Allocated | Phase | Used | Remaining |
|---|---|---|---|
> **Two accounts.** Calls #1–#4 ran on the original account (now believed
> exhausted — see F-005). Calls #5 onward run on the replacement account, whose
> allowance is what the table tracks.

| Allocated | Phase | Used | Remaining |
|---|---|---|---|
| 2 | P1 — Connectivity | 0 | 2 |
| 4 | P2 — Conversation quality | 2 | 2 |
| 5 | P3 — Edge cases | 2 | 3 |
| 3 | P4 — Escalation ladder | 0 | 3 |
| 3 | P5 — Demo rehearsal | 1 | 2 |
| 3 | P6 — Final recording (reserve) | 0 | 3 |
| **20** | **Total (new account)** | **5** | **15** |

Old account: 4 calls spent (#1–#4), balance unknown, assume 0.

- [ ] Additional-calls request form submitted (**overdue — PRD §16 said Day 2; it is now Sep 8**)

> ## ⚠ DELIVERY RISK — read before planning the recording
>
> **Status 2026-09-09: outbound calling appears to be DOWN on CALL-E's side.**
> The last two attempts both returned SIP 500 *Server Internal Error* — across
> **two different accounts** (one brand new) and **two different numbers**,
> including one that connected successfully earlier the same week with an
> identical payload. **Stop spending credits until this is resolved.**
>
> **Only 3 of 8 calls have ever connected.** Failures span two different
> numbers, two accounts, and three different SIP codes.
>
> | Call | Account | Number | Code | Rang? |
> |---|---|---|---|---|
> | #1 | old | A | — | ✅ (no answer, by design) |
> | #2 | old | A | — | ✅ answered, confidence 0.95 |
> | #4 | old | A | SIP 404 *Not Found* | ❌ |
> | #5 | new | A | — | ✅ answered, confidence 0.86 |
> | #6 | new | A | SIP 480 *Temporarily Unavailable* | ❌ |
> | #7 | new | **B** | SIP 500 *Server Internal Error* | ❌ |
> | #8 | **newer** | A | SIP 500 *Server Internal Error* | ❌ |
>
> **Not our code, and not one number.** Payloads were byte-identical between
> the successes and the failures. Call #7 used a different number on a
> different carrier and failed with a *third* code — and SIP 500 is an upstream
> **server** error, not a subscriber condition, which rules out the earlier
> DND-filtering hypothesis. The pattern is consistent with an unstable
> telephony provider behind CALL-E.
>
> **This is the single biggest risk to the demo (PRD R1) and it is outside our
> control.** Actions, in order:
>
> 1. **Tanmay: raise this with CALL-E today.** Quote call IDs and the three SIP
>    codes. Six days to deadline; this cannot wait until recording day.
> 2. **Bank a pre-recorded successful run the moment a call connects** (PRD
>    §18.1 rule 6, R1 mitigation). We have had 3 successes and captured audio
>    for none of them.
> 3. Budget for retries — assume roughly **1 connection in 2 attempts** when
>    planning the recording session.
>
> **Account switched 2026-09-08.** Call #4 failed with `failureCode=404` after a
> 361ms dial; the phone was on and never rang. Swapping to a new API key (a
> different account — it cannot see call #4) made call #5 succeed immediately
> with an unchanged payload. **Strong evidence the first account was out of
> credits, and that exhaustion surfaces as an opaque carrier 404 rather than a
> quota error** (see F-005). Counts below are for the NEW account.

### Live call log

| # | Date | Phase | Purpose | Outcome | Notes |
|---|---|---|---|---|---|
| 1 | 2026-09-08 | P1 | Connectivity test — no answer | no_answer | Call ID: call_E6zAMb9Zo3_NI5lKX0L3tw. SDK auth confirmed, call placed. |
| 2 | 2026-09-08 | P1 | Connectivity test — Aryan answered | completed | Call ID: call_H0eI8KXOsaL0vozEUvD7rg. Transcript confirmed. Confidence 0.95. |
| 3 | 2026-09-08 | P2 | Cold-chain scenario — negotiation test | timeout | Script timed out client-side. Call placed on CALL-E side. Check dashboard. |
| 4 | 2026-09-08 | P3 | FR-5.2 verification — live `call.state` transitions via `create()` + poll, through the real agent path | failed (did not connect) | Old account. Task `call_4x1IKPpuXC8JwmOTSmXNWw` → `status=failed`, `failureCode=call_failed`. Attempt `att_6011a9cfd249d9b4` → `failureCode=404`, 0 turns, 361ms dial. Phone on, never rang. Produced F-001…F-005. |
| 8 | 2026-09-09 | P3 | Retry on a **third, brand-new account** — number A, unchanged payload | failed (did not connect) | `failureCode=500` again. Fresh account, fresh credits, and this is the same number that connected on call #5 with the same payload. **Rules out credits, number filtering, and our code simultaneously.** Two consecutive SIP 500s across 2 accounts and 2 numbers → CALL-E-side outage. **Stopped testing here; further attempts only burn credits.** |
| 7 | 2026-09-09 | P3 | Delivery test on a **different number / carrier**, to isolate F-011 | failed (did not connect) | `failureCode=500` (SIP *Server Internal Error*) — a **third** distinct code, on a second number. Rules out number-specific filtering; points upstream. **Also confirmed both fixes from call #6 work live:** 500 correctly mapped to `failed` (not `no_answer`), and the record persisted `status=failed` rather than the stale `"queued"`. |
| 6 | 2026-09-09 | P5 | Pre-push end-to-end rehearsal — full agent path | failed (did not connect) | Attempt `failureCode=480` (SIP *Temporarily Unavailable*), 0 turns. Compared against call #4's `404`, this **identified `failureCode` as bare SIP response codes** — see F-009. Also surfaced F-010: the attempt had already failed while `task.status` still read `queued`, so the audit row recorded a failed call as "queued". Both fixed. |
| 5 | 2026-09-08 | P3 | FR-5.2 re-run on the new account — full agent path, answered | **completed** | ✅ Real negotiation: responder said "available but currently busy", agent pressed for ETA, got **20 minutes**, confirmed it was inside the 90min window. `eta_minutes: 20`, `responder_available: "yes"`, `next_action: SCHEDULE_VERIFICATION_CALL`, confidence **0.86**, 21 transcript turns. Verification job queued at T+25min. Produced F-006…F-008. |
| 9 | 2026-09-13 | P2 | **First live call on the WHOLESALE schema** — full agent path, answered | **completed** | Call ID `call_x2ENjL-418zCXY8gWYdPPg`. ✅ 40 turns, 2m21s, confidence **0.88**. Agent pressed twice on a vague date ("By tomorrow" → "14:00 September" → got "by 14th September"). **Responder quoted ₹1000 against the order's ₹1850; the agent recorded it, refused to accept it, asked them to reserve the stock, and returned `requires_approval: true` / `next_action: REQUEST_APPROVAL`.** FR-5.3 verified live. ⚠️ **Our client recorded this success as a FAILURE** — see F-012. Produced F-012, F-013. |
| 10 | 2026-09-14 | P2 | Second wholesale call, **different number / different person** (Tanmay) — partial-stock scenario | **completed** | Call ID `call_pTAB-O4ueJdAITNenOEA5Q`. ✅ 44 turns, confidence **0.88**, `confirmed_quantity: 200`, `next_action: REQUEST_APPROVAL`. Responder drifted to a price negotiation rather than the intended partial-stock split, and the approval gate held again. ⚠️ **Our client recorded this success as a FAILURE too** — but for a *different* reason than call #9, and a worse one: `startedAt`/`providerCallId` stayed null through the **entire 44-turn conversation** and were backfilled only at completion, so the ring-detection heuristic built after call #9 could never fire. Produced F-014; invalidates the fix F-012 suggested. |

---

## Findings

All four below come from one live call on 2026-09-08 (log entry #4). Raw payloads
are preserved verbatim in `live-call-raw.json`.

| ID | Date | Surface | Scenario | Expected | Actual | Repro | Severity | Suggested fix |
|---|---|---|---|---|---|---|---|---|
| F-001 | 2026-09-08 | SDK | `require("@call-e/calle")` from a CommonJS build | Package loads. `package.json` declares `"main": "./dist/index.js"`, which conventionally signals CJS support. | `ERR_PACKAGE_PATH_NOT_EXPORTED`. The `exports` map declares only an `"import"` condition — no `"require"` — so `main` is unreachable and misleading. Any CJS/ts-node consumer is blocked until they discover the workaround (`new Function("s","return import(s)")`). | `node -e 'require("@call-e/calle")'` | **Major** | Either add a `"require"` condition (dual build), or drop `"main"` and state ESM-only prominently in the README. `main` present + no `require` condition is the most confusing combination. |
| F-002 | 2026-09-08 | API | Reading `attempt.startedAt` / `completedAt` alongside `task.createdAt` | Consistent, timezone-qualified timestamps across the payload. | `task.createdAt` = `2026-09-08T15:26:32.230922Z` (UTC, `Z`), but `attempt.startedAt` = `2026-09-08T11:27:29` — **no timezone designator and 4 hours offset** from the task clock, in the same response. Computing call duration across the two fields silently yields a ~4-hour error. | Any completed call; compare the two fields. | **Major** | Emit `attempt.startedAt`/`completedAt` as UTC with a `Z` designator, matching `task.createdAt`. |
| F-003 | 2026-09-08 | API | Driving a live-progress UI from call status | `task.status` tracks the call, and `attempt.status` distinguishes ringing from talking. | `task.status` stayed `queued` for the entire call, flipping to `failed` only at the end — useless as a live signal. `attempt.status` went `(absent)` → `in_progress` → `failed`; **`dialing` was never observed**. `in_progress` was held for ~50s on a call that never connected (0 turns, `startedAt == completedAt`), so it does not mean "conversation in progress". | Poll `calls.get()` every 2s through a call. | Minor | Document what each status means, and when `dialing` is emitted (if ever). A ringing-vs-connected distinction is what a live call UI needs most. |
| F-011 | 2026-09-09 | API / Platform | Placing outbound calls to Indian mobiles (`+91`) | Consistent delivery — an identical payload behaves the same way each time. | **Only 3 of 7 calls have ever connected.** Failures produced **three different SIP codes across two different numbers on different carriers**: `404` *Not Found*, `480` *Temporarily Unavailable*, and `500` *Server Internal Error*. Identical payloads succeeded in between. SIP 500 is an upstream **server** error, not a subscriber condition, so this is not number-specific filtering — it looks like an unstable telephony provider. Nothing in the API distinguishes "the platform failed to place your call" from "the recipient did not answer", so a developer cannot tell a platform fault from their own bug: **we spent 3 live calls establishing it was not our code.** | Place several identical calls to `+91` mobiles and compare `attempts[0].failureCode`. | **Blocker** | Surface platform/carrier faults distinctly from recipient outcomes — a `failureCategory` of `platform` \| `carrier` \| `recipient` would be enough. Publish delivery-reliability expectations per region. A hackathon entrant whose demo depends on one live call cannot absorb a ~50% connection rate, and has no way to detect it from the API. |
| F-009 | 2026-09-09 | API / Docs | Branching on `attempt.failureCode` | A documented, enumerated failure reason. | It carries **bare SIP response codes as strings** — we observed `"404"` on one call and `"480"` on another, with `failureMessage: null` both times. Nothing in the OpenAPI schema, SDK types, or docs says this. We only worked it out by comparing two failed calls and recognising the numbers. Until then our mapping treated every failure identically, so a no-answer (SIP 480 → must escalate, §9 F1) was indistinguishable from an unroutable number (SIP 404 → bad roster entry, needs a human). **These require opposite agent behaviour.** | Call an unreachable number; read `recipients[0].attempts[0].failureCode`. | **Major** | Document that `failureCode` is a SIP response code — one line in the schema description would have saved a live call. Better still, add a semantic `failureReason` enum (`no_answer` \| `busy` \| `unroutable` \| `rejected` \| `platform_error`) so callers don't have to encode a SIP table. |
| F-010 | 2026-09-09 | API | Recording the final status of a failed call | `task.status` reflects the attempt once the attempt is terminal. | The attempt had `status=failed, failureCode=480` while `task.status` was **still `queued`** — the task-level status lags by several seconds. A consumer that stops polling when the attempt reaches a terminal state (the only way to react promptly) reads a stale task status and records a failed call as "queued". | Poll a call that fails to connect; compare `task.status` against `attempts[-1].status` on the same response. | Minor | Update `task.status` in the same write as the terminal attempt status, or document the lag so consumers know to derive state from the attempt. |
| F-006 | 2026-09-08 | API | Streaming a live transcript to a dashboard during the call | Transcript turns appear on `attempt.transcriptTurns` incrementally as the conversation happens. | All 21 turns appeared **at once**, on the poll where `attempt.status` flipped to `completed`. During the ~50s conversation, `transcriptTurns` stayed empty across 16 polls. A live transcript UI is therefore impossible via polling — the conversation is only visible once it is over. | Poll `calls.get()` every 2s through an answered call. | **Major** | Publish turns incrementally, or document that they are completion-only and provide a streaming/webhook alternative for live UIs. This is the single biggest blocker to building a live call view on CALL-E. |
| F-007 | 2026-09-08 | API | Diffing transcript turns between polls to stream only new ones | A published turn is immutable, so new turns can be detected by index. | Turns are **revised after publication** — `"hello."` on one poll became `"Hello."` on the next, and `"no, i don't need."` became `"No, I don't need."`. Any consumer diffing by array length re-emits the whole revised tail, duplicating it in the UI. | Compare `transcriptTurns` across two polls after completion. | Minor | Either freeze turns once published, or give each turn a stable `id` so consumers can dedupe reliably. |
| F-008 | 2026-09-08 | API | Reading `taskCompleted` after a successful negotiation | `taskCompleted: true` — the agent obtained a clear yes and a numeric ETA. | `taskCompleted: false` with confidence 0.86, because the bot skipped one instructed step (the closing read-back). The `evidence` array explained this precisely and usefully. The flag is arguably right but reads as a failure for a call that achieved its objective, so control flow cannot rely on it alone. | Run a task whose prompt has more required steps than the conversation needs. | Polish | Document that `taskCompleted` means "every instruction followed", not "objective achieved" — they diverge, and `evidence` is the field that explains the gap. |
| F-005 | 2026-09-08 | API / SDK / Dashboard | Diagnosing why an accepted call never rang | Enough information, from the API alone, to tell "you are out of credits" from "that number is unroutable" from "the carrier rejected it". | Nothing distinguishes them. `calls.listEvents()` returned 10 events whose `details` is `{}` on every single one — **including the terminal `call.failed` error event**, whose message (`"calling task completed with status=FAILED"`) only restates the status. The dial lasted 361ms (`status=calling` 15:27:29.380 → "Call ended" 15:27:29.741). The SDK exposes `calls`, `goals`, and `webhooks` but **no account, usage, or quota endpoint**, so a developer cannot check programmatically whether they have simply run out of credits. The only route is the web dashboard. | `calle.calls.listEvents(id)` on any failed call. | **Major** | Populate `details` on `call.failed` with the provider's reason, and add a lightweight account/usage endpoint (`calls remaining`, `plan status`). For a product whose free tier is 20 calls, "have I run out?" should be answerable from the API. |
| F-012 | 2026-09-13 | API | Enforcing a call-duration ceiling, and knowing when the phone is actually ringing | `attempt.status: "in_progress"` means the call is in progress, so a client can time the conversation from it. | **It means "CALL-E has accepted this", not "the phone is ringing".** On `call_x2ENjL-418zCXY8gWYdPPg` the attempt read `in_progress` across **40 consecutive polls (~130s)** with `startedAt: null`, `completedAt: null` and `providerCallId: null` — the dial had not begun. It then rang, and the conversation ran a further 2m21s. There is **no field that distinguishes "queued" from "ringing" from "talking"**: `status` is `in_progress` for all three, and `task.status` stays `queued` throughout (F-003). We enforced a 180s ceiling from `create()`, aborted at the ceiling, and **recorded a completed, successful negotiation as a failed call** — raising a false alert and marking the order UNRESOLVED. The only reliable signal is the *absence* of `startedAt`/`providerCallId`, which is undocumented. | Poll `calls.get()` from `create()`; compare `attempt.status` against `attempt.startedAt`. | **Major** | Emit a distinct attempt status for queued-vs-dialling-vs-connected, or document that `startedAt`/`providerCallId` are the ring signal. Any consumer enforcing a duration ceiling — which the safety docs of every serious integration will — gets it wrong by default, and gets it wrong in the direction that discards real results. **⚠ The workaround suggested here — treat `startedAt`/`providerCallId` as the ring signal — was tried and does NOT work. See F-014.** |
| F-013 | 2026-09-13 | API / Docs | Abandoning a call client-side | Dropping the poll loop stops the call, or at least marks it abandoned. | **The call continues and completes.** We stopped polling at our 180s ceiling and treated the call as failed; CALL-E carried on, held a 40-turn conversation, and completed with `taskCompleted: true` and a valid `structuredResult`. We only discovered this by re-querying the call ID afterwards. There is no `calls.cancel()` in the SDK, so **a client cannot stop a call it has given up on** — and a naive retry-on-timeout would dial the same person a second time while the first conversation is still live. | Abandon a poll loop mid-call, then `calls.get(id)` a minute later. | **Major** | Add `calls.cancel(id)`. Failing that, document prominently that abandoning a poll does not end the call, so integrators exclude timeouts from their retry policy. |
| F-014 | 2026-09-14 | API | Detecting that a call is actually in progress — the workaround F-012 suggested | `attempt.startedAt` and `providerCallId` populate when the dial begins, so a client can at least use their *absence* to tell "still queued" from "ringing". This is what F-012 recommended and what we shipped after call #9. | **They are backfilled at completion, not live.** On `call_pTAB-O4ueJdAITNenOEA5Q` both stayed `null` across **~90 consecutive polls spanning an entire 44-turn conversation**, alongside `task.status: "queued"`, `attempt.status: "in_progress"` and `transcriptTurns: []`. Every field appeared at once when the task went terminal. Worse, `startedAt` then returned **two different values on consecutive polls** — `2026-09-13T19:13:05.543117Z`, then `2026-09-13T19:12:49Z` — so it is not even stable once set. Combined with F-003 and F-006, **the API exposes no signal whatsoever that distinguishes queued from ringing from talking**; the only observable event in a call's life is the flip to terminal. Any wall-clock budget therefore sometimes aborts a live conversation, and because there is no cancel API (F-013) the call completes anyway and the result is silently discarded. **This cost us two of five live calls on the wholesale schema.** | Poll `calls.get()` every 2s from `create()` through a full call; log `startedAt`, `providerCallId` and `transcriptTurns.length` on each poll. | **Blocker** | Emit a real progress signal — either an attempt status that changes when the phone rings and again when it is answered, or populate `startedAt` live. Until then, no client can implement a call-duration ceiling, which is a control every safety-reviewed voice integration needs. Also make `startedAt` stable and timezone-qualified (cf. F-002). |
| F-004 | 2026-09-08 | API | Interpreting a failed attempt | An enumerated, documented failure reason. | `attempt.failureCode` = `"404"` — a bare numeric string, undocumented, with `failureMessage: null`. Task level gave `"call_failed"` / `"calling task status=FAILED"`, which restates the status rather than explaining it. Impossible to distinguish "no answer" from "unroutable number" from "carrier rejection" — and those need different agent behaviour (escalate vs. flag a bad roster entry). | Call a number that fails to connect. | **Major** | Enumerate `failureCode` in the OpenAPI schema, and populate `failureMessage` with something actionable. |

**Surface:** SDK · API · MCP · CLI · SKILL · Docs · Dashboard
**Severity:** Blocker · Major · Minor · Polish

---

## Positive observations

Worth submitting too — knowing what works well is useful roadmap signal, and it makes the critical findings land as considered rather than complaining.

| ID | Surface | What worked well | Why it mattered |
|---|---|---|---|
| P-001 | API | **`evidence` was genuinely diagnostic.** On call #5 it returned: *"The bot did not ask for the required final confirmation tying Aryan to CS-04 at Zone A with the 20-minute ETA."* | It identified the exact instruction the conversation skipped — better feedback on our own prompt than reading the transcript ourselves. This is what made `taskCompleted: false` interpretable rather than mysterious, and it turned one live call into a concrete prompt fix. |
| P-002 | API | **The agent handled an unscripted human well.** The responder mumbled "hello" twice, gave their name as "arya", and said "available but currently busy". The bot re-confirmed identity, pressed for a concrete ETA, got "20 minutes", and checked it against the safe window unprompted. | Conversation robustness is the hardest thing to verify before a demo. It held up on the first real attempt against a genuinely messy human. |
| P-004 | API | **The agent refused a price change on a live call.** The responder quoted ₹1000 against the order's ₹1850. The bot recorded it, said *"I'll note the new price as one thousand Indian rupees per case. That will need Northgate approval, but can you reserve the stock for us?"*, and returned `requires_approval: true`, `next_action: REQUEST_APPROVAL`, `unit_price: 1000`. | This is the control that matters most in a commercial coordination agent, and it held against real speech — not just in tests. It also declined to be talked into a number twice (the responder first said "₹150 per case"). Typed extraction plus a prompt-level prohibition produced exactly the intended split: record the fact, refuse the authority. |
| P-005 | API | **It pushed back on vague answers instead of accepting them.** Asked for a dispatch date, the responder said "By tomorrow"; the bot asked for a specific date. They said "Tomorrow, 14:00 September"; the bot flagged the ambiguity and asked again, getting "by 14th September I will dispatch it." | Extracting a usable date from an unscripted human is the difference between a commitment and a note. Two clarification rounds without becoming robotic is genuinely hard, and `evidence` explained precisely which readback was accepted. |
| P-006 | API | **The approval gate held on a second call, with a different person and a messier conversation.** Tanmay answered vaguely ("Alright, so you can approx 200", "And you will be dispatched", "So there will be negotiation"), and the bot still extracted `confirmed_quantity: 200`, `dispatch_date`, and `unit_price: 1000` with `requires_approval: true`. It volunteered the constraint before being pushed — *"Since there'll be negotiation on the price, I'll need to get Northgate's approval before we can proceed. In the meantime, can you reserve the 200 cases?"* | Call #9 proved the control works; call #10 proved it was not a one-off on one cooperative speaker. It also recovered from its own interruption mid-readback (*"Can you hear me?"*) and completed the confirmation afterwards. Reproducibility across speakers is what makes a safety control a control rather than an anecdote. |
| P-003 | API | **`resultSchema` extraction was accurate.** Free-form speech ("20 minutes", "no, i don't need") mapped correctly onto `eta_minutes: 20`, `requires_parts: false`, `responder_available: "yes"`. | Typed extraction is the whole reason a phone call can drive a workflow. It did not need prose parsing or a second LLM pass. |

---

## Survey submission

- [ ] Findings reviewed and deduplicated
- [ ] Repro steps verified from a clean state
- [ ] Suggested fixes are concrete and actionable
- [ ] CALL-E Feedback Survey submitted
- [ ] Submission date logged here: ______
