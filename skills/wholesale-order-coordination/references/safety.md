# Safety

This skill places **real outbound phone calls to real businesses**. Everything below is enforced in code. An instruction in the prompt is not a safety control — a model can be talked out of one, and the whole point of these is that nothing can.

---

## 1. Consent

**Only contacts in the directory are ever called. There is no exceptions path.**

A contact is callable only if every one of these holds:

| Requirement | Enforced by |
|---|---|
| Present in the directory you supply | `selectBestContact` — the roster is the only source of numbers |
| Belongs to the seller on this order | `contact.organizationId === order.seller.id` |
| Has a parseable `consentAt` timestamp | `hasConsent()` — an empty or malformed value fails |
| Not inside `cooldownUntil` | `isOutOfCooldown()` — an unparseable value fails **closed** |
| Inside their own working hours | `isWithinWorkingHours()`, in the contact's timezone |

There is no "call this number once" parameter, no override flag, and no code path that constructs a phone number from anything other than a directory entry.

**`consentAt` is not decorative.** A row added straight to your database without it will not be dialled.

### Working hours are a consent boundary

Hours are compared in **the contact's own timezone**, not the server's. Getting this wrong rings a supplier in Mumbai at 3 a.m. because the process runs in UTC.

An URGENT order may override working hours **only** when the caller explicitly opts in:

```ts
allowUrgentOutsideWorkingHours: true   // defaults to FALSE
```

`mayOverrideWorkingHours()` returns true only for `URGENT`, and only when that flag is set. `PRIORITY` and `ROUTINE` can never override, whatever the flag says.

---

## 2. Identity

**Every call opens by stating it is an automated line.** The opening sentence is composed into the prompt and is not optional:

> "This is the automated operations line for {buyer}. Am I speaking with {contact}?"

**The identity question is the whole opening.** Nothing about the order — not the reference, the product, the quantity or the price — is said until the person confirms they are the named contact. See §3.

`lintTaskPrompt()` fails with an **error** if the phrase "automated operations line" is missing, so a prompt edit that drops it cannot reach a live call through `plan_call`.

The prompt also forbids the agent from implying it is human, and there is no persona setting that softens this.

---

## 3. Third-party protection

**Order details are disclosed only to the named contact — and the agent asks who it is speaking to before it discloses anything.**

Asking first is not a formality. "Never disclose to anyone who is not {contact}" is unenforceable if the agent never establishes who it is talking to; it just means "disclose to whoever answers" with extra words. Live calls #9 and #10 did exactly that.

| Situation | Behaviour |
|---|---|
| Identity not yet confirmed | Say only the automated-line greeting and "Am I speaking with {contact}?". Nothing else. |
| Someone else answers | Ask only whether the named contact is reachable. State no reference, quantity, product or price. End the call. |
| An unclear or evasive answer | Treated as someone else, not as a yes. One repeat of the question, then end. |
| Voicemail | Leave a callback request naming the buyer and the contact. **No order reference, quantity, product or price** — you cannot verify who will hear the recording. |
| Automated menu / switchboard | Do not press options or navigate. End the call. |

`lintTaskPrompt()` fails with an error if the clause `Never disclose order details to anyone who is not {contact}` is missing.

**And it is enforced after the call, in code.** `decide()` rule 0: unless `contact_reached` is exactly `"yes"`, no committing action may run — not a confirmation, not a partial, not a price approval, not a callback. `wrong_person`, `voicemail` and `no` advance the ladder; `unknown` goes to a human. A prompt instruction is not a control; this is the control.

---

## 4. No commercial authority

**This is the control that matters most, and it is the one a phone agent is most likely to be talked out of.**

The agent may **record** a commercial change. It may never **accept** one.

| Change | Agent behaviour |
|---|---|
| A different unit price | Record `unit_price`, set `requires_approval`, route to `APPROVAL_REQUIRED`. Ask them to hold the stock. |
| Credit or payment terms | Same. Recorded verbatim, routed to a person. |
| Any contractual condition | Same. |

Three independent things enforce this:

1. **The prompt** tells the model never to agree to a price, discount, credit terms or payment terms.
2. **`decide()`** routes to `approval` whenever `requires_approval` is set **or** `next_action` is `REQUEST_APPROVAL` — checked *before* `next_action`, so a model returning `CONFIRM_ORDER` alongside a changed price still stops.
3. **`confirm()` never writes `unitPrice`.** It is hardcoded to `null`. The only code path that changes an order's price is an explicit operator decision.

`priceChanged()` additionally detects a quoted price differing from the order even when the model left `requires_approval` unset.

`lintTaskPrompt()` fails with an error if the `Never agree to a price` clause is missing.

---

## 5. Caps and the kill switch

| Control | Default | Enforced |
|---|---|---|
| **Kill switch** | — | Checked immediately before **every** dial, on every rung |
| Rung cap | 3 | `escalate()` — the only place the cap exists |
| Call cap per order | 5 | Checked before dialling, independent of the rung cap |
| Call duration ceiling | 180s | `pollCallToCompletion` — **never retried** on breach |
| Retry on SDK failure | 3, exponential backoff | `withRetry` — a timeout is excluded |
| Duplicate suppression | — | Runs in `assess_order`, **before** a call is planned |

### The kill switch fails closed

```ts
// No check supplied              → treated as ACTIVE, nothing dials
// The check throws                → treated as ACTIVE, nothing dials
// The check returns true          → nothing dials
```

A safety control that silently degrades to "allow" is not a safety control. If you do not wire `isKillSwitchActive`, **this skill will not place any calls at all.** That is deliberate.

**A deliberate stop does not walk the ladder.** When the kill switch or the call cap blocks a dial, the order terminates `UNRESOLVED` — it does *not* escalate to try the next contact, because doing so would be a bypass of the very control that just fired. An SDK *failure* does escalate; a *decision* does not.

### The duration ceiling is never retried

A call that breached 180s really happened — the supplier's phone rang and someone talked to it. Redialling would ring them again. `withRetry` re-raises `CallTimeoutError` without retrying.

---

## 6. What is never automated

The following always reach a person, whatever the model returns:

- **Any result below 0.70 confidence** that would commit something to the order. `confirmedQuantity` and `remainingQuantity` are written as `null`, never as the claimed values — a shaky extraction must not become a stock position.
- **Any price, credit or terms change.**
- **Quantities that do not reconcile.** "120 today and 100 tomorrow" against a 200-case order is not a commitment; both statements are preserved and a person decides.
- **An exhausted ladder.** `UNRESOLVED` raises a loud alert rather than closing quietly. An order that silently ends unconfirmed is worse than one never raised, because the buyer believes it is in hand.

---

## 7. Cancellation

| To stop | Do this |
|---|---|
| All future calls | Activate the kill switch. Checked before every dial. |
| Calling one contact | Remove them from the directory, or set `cooldownUntil`. |
| Calling one supplier | Remove every contact with that `organizationId`. The order terminates UNRESOLVED with an alert rather than finding someone else. |
| A call already ringing | Not possible from here. It ends when CALL-E ends it or the 180s ceiling trips. |

---

## 8. Audit

Every call persists, verbatim and un-normalised:

- the exact task prompt sent
- CALL-E's `structuredResult`, `completionConfidence` and `evidence`
- the mapped call state and the transcript
- the `trace_id`, which is the same on the order, every call, every event and every follow-up

`evidence` is stored **verbatim** because it is the audit trail. It is what lets an operator check that a confirmed quantity came from something the supplier actually said, rather than from an extraction that filled a gap.

---

## 9. Testing without dialling

```bash
export CALLE_USE_MOCK=true
```

The mock driver satisfies the identical interface, replays the observed CALL-E state sequence, and spends nothing. Every transcript line it produces is `[MOCK]`-prefixed so it can never be mistaken for a real call in a screenshot or a recording.

Use MCP `plan_call` for prompt iteration. It is a free dry run, and it is the only responsible way to tune wording when the account has 20 calls on it.
