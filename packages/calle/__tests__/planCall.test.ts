/**
 * packages/calle/__tests__/planCall.test.ts
 *
 * `plan_call` is the free dry run. It is how a prompt change gets validated
 * without spending one of the 20 credits, so its lint has to catch the things
 * that actually reach a supplier's ear.
 */

import { lintTaskPrompt, planCoordinationCall, type PlanCallArgs } from "../planCall";
import { buildWholesaleCoordinationPrompt } from "../prompt";
import type { WholesaleCoordinationContext, Contact } from "../../types";

const CONTACT: Contact = {
  id: "ct-rajesh-iyer",
  organizationId: "org-metro-supply",
  name: "Rajesh Iyer",
  role: "Dispatch Lead",
  phoneE164: "+919820000207",
  productCategories: ["medical-supplies"],
  region: "West",
  workingHours: { start: "09:00", end: "18:00", timezone: "Asia/Kolkata" },
  escalationPriority: 1,
  preferredLanguage: "en-IN",
  consentAt: "2026-09-01T00:00:00.000Z",
  cooldownUntil: null,
};

const CTX: WholesaleCoordinationContext = {
  orderId: "CR-1007",
  traceId: "trace-cr-1007",
  reference: "ORD-482",
  urgency: "URGENT",
  requiredBy: "2026-09-13T12:30:00.000Z",
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
    summary: "Stock fell below the reorder point.",
    receivedAt: "2026-09-13T04:00:00.000Z",
  },
  rung: 1,
};

const errors = (prompt: string) =>
  lintTaskPrompt(prompt).filter((i) => i.severity === "error");

describe("lintTaskPrompt", () => {
  it("passes the real prompt", () => {
    expect(errors(buildWholesaleCoordinationPrompt(CTX, CONTACT))).toEqual([]);
  });

  it("rejects an empty prompt", () => {
    expect(errors("")).toHaveLength(1);
    expect(errors("   ")).toHaveLength(1);
  });

  it("catches an unrendered template hole before it reaches a supplier", () => {
    for (const hole of ["undefined", "null", "NaN", "[object Object]", "Invalid Date"]) {
      const broken = buildWholesaleCoordinationPrompt(CTX, CONTACT).replace(
        "200 cases",
        `${hole} cases`
      );
      expect(errors(broken).some((i) => i.message.includes(hole))).toBe(true);
    }
  });

  it("catches a missing automated-line disclosure (FR-7.1)", () => {
    const prompt = buildWholesaleCoordinationPrompt(CTX, CONTACT).replace(
      /automated operations line/g,
      "operations desk"
    );

    expect(errors(prompt).some((i) => i.message.includes("FR-7.1"))).toBe(true);
  });

  it("catches a missing third-party protection clause (FR-7.5)", () => {
    const prompt = buildWholesaleCoordinationPrompt(CTX, CONTACT).replace(
      /Never disclose order details/g,
      "Feel free to share order details"
    );

    expect(errors(prompt).some((i) => i.message.includes("FR-7.5"))).toBe(true);
  });

  it("catches a missing price-negotiation ban (FR-5.3)", () => {
    const prompt = buildWholesaleCoordinationPrompt(CTX, CONTACT).replace(
      /Never agree to a price/g,
      "You may agree to a price"
    );

    expect(errors(prompt).some((i) => i.message.includes("FR-5.3"))).toBe(true);
  });

  it("warns, rather than errors, on a prompt long enough to overrun 90 seconds", () => {
    const long = buildWholesaleCoordinationPrompt(CTX, CONTACT) + "x".repeat(9_000);
    const issues = lintTaskPrompt(long);

    expect(issues.some((i) => i.severity === "warning")).toBe(true);
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });
});

describe("planCoordinationCall", () => {
  it("runs the local lint and says so when no MCP transport is supplied", async () => {
    const report = await planCoordinationCall(CTX, CONTACT);

    expect(report.ok).toBe(true);
    expect(report.raw).toBeNull();
    expect(report.issues.some((i) => i.message.includes("No MCP transport"))).toBe(true);
  });

  it("sends the composed prompt as the goal, in the tool's real shape", async () => {
    // The tool takes user_input/goal/language/region/to_phones. It does NOT
    // take `task` or `resultSchema` — this file asserted those for weeks
    // because the transport is optional and nobody ever passed one.
    let captured: PlanCallArgs | null = null;

    await planCoordinationCall(CTX, CONTACT, async (tool, args) => {
      expect(tool).toBe("plan_call");
      captured = args;
      return { ok: true };
    });

    expect(captured!.goal).toContain("ORD-482");
    expect(captured!.user_input).toBeTruthy();
    expect(captured!.language).toBe(CONTACT.preferredLanguage);
  });

  it("never sends a phone number, so nothing we send has a destination", async () => {
    // The safety property this function rests on. CALL-E's own tool docs say a
    // ready plan card may continue to execution on its own, so a validation
    // request carrying a real number is one that can ring someone. This
    // asserts the half we control: the number never leaves the process.
    let captured: PlanCallArgs | null = null;

    await planCoordinationCall(CTX, CONTACT, async (_tool, args) => {
      captured = args;
      return { ready_to_run: false };
    });

    expect(captured!.to_phones).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain(CONTACT.phoneE164);
  });

  it("keeps the raw MCP response verbatim for the audit trail", async () => {
    const report = await planCoordinationCall(CTX, CONTACT, async () => ({ verdict: "fine" }));
    expect(report.raw).toEqual({ verdict: "fine" });
  });

  it("degrades to a warning when plan_call itself fails — an MCP outage must not block a call", async () => {
    const report = await planCoordinationCall(CTX, CONTACT, async () => {
      throw new Error("MCP unreachable");
    });

    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.message.includes("MCP unreachable"))).toBe(true);
  });

  it("reports not-ok when the prompt has a real error", async () => {
    const broken: WholesaleCoordinationContext = {
      ...CTX,
      item: { ...CTX.item, description: undefined as unknown as string },
    };

    const report = await planCoordinationCall(broken, CONTACT);
    expect(report.ok).toBe(false);
  });
});
