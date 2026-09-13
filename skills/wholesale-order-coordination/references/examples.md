# Worked examples

Five runs, end to end. Every transcript below is a **synthetic `[MOCK]` fixture**, not real CALL-E output — the console traces are real output from `scripts/run_coordination.ts` against the mock driver.

Reproduce any of them:

```bash
CALLE_USE_MOCK=true MOCK_OUTCOME=<outcome> npx ts-node scripts/run_coordination.ts
```

---

## 1. Partial stock — the case that matters

**Order** `ORD-482`: 200 cases of temperature-sensitive medical supplies from Metro Supply Co., needed in 6 hours.

The supplier has 120. A portal would record a failed order line. A notification would tell nobody anything. The call gets both halves of the answer.

```
[assess_order] select_contact — 200 cases of temperature-sensitive medical supplies
                                needs confirmation from Metro Supply Co. — urgent.
[select_contact] contact_found — Selected Rajesh Iyer (Dispatch Lead) — rung 1.
[plan_call] plan_ready — Rung 1: call Rajesh Iyer re: ORD-482 — 200 cases of ...
  [state] queued
  [state] dialling
  [state] extracting
  AGENT: [MOCK] This is the automated operations line for Northgate Distributors.
         Am I speaking with Rajesh Iyer?
  HUMAN: [MOCK] Yes, this is Rajesh.
  AGENT: [MOCK] Thank you. I'm calling about order 482 for 200 cases of medical
         supplies.
  HUMAN: [MOCK] We only have 120 cases ready today.
  AGENT: [MOCK] Thank you. Can you dispatch the 120 cases today and confirm
         when the remaining 80 will be available?
  HUMAN: [MOCK] Yes, 120 today and the remaining 80 tomorrow morning.
  [state] completed
[decide] partial — next_action="PARTIAL_CONFIRMATION", confidence=0.91
```

```
─── Result ───
Status:              PARTIALLY_CONFIRMED
Committed:           true
Confirmed quantity:  120
Remaining quantity:  80
Dispatch:            2026-09-13T11:00:00.000Z
Rungs attempted:     1
Contacts called:     ct-rajesh-iyer
Calls placed:        1
Summary:             Rajesh Iyer confirmed 120 of 200 cases; 80 outstanding
                     (tomorrow morning for the balance).
```

Two follow-ups are scheduled automatically: a **remainder chase** at 10:00 the next morning, and a **verification** half an hour after the stated dispatch.

> **Note on the state sequence.** `connected` never fires, and the transcript arrives in one burst once the attempt finishes rather than streaming during the call. Both are verified CALL-E behaviour, not simplifications — see `failure-taxonomy.md`. A dashboard that waits for `connected`, or expects turns mid-call, will sit blank. Set `SENTINEL_MOCK_OPTIMISTIC=true` to replay the fuller sequence while building such a UI, but do not ship one that depends on it.

**Why the remainder is derived, not trusted.** The supplier said 120 and 80. Had they said 120 and 100, the numbers would not reconcile against a 200-case order — and the skill would write neither, routing to review instead. See example 5.

---

## 2. Price change — the agent refuses

```bash
MOCK_OUTCOME=price_change
```

```
  HUMAN: [MOCK] We can do all 200, but it's 2050 a case now, not 1850.
  AGENT: [MOCK] Thank you, I've noted 2050 per case. That is a change from our
         order, so it needs approval on our side before I can confirm.
         Can you still reserve the stock while that is checked?
  HUMAN: [MOCK] Sure, I'll hold them until end of day.
[decide] approval — next_action="REQUEST_APPROVAL", confidence=0.89
```

```
─── Result ───
Status:              APPROVAL_REQUIRED
Committed:           false
Confirmed quantity:  none
Proposed price:      2050
Summary:             Rajesh Iyer quoted 2050 INR against 1850 on the order.
                     The agent recorded it and did not accept it.
```

**The order's price is unchanged.** `confirmedQuantity` is `null` even though the supplier confirmed 200 cases — nothing is committed until a person approves the price.

The approval request carries the arithmetic an operator needs: *"a 200 INR increase (10.8%)"*, plus the verbatim quote and CALL-E's evidence.

This path fires on `requires_approval` **or** `next_action: REQUEST_APPROVAL`, checked *before* `next_action` — so a model that returns `CONFIRM_ORDER` alongside a changed price still stops here.

---

## 3. The ladder — three rungs, nobody home

```bash
MOCK_OUTCOME=no_answer
```

```
[select_contact] contact_found — Selected Rajesh Iyer (Dispatch Lead) — rung 1.
[execute_call] no_answer — taskCompleted=false, confidence=0
[decide] escalate — next_action="ESCALATE_NEXT_CONTACT", confidence=0
[escalate] rung_2 — Rajesh Iyer did not answer. Advancing to rung 2 of 3.

[select_contact] contact_found — Selected Priya Nair (Sales Manager) — rung 2.
[execute_call] no_answer — taskCompleted=false, confidence=0
[escalate] rung_3 — Priya Nair did not answer. Advancing to rung 3 of 3.

[select_contact] contact_found — Selected Vikram Shah (Operations Head) — rung 3.
[execute_call] no_answer — taskCompleted=false, confidence=0
[escalate] ladder_exhausted — Vikram Shah did not answer.
                              Rung cap reached (3/3) — no contacts left.
```

```
─── Result ───
Status:              UNRESOLVED
Rungs attempted:     3
Contacts called:     ct-rajesh-iyer, ct-priya-nair, ct-vikram-shah
Calls placed:        3
Summary:             No contact at Metro Supply Co. could confirm order ORD-482.
                     200 cases remain unconfirmed.
```

Note the **confidence of 0 on every call** — nobody spoke. This is exactly the case that proves why low confidence must not block escalation: parking a no-answer for an operator would strand the order rather than trying the next person.

Each rung's prompt is framed differently. Rung 2 opens with *"the primary contact could not be reached"*; rung 3 with *"two contacts have already failed to produce a commitment."*

---

## 4. Vague answer — confidence wins

```bash
MOCK_OUTCOME=vague
```

```
  AGENT: [MOCK] Can you confirm you have 200 cases available?
  HUMAN: [MOCK] Yeah, should be fine.
  AGENT: [MOCK] Just so I record it correctly — is that dispatching today,
         tomorrow, or later this week?
  HUMAN: [MOCK] We'll get it out sometime this week.
[decide] human_review — next_action="CONFIRM_ORDER", confidence=0.58
```

```
─── Result ───
Status:              HUMAN_REVIEW
Committed:           false
Confirmed quantity:  none
Summary:             Rajesh Iyer gave no clear answer (confidence 0.58).
                     Nothing has been written to the order.
```

**`next_action` said `CONFIRM_ORDER`.** At 0.58 confidence it does not matter — the confidence rule is applied first and beats every committing action.

The agent asked once for something concrete, got nothing, and stopped pressing. A third ask produces irritation, not a date.

The untrusted result is still **stored verbatim**. It is not trusted, but it is evidence, and the operator picking this up needs to see what was actually said.

---

## 5. Quantities that do not add up

Not reachable from `MOCK_OUTCOME` — it comes from a supplier whose numbers conflict:

```jsonc
{
  "stock_status": "partial",
  "confirmed_quantity": 120,
  "remaining_quantity": 100,      // 120 + 100 ≠ 200
  "next_action": "PARTIAL_CONFIRMATION"
}
```

```
Status:   HUMAN_REVIEW
Summary:  Supplier stated 120 confirmed and 100 remaining, which does not sum
          to the 200 cases requested (expected 80 remaining).
```

Both statements are preserved. Neither is written to the order. Quietly storing 220 cases against a 200-case line would corrupt the buyer's stock position, and it would do so silently — which is worse than leaving the order open.

---

## 6. The kill switch

```ts
isKillSwitchActive: async () => true
```

```
[select_contact] contact_found — Selected Rajesh Iyer (Dispatch Lead) — rung 1.
[execute_call] kill_switch_active — Outbound calling is halted by the global
                                    kill switch.
```

```
Status:          UNRESOLVED
Calls placed:    0
Contacts called: none
```

**It does not escalate.** The ladder is not walked looking for someone else to ring — that would bypass the control that just fired. Compare with example 3, where three calls were placed.

Omitting `isKillSwitchActive` entirely produces the same result, with the reason *"No kill switch check supplied — refusing to dial (fail-closed)."* A missing safety check is treated as an engaged one.
