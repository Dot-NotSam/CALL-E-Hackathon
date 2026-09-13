---
name: wholesale-order-coordination
description: Phone a supplier to confirm stock, quantity, price and dispatch, negotiate a partial commitment when they cannot fill the whole order, and escalate to the next contact when they do not answer. Use when an order needs a confirmed human commitment rather than a stale inventory record — wholesale replenishment, purchase-order confirmation, dispatch and delivery follow-up, supplier exception handling. Places REAL outbound calls via CALL-E; read the Side effects section before running.
---

# Wholesale Order Coordination

Turn an order into a **confirmed supply commitment**.

An inventory record is not a commitment. The supplier may have partial stock, a changed price, a dispatch constraint, or a different ETA — and none of that is in your system until someone picks up a phone and asks. This skill phones the right business contact, holds a real conversation, refuses to accept "we'll sort it out", captures a number and a date, and moves down the supplier's contact ladder when nobody answers — returning a typed, confidence-scored result a workflow can branch on.

```
Order event → Decide → Call → Negotiate → Structured commitment → Confirm, approve, or escalate
```

## When to use this

Use it when **the answer must come from a specific person at a supplier, and you need proof of what they committed to**:

- Replenishment where the supplier's stock position is unknown or stale
- Purchase-order confirmation that needs a quantity *and* a dispatch date
- Delivery follow-up where an ETA has slipped and nobody has said why
- Partial fulfilment — the case a portal cannot handle, because the answer is a negotiation
- Any workflow that currently ends in "…and then someone calls the supplier"

Do **not** use it for broadcast notifications, cold outreach, or anything where a message with no reply is acceptable. It dials real businesses.

## Setup

```bash
pnpm add @call-e/calle

export CALLE_API_KEY="..."                    # dashboard.heycall-e.com/account/api-keys
export CALLE_BASE_URL="https://api.heycall-e.com"

export CALLE_USE_MOCK=true                    # develop against the mock driver first
```

Optional MCP server for free dry runs:

```jsonc
{ "mcpServers": { "calle": {
  "type": "http",
  "url": "https://seleven-mcp-sg.airudder.com/mcp/openagent_oauth"
} } }
```

You supply two things: a **directory** of consented business contacts (`assets/sample-contacts.json`) and an **order**. Everything else is in this skill.

## Usage

### 1. Validate the plan without spending a call

```ts
import { planCoordinationCall } from "./scripts/plan_call.ts";

const report = await planCoordinationCall(ctx, contact, mcpTransport);
if (!report.ok) throw new Error(JSON.stringify(report.issues));
```

`plan_call` is a dry run. It costs nothing, and it catches the failures that actually happen: an unrendered template hole reaching a supplier, a prompt long enough to blow the 90-second ceiling, a missing self-identification, or a safety clause someone edited out while tuning the wording. **Iterate the prompt here, not on live calls.**

### 2. Place the coordination call

```ts
import { runCoordination } from "./scripts/run_coordination.ts";

const outcome = await runCoordination({
  order: {
    reference: "ORD-482",
    sku: "MED-TS-CASE",
    description: "temperature-sensitive medical supplies",
    unit: "cases",
    requestedQuantity: 200,
    unitPrice: 1850,
    currency: "INR",
    requiredBy: "2026-09-13T12:30:00.000Z",
  },
  buyer:  { id: "org-northgate",    name: "Northgate Distributors", role: "DISTRIBUTOR" },
  seller: { id: "org-metro-supply", name: "Metro Supply Co.",       role: "WHOLESALER" },
  contacts: require("./assets/sample-contacts.json"),
  requiredCategory: "medical-supplies",
  isKillSwitchActive: async () => false,
});
```

### 3. Branch on the typed result

```jsonc
{
  "contact_reached": "yes",
  "stock_status": "partial",
  "confirmed_quantity": 120,
  "remaining_quantity": 80,
  "unit_price": 1850,
  "currency": "INR",
  "dispatch_date": "2026-09-13T11:00:00.000Z",
  "delivery_eta": "tomorrow morning for the balance",
  "verbatim_commitment": "Yes, 120 today and the remaining 80 tomorrow morning.",
  "next_action": "PARTIAL_CONFIRMATION"
}
```

Full contract: `references/result-schema.json`.

## How it decides

Routing is **deterministic code, not a second LLM call**. The model already did its job inside the conversation; branching on its output must be predictable and testable.

Rules are applied **in this order**:

| # | Condition | Result |
|---|---|---|
| 1 | `completionConfidence < 0.70` | **Human review** — beats every `next_action` below |
| 2 | `requires_approval`, or a quoted price ≠ the order's | **Approval** — a person decides, always |
| 3 | `CONFIRM_ORDER` | Confirmed, + a verification follow-up |
| 4 | `PARTIAL_CONFIRMATION` | Partially confirmed, + a remainder chase *and* a verification |
| 5 | `SCHEDULE_CALLBACK` | Callback queued at the requested time |
| 6 | `ESCALATE_NEXT_CONTACT` | Next rung, or UNRESOLVED at the cap |
| 7 | `HUMAN_REVIEW` | Human review |

**Why low confidence still escalates.** An unanswered call has confidence 0.0 by construction — nobody spoke. Parking that for an operator strands the order. Escalating on a weak signal is fail-safe; *committing* on one is not. So confidence gates committing, never trying the next human.

**Why quantities are recomputed, not trusted.** A supplier who says "120 today, 100 tomorrow" against a 200-case order has not given you a consistent answer. The skill derives the remainder from the order and flags the mismatch for review rather than writing 220 against a 200-case line.

See `references/contact-ladder.md` and `references/failure-taxonomy.md`.

## Adapting it to your domain

The coordination engine is domain-independent. To reuse it:

1. **Swap the trigger** — anything producing `{ requestedQuantity, requiredBy, seller }` works: a reorder point, a purchase order, a delivery exception, a stock-out webhook.
2. **Swap the directory** — `assets/sample-contacts.json` shape: organisation, product categories, region, working hours, escalation priority, consent timestamp.
3. **Keep the schema** — `references/result-schema.json` is what makes the output branchable. Changing it means rewriting the decision logic.

Nothing above the directory and the trigger is medical-supplies specific.

## Side effects

**This skill places real outbound phone calls to real businesses.** Running it will:

- **Ring a real person's phone** at a supplier
- **Consume CALL-E call credits** (new accounts start with 20)
- **Create permanent audit records** — transcript, evidence, confidence, structured result

Safeguards, all enforced in code rather than in the prompt:

| Control | Behaviour |
|---|---|
| Consented directory | Only pre-registered contacts with a `consentAt` timestamp. No exceptions path exists. |
| Self-identification | Every call opens by stating it is an automated line. Never remove this. |
| Third-party protection | If the wrong person answers, order details are withheld and the call ends. Voicemail gets a minimal message with no order details. |
| **No commercial authority** | The agent may **record** a price, credit or terms change. It may never **accept** one. |
| Working hours | Enforced per contact, in that contact's timezone. Only URGENT can override, and only when the policy explicitly allows it. |
| Contact cooldown | A contact is not re-called inside their cooldown window. |
| Call cap | Default 5 calls per order, independent of the rung cap. |
| Rung cap | Default 3: primary, backup, supervisor. |
| Duplicate suppression | Runs before a call is planned, so a repeated order event never costs a credit. |
| Duration ceiling | 180s hard timeout per call; never retried. |
| Kill switch | Checked before **every** dial. **Fails closed.** |

Full detail: `references/safety.md`.

## Cancellation

- **Stop all future calls:** activate the kill switch. It is checked immediately before every dial, on every rung. If the check throws — or was never wired up — the agent refuses to dial.
- **Stop calling one contact:** remove them from the directory, or set `cooldownUntil`. They will not be selected again.
- **Stop calling one supplier:** remove every contact for that `organizationId`. The order terminates UNRESOLVED with an alert rather than finding someone else.
- **A call already in progress** cannot be cancelled from here; it ends when CALL-E ends it or the 180s ceiling trips.

There is no configuration, prompt, or model output that can raise a cap, approve a price, or bypass the kill switch. If you find one, that is a bug.

## Files

```
references/
  safety.md               consent, side effects, commercial limits, cancellation
  examples.md             worked runs: partial stock, ladder, price approval, failures
  result-schema.json      the typed extraction contract
  contact-ladder.md       rung design + urgency adaptation
  failure-taxonomy.md     the failure modes and the agent's response to each
scripts/
  build_task_prompt.ts    dynamic, rung-aware prompt composition
  plan_call.ts            free dry-run validation (MCP plan_call)
  run_coordination.ts     runnable end-to-end example
  lib/                    vendored decision logic — generated, do not edit
assets/
  sample-contacts.json    directory shape, with consent fields
```
