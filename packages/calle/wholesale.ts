export const WHOLESALE_COORDINATION_RESULT_SCHEMA = {
  type: "object",
  required: ["contact_reached", "stock_status", "next_action"],
  properties: {
    contact_reached: { type: "string", enum: ["yes", "no", "wrong_person", "voicemail", "unknown"] },
    stock_status: { type: "string", enum: ["confirmed", "partial", "unavailable", "unknown"] },
    confirmed_quantity: { type: "number" },
    remaining_quantity: { type: "number" },
    unit_price: { type: "number" },
    currency: { type: "string" },
    dispatch_date: { type: "string" },
    delivery_eta: { type: "string" },
    delay_reason: { type: "string" },
    callback_requested_at: { type: "string" },
    requires_approval: { type: "boolean" },
    verbatim_commitment: { type: "string" },
    next_action: {
      type: "string",
      enum: [
        "CONFIRM_ORDER",
        "PARTIAL_CONFIRMATION",
        "REQUEST_APPROVAL",
        "SCHEDULE_CALLBACK",
        "ESCALATE_NEXT_CONTACT",
        "HUMAN_REVIEW",
      ],
    },
  },
} as const;

export interface WholesaleCallContext {
  contactName: string;
  phoneE164: string;
  companyName: string;
  orderReference: string;
  product: string;
  requestedQuantity: number;
  requiredBy: string;
}

export function buildWholesaleTaskPrompt(context: WholesaleCallContext): string {
  return `
Call ${context.contactName} at ${context.phoneE164}, the authorised contact for ${context.companyName}.
You are the automated operations line for Northgate Wholesale Distributors.

OBJECTIVE
Confirm the current stock and dispatch commitment for order ${context.orderReference}.
The distributor needs ${context.requestedQuantity} units of ${context.product}, required by ${context.requiredBy}.

ASK
1. Can you confirm how many units are available now?
2. What quantity can you dispatch, and on what date?
3. If stock is partial or delayed, when will the remainder be available?
4. Has the unit price changed, or does this require approval?

RULES
- Identify yourself as an automated operations line at the start.
- If the answer is partial, capture both confirmed and remaining quantities.
- If the contact is busy, ask for the earliest concrete callback time.
- Ask once for a specific date or quantity when an answer is vague.
- Do not approve price, credit, legal terms, or contractual changes.
- If someone else answers, do not disclose order details.
- Keep the call concise and end after a clear next action.
`.trim();
}