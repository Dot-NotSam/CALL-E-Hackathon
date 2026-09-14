# Failure taxonomy

Every way a supplier call goes wrong, and what the skill does about it.

None of these is a stretch goal. A coordination agent that only handles "yes, 200 cases, dispatching today" is a demo, not a system — the interesting calls are all in this table.

---

## Conversational outcomes

| # | Failure | Detection | Agent behaviour | Result |
|---|---|---|---|---|
| C1 | **No answer** | Call state `no_answer` (SIP 408/480/486/487/600/603) | Advance to the next contact immediately | `ESCALATE_NEXT_CONTACT` |
| C2 | **Voicemail** | `contact_reached: "voicemail"` | Leave a minimal callback message — **no order reference, quantity, product or price** — and end | `ESCALATE_NEXT_CONTACT` |
| C3 | **Wrong person** | `contact_reached: "wrong_person"` | Ask only whether the named contact is reachable. Disclose nothing. End. | `ESCALATE_NEXT_CONTACT` |
| C4 | **Gatekeeper / IVR** | Non-human respondent | Do not navigate the menu. End. | `ESCALATE_NEXT_CONTACT` |
| C5 | **Partial stock** | `stock_status: "partial"` | **Take it.** Confirm the number, then always ask when the remainder follows. | `PARTIAL_CONFIRMATION` |
| C6 | **Cannot supply** | `stock_status: "unavailable"` | Capture the reason, ask for the earliest alternative, then for another contact | `ESCALATE_NEXT_CONTACT` |
| C7 | **Price changed** | `requires_approval`, or a quoted price ≠ the order's | Record it. Ask them to hold the stock. **Never accept it.** | `REQUEST_APPROVAL` |
| C8 | **Callback requested** | `callback_requested_at` set | Get a concrete time, repeat it back, queue it | `SCHEDULE_CALLBACK` |
| C9 | **Vague answer** | Confidence < 0.70 | Ask ONCE for something concrete, then stop pressing | `HUMAN_REVIEW` |
| C10 | **Conflicting quantities** | Confirmed + remaining ≠ requested | Preserve both statements, write neither | `HUMAN_REVIEW` |
| C11 | **Commitment not met** | Verification call at dispatch time | One revised date accepted; a second miss escalates | Re-verify, then escalate |

---

## System outcomes

| # | Failure | Detection | Agent behaviour | Result |
|---|---|---|---|---|
| S1 | **Call drops mid-conversation** | State `failed` | Retried by `withRetry`; on exhaustion, escalate | Retry ×3, then escalate |
| S2 | **CALL-E API error** | SDK exception | Exponential backoff ×3, then a human alert | Escalate / alert |
| S3 | **Call exceeds 180s** | `CallTimeoutError` | **Never retried** — the phone already rang | Human review |
| S4 | **Kill switch engaged** | Pre-dial check | Nothing dials. Does **not** escalate. | `UNRESOLVED` |
| S5 | **Call cap reached** | Pre-dial check | Nothing dials. Does **not** escalate. | `UNRESOLVED` |
| S6 | **No eligible contact** | Empty selection | Terminate with a loud alert naming why each was skipped | `UNRESOLVED` |
| S7 | **Ladder exhausted** | Rung > `maxRungs` | Loud alert, order left unconfirmed | `UNRESOLVED` |
| S8 | **Duplicate order event** | Same reference, or same seller+SKU already covered | Suppress **before** a call is planned — costs no credit | `SUPPRESSED` |

**S4 and S5 do not escalate on purpose.** Both are deliberate stops — a person or a policy already decided no more calls should happen. Walking the ladder past them to find someone else to ring would be a bypass of the control that just fired. An SDK *failure* (S1, S2) escalates; a *decision* does not.

---

## Platform behaviour you must design around

These are not our failure modes — they are **verified CALL-E behaviours** observed on live calls (2026-09-08/09). A UI or integration built against an idealised model will break on them.

### `connected` never fires

The attempt goes from absent → `in_progress` → terminal. There is no "answered but not yet talking" signal. A dashboard that waits for `connected` sits blank through the entire call.

### `in_conversation` is effectively skipped

It only fires once a transcript turn exists — and turns arrive in **one burst at completion**, not during the call. A live word-by-word transcript is not achievable by polling.

The observed sequence is therefore:

```
queued → dialling → extracting → completed
```

Set `SENTINEL_MOCK_OPTIMISTIC=true` to replay the fuller sequence while developing such a UI, but do not ship one that depends on it.

### `failureCode` is a bare SIP code

`attempt.failureCode` carries SIP response codes as undocumented strings — `"404"`, `"480"`, `"500"` observed, with `failureMessage: null` each time. These need **opposite** handling:

- `480` (temporarily unavailable) → nobody picked up → escalate
- `404` (not found) → unroutable number → a bad directory entry, needs a human
- `500` (server internal error) → an upstream platform fault, not the recipient

`progress.ts` maps the "far end could not or would not take the call" codes onto `no_answer`; everything else stays `failed`.

### `task.status` lags the attempt

An attempt can be `failed` while `task.status` still reads `queued`. Deriving state from the task status records a failed call as "queued" in the audit trail. Always map from the **attempt**.

### `taskCompleted` means "every instruction followed"

Not "objective achieved". A call that got a clear commitment can still return `taskCompleted: false` because the model skipped a closing read-back. Do not branch on it alone — `evidence` is the field that explains the gap, and it is genuinely diagnostic.

### Transcript turns are revised after publication

`"hello."` became `"Hello."` on a later poll. Diffing by array length re-emits the whole revised tail and duplicates it in the UI. Dedupe by normalised identity, not by index.

---

## Delivery reliability

On our testing, **3 of 8 outbound calls to Indian mobiles ever connected**, with three different SIP codes across two numbers and three accounts on byte-identical payloads.

Nothing in the API distinguishes "the platform failed to place your call" from "the recipient did not answer". If your workflow depends on a single call connecting, budget for retries and do not assume one attempt is enough.
