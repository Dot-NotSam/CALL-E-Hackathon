/**
 * packages/agent/__tests__/coordinationE2E.test.ts
 *
 * Proves the whole wholesale path holds together: an order goes in, the graph
 * runs the ladder against the mock CALL-E driver, and the events a dashboard
 * would render come out in order — carrying the same traceId throughout (Rule 7).
 */

import { buildCoordinationGraph } from "../coordinationGraph";
import { createInitialCoordinationState } from "../coordinationState";
import type { Order, Contact } from "../../types/wholesale";

const ORDER: Order = {
  id: "CR-3001",
  reference: "ORD-482",
  traceId: "tr_e2e001",
  buyer: { id: "org_buyer", name: "Northgate Distributors", role: "DISTRIBUTOR" },
  seller: { id: "org_seller", name: "Metro Supply Co.", role: "WHOLESALER" },
  item: {
    sku: "SKU-COLD-200",
    description: "Chilled transport crates",
    unit: "units",
    requestedQuantity: 200,
    confirmedQuantity: null,
    remainingQuantity: null,
    unitPrice: 450,
    currency: "INR",
  },
  status: "AWAITING_CONFIRMATION",
  urgency: "PRIORITY",
  requiredBy: "2026-09-16T10:00:00.000Z",
  trigger: { type: "ORDER", summary: "Reorder point", receivedAt: "2026-09-14T06:00:00.000Z" },
  createdAt: "2026-09-14T06:00:00.000Z",
  closedAt: null,
  currentRung: 1,
  maxRungs: 3,
  outcome: null,
  operatorMinutesSaved: null,
  scenarioId: "agent",
};

const CONTACT: Contact = {
  id: "c1",
  organizationId: "org_seller",
  name: "Ravi",
  role: "Sales desk",
  phoneE164: "+919876543210",
  productCategories: [],
  region: "North",
  workingHours: { start: "00:00", end: "23:59", timezone: "UTC" },
  escalationPriority: 1,
  preferredLanguage: "en-IN",
  consentAt: "2026-09-01T00:00:00.000Z",
  cooldownUntil: null,
};

describe("wholesale coordination — end to end", () => {
  const originalScenario = process.env.SENTINEL_MOCK_SCENARIO;

  afterEach(() => {
    if (originalScenario === undefined) delete process.env.SENTINEL_MOCK_SCENARIO;
    else process.env.SENTINEL_MOCK_SCENARIO = originalScenario;
  });

  it("negotiates a commitment and closes the order as CONFIRMED", async () => {
    process.env.SENTINEL_MOCK_SCENARIO = "confirm_after_pushback";
    process.env.SENTINEL_MOCK_DELAY_MS = "0";

    const nodes: string[] = [];
    const traceIds = new Set<string>();
    let confirmed: { minutesSaved: number } | null = null;

    const graph = buildCoordinationGraph({
      getDirectory: async () => [CONTACT],
      persistCall: async ({ rung, traceId }) => {
        traceIds.add(traceId);
        return { callId: `call_${rung}` };
      },
      onConfirmed: async ({ minutesSaved, traceId }) => {
        traceIds.add(traceId);
        confirmed = { minutesSaved };
      },
      onPartial: async () => {},
      onApprovalRequired: async () => {},
      onCallbackScheduled: async () => {},
      onHumanReview: async () => {},
      onUnresolved: async () => {},
      emitAgentEvent: ({ node, traceId }) => {
        nodes.push(node);
        traceIds.add(traceId);
      },
      orderOpenedAt: new Date(ORDER.createdAt),
      isKillSwitchActive: async () => false,
      useMock: true,
    });

    const final = await graph.invoke(createInitialCoordinationState(ORDER));

    // It walked the real path, in order.
    expect(nodes).toEqual([
      "select_contact",
      "plan_call",
      "execute_call",
      "decide",
      "confirm",
    ]);

    expect(final.finalOutcome).toBe("CONFIRMED");
    expect(confirmed).not.toBeNull();
    expect(confirmed!.minutesSaved).toBeGreaterThan(0);

    // Rule 7: one trace id reconstructs the whole incident.
    expect([...traceIds]).toEqual(["tr_e2e001"]);
  });

  it("hands a price change to a person instead of accepting it (FR-5.3)", async () => {
    process.env.SENTINEL_MOCK_SCENARIO = "price_change";
    process.env.SENTINEL_MOCK_DELAY_MS = "0";

    let approvalAsked = false;
    let confirmedAnyway = false;

    const graph = buildCoordinationGraph({
      getDirectory: async () => [CONTACT],
      persistCall: async () => ({ callId: "call_1" }),
      onConfirmed: async () => void (confirmedAnyway = true),
      onPartial: async () => {},
      onApprovalRequired: async () => void (approvalAsked = true),
      onCallbackScheduled: async () => {},
      onHumanReview: async () => {},
      onUnresolved: async () => {},
      emitAgentEvent: () => {},
      orderOpenedAt: new Date(ORDER.createdAt),
      isKillSwitchActive: async () => false,
      useMock: true,
    });

    const final = await graph.invoke(createInitialCoordinationState(ORDER));

    expect(approvalAsked).toBe(true);
    expect(confirmedAnyway).toBe(false);
    expect(final.finalOutcome).toBe("APPROVAL_REQUIRED");
  });

  it("never auto-closes on a vague answer (FR-6.3)", async () => {
    process.env.SENTINEL_MOCK_SCENARIO = "vague_answer";
    process.env.SENTINEL_MOCK_DELAY_MS = "0";

    let confirmedAnyway = false;
    let reviewed = false;

    const graph = buildCoordinationGraph({
      getDirectory: async () => [CONTACT],
      persistCall: async () => ({ callId: "call_1" }),
      onConfirmed: async () => void (confirmedAnyway = true),
      onPartial: async () => {},
      onApprovalRequired: async () => {},
      onCallbackScheduled: async () => {},
      onHumanReview: async () => void (reviewed = true),
      onUnresolved: async () => {},
      emitAgentEvent: () => {},
      orderOpenedAt: new Date(ORDER.createdAt),
      isKillSwitchActive: async () => false,
      useMock: true,
    });

    const final = await graph.invoke(createInitialCoordinationState(ORDER));

    // The mock says CONFIRM_ORDER at 0.41 confidence. The floor must win.
    expect(confirmedAnyway).toBe(false);
    expect(reviewed).toBe(true);
    expect(final.finalOutcome).toBe("HUMAN_REVIEW");
  });
});
