# The contact ladder

How the skill decides **who to call**, in what order, and when to stop.

---

## The three rungs

| Rung | `escalationPriority` | Who | Why they exist |
|---|---|---|---|
| 1 | 1 | **Primary** — dispatch lead, the person who handles this product day to day | Knows the actual stock position without checking |
| 2 | 2 | **Backup** — sales manager, second dispatch contact | Can answer when the primary is on the floor or off that day |
| 3 | 3 | **Supervisor** — operations head, branch manager | Can make a decision rather than report one. Reached only when two people have already failed to commit. |

Default cap: **3 rungs**. Change it with `maxRungs`, but understand what you are doing — a fourth call to the same supplier about the same order is a nuisance call, and it is how an automated line gets blocked.

---

## Selection, in order

A contact is eligible only if **all** of these pass. Each filter records why it rejected someone, and those reasons land in the audit trail — so an exhausted ladder always says *why*, rather than just "no contact found".

1. **Works for the seller on this order.** `organizationId === order.seller.id`.
2. **Has recorded consent.** A parseable `consentAt`. No consent, no call — see `safety.md`.
3. **Not already tried on this order.** Tracked in `attemptedContacts`.
4. **Covers the product category**, when one is required. A contact who handles industrial parts cannot answer a question about cold-chain medical stock.
5. **Not in cooldown.** An unparseable `cooldownUntil` fails closed.
6. **Inside their working hours**, in their own timezone.

Survivors are sorted by `escalationPriority` ascending, and the first is chosen.

---

## What advances a rung

Escalation is for **"this person cannot give us an answer"**, not for "we did not like the answer".

| Outcome | Advances? | Why |
|---|---|---|
| No answer | ✅ | Nobody spoke. Try the next person. |
| Voicemail | ✅ | A message was left; waiting on a callback strands the order. |
| Wrong person | ✅ | Details were withheld, so nothing was learned. |
| Cannot supply at all | ✅ | This contact is a dead end for this order. |
| Call dropped / SDK error | ✅ | After retries are exhausted. |
| **Partial stock** | ❌ | This IS the answer. Take it and chase the remainder. |
| **Price changed** | ❌ | A person decides. Calling someone else to get a better price is not the agent's job. |
| **Callback requested** | ❌ | A time was agreed. Queue it. |
| **Vague answer** | ❌ | Goes to review. Another call would produce another vague answer. |

The distinction that matters: **escalate when the contact could not answer; review when the answer was unclear; approve when the answer changes commercial terms.**

---

## Why low confidence still escalates

An unanswered call has `completionConfidence: 0.0` by construction — nobody spoke, so there is nothing to be confident about.

If low confidence blocked escalation, every no-answer would park for an operator instead of trying the backup contact. So the rule is asymmetric:

> **Confidence gates *committing*, never *trying the next human*.**

Escalating on a weak signal is fail-safe — the worst case is one more call to a consented contact. Committing on a weak signal is not: it writes a quantity the buyer will plan against.

`CLOSING_ACTIONS` in `decide.ts` is the list confidence guards. `ESCALATE_NEXT_CONTACT` is deliberately absent from it.

---

## Urgency changes the framing, not the rules

`urgency` is recomputed from `requiredBy` at assessment time, not taken on trust — a callback can fire hours after the order opened, and an order that was PRIORITY when raised may be URGENT by the second call.

| Urgency | Hours to `requiredBy` | Effect on the call |
|---|---|---|
| `URGENT` | ≤ 24 | Stated clearly and early. May override working hours *if* the policy allows. May run a parallel rung during a callback wait. |
| `PRIORITY` | ≤ 72 | Mentioned once, plainly. |
| `ROUTINE` | > 72 | The prompt explicitly says *do not manufacture urgency*. |

Urgency never raises a cap, never bypasses consent, and never changes who is eligible. It changes what the agent *says*.

---

## Why each rung sounds different

A backup contact who hears the primary's script learns nothing about why they are being called instead of their colleague.

| Rung | Framing |
|---|---|
| 1 | "This is the first call about this order." Professional, brief, factual. |
| 2 | "The primary contact could not be reached or could not commit." Time has been spent; the buyer still has no confirmation. |
| 3 | "Two contacts have already failed to produce a commitment." The order is still unconfirmed and a decision is needed from someone who can make one. |

This is tested: `graph.integration.test.ts` asserts all three prompts differ and carry the right framing.

---

## When the ladder runs out

`UNRESOLVED`, with a **loud alert** — not a dashboard panel.

The alert names every contact tried and states what is still unconfirmed. When the run ended without any contact being tried (an empty directory, or the kill switch firing), the message says so rather than claiming an exhausted ladder — a false "we tried everyone" is worse than no message.
