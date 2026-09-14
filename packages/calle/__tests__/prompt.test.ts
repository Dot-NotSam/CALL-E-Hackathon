/**
 * packages/calle/__tests__/prompt.test.ts
 *
 * The prompt is the conversation. These tests protect the parts of it that are
 * safety controls or PRD §7.3 requirements — the clauses that must survive
 * every edit someone makes while tuning the wording.
 */

import {
  buildWholesaleCoordinationPrompt,
  buildFollowUpPrompt,
  buildCallPlanSummary,
  getMustAskQuestions,
  formatForSpeech,
  formatReferenceForSpeech,
  hoursUntil,
} from "../prompt";
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

function ctx(
  overrides: Partial<WholesaleCoordinationContext> = {}
): WholesaleCoordinationContext {
  return {
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
    ...overrides,
  };
}

describe("PRD §7.3 — every required element is present", () => {
  const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);

  it("discloses that it is an automated line (FR-7.1)", () => {
    expect(prompt).toMatch(/automated operations line for Northgate Distributors/);
  });

  it("carries the order reference, product, quantity and required date", () => {
    expect(prompt).toContain("ORD-482");
    expect(prompt).toContain("temperature-sensitive medical supplies");
    expect(prompt).toContain("200 cases");
    expect(prompt).toContain("MED-TS-CASE");
  });

  it("asks for stock, quantity, price, dispatch and ETA", () => {
    expect(prompt).toMatch(/available\?/i);
    expect(prompt).toMatch(/how many/i);
    expect(prompt).toMatch(/dispatch/i);
    expect(prompt).toMatch(/price still 1850/i);
  });

  it("has a partial-fulfilment branch that asks for the remainder", () => {
    expect(prompt).toMatch(/PARTIAL STOCK/);
    expect(prompt).toMatch(/when the remainder will be available|remaining/i);
  });

  it("has refusal, callback, wrong-person, voicemail and vague branches", () => {
    expect(prompt).toMatch(/REFUSAL/);
    expect(prompt).toMatch(/CALL ME BACK/);
    expect(prompt).toMatch(/SOMEONE ELSE ANSWERS/);
    expect(prompt).toMatch(/VOICEMAIL/);
    expect(prompt).toMatch(/VAGUE ANSWER/);
  });

  it("states stop conditions and a duration ceiling", () => {
    expect(prompt).toMatch(/STOP CONDITIONS/);
    expect(prompt).toMatch(/under 90 seconds/);
  });
});

describe("safety clauses that must never be edited out", () => {
  const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);

  it("forbids disclosing order details to anyone else (FR-7.5)", () => {
    expect(prompt).toMatch(/Never disclose order details to anyone who is not Rajesh Iyer/);
  });

  it("withholds details on the voicemail branch specifically", () => {
    expect(prompt).toMatch(/Do NOT leave the order reference, quantity, product or price/);
  });

  it("forbids accepting a price, credit or contractual terms (FR-5.3)", () => {
    expect(prompt).toMatch(/Never agree to a price, a discount, credit terms/);
  });

  it("forbids inventing a quantity, price or date", () => {
    expect(prompt).toMatch(/Never invent, estimate, or round/);
  });

  it("forbids implying it is human", () => {
    expect(prompt).toMatch(/Never imply you are a human/);
  });

  it("refuses to navigate an IVR menu", () => {
    expect(prompt).toMatch(/Do not press options or navigate the menu/);
  });
});

describe("identity is established before anything is disclosed (FR-7.4)", () => {
  // Live calls #9 and #10 opened by stating the order reference, product and
  // quantity to whoever picked up the phone, and never asked who that was.
  // The "never disclose to anyone who is not X" clause was unenforceable,
  // because the agent had no idea who X was.

  const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);

  it("asks who is on the line", () => {
    expect(prompt).toMatch(/Am I speaking with Rajesh Iyer\?/);
  });

  it("asks BEFORE it says the order reference, product or quantity", () => {
    // The ordering is the whole control — both strings being present somewhere
    // in the prompt would prove nothing.
    const identityAt = prompt.indexOf("Am I speaking with Rajesh Iyer?");
    expect(identityAt).toBeGreaterThan(-1);

    for (const disclosure of ["ORD-482", "200 cases", "temperature-sensitive"]) {
      expect(prompt.indexOf(disclosure)).toBeGreaterThan(identityAt);
    }
  });

  it("makes the disclosure conditional on the answer, not just sequential", () => {
    expect(prompt).toMatch(/Only if they confirm they are Rajesh Iyer/);
  });

  it("treats an unclear answer as someone else, not as a yes", () => {
    expect(prompt).toMatch(/An unclear answer is NOT a yes/);
  });

  it("can stop the call on identity alone, before any order detail", () => {
    expect(prompt).toMatch(/could not confirm you are speaking to Rajesh Iyer/);
  });

  it("puts identity first in the must-ask list", () => {
    expect(prompt).toMatch(/1\. "Am I speaking with Rajesh Iyer\?" — ALWAYS first/);
  });

  it("verifies identity on follow-up calls too", () => {
    // A follow-up discloses MORE than a first call: it repeats a quantity and
    // a date the supplier already committed to.
    for (const kind of ["VERIFICATION", "REMAINING_QUANTITY"] as const) {
      const followUp = buildFollowUpPrompt(ctx(), CONTACT, kind, {
        confirmedQuantity: 120,
        remainingQuantity: 80,
        dispatchDate: "2026-09-14T10:00:00.000Z",
      });

      const identityAt = followUp.indexOf("Am I speaking with Rajesh Iyer?");
      expect(identityAt).toBeGreaterThan(-1);
      expect(followUp.indexOf("ORD-482")).toBeGreaterThan(identityAt);
    }
  });

  it("leaves no message when a follow-up reaches the wrong person", () => {
    const followUp = buildFollowUpPrompt(ctx(), CONTACT, "VERIFICATION", {
      confirmedQuantity: 200,
    });
    expect(followUp).toMatch(/Do not leave a message/);
  });

  it("shows the identity check in the operator's plan panel (FR-4.1)", () => {
    expect(getMustAskQuestions(ctx())[0]).toMatch(/Am I speaking with the named contact/);
  });
});

describe("defects found in the live call of 2026-09-14", () => {
  // Each of these is a thing the agent actually said, or actually recorded,
  // on call_pTAB-O4ueJdAITNenOEA5Q. The transcript is the specification.

  describe("the order reference is spoken, not spelled out", () => {
    it("splits a reference into letters and digits", () => {
      expect(formatReferenceForSpeech("ORD-482")).toBe("O R D, 4 8 2");
    });

    it("drops punctuation rather than narrating it", () => {
      // The live call said "dash" out loud.
      expect(formatReferenceForSpeech("ORD-482")).not.toMatch(/-/);
      expect(formatReferenceForSpeech("PO/2026/17")).toBe("P O, 2 0 2 6, 1 7");
    });

    it("handles a reference with no separator at all", () => {
      expect(formatReferenceForSpeech("ORD482")).toBe("O R D 4 8 2");
    });

    it("forbids the exact failure — describing the typography", () => {
      const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);
      expect(prompt).toMatch(/Never say "capitalized", "uppercase", "lowercase", "dash" or "hyphen"/);
    });

    it("uses the spoken form in the opening and the read-back", () => {
      const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);
      expect(prompt).toContain(`I'm calling about order ${formatReferenceForSpeech("ORD-482")}`);
      expect(prompt).toContain(`against order ${formatReferenceForSpeech("ORD-482")}`);
    });
  });

  describe("relative dates resolve in the contact's timezone", () => {
    it("tells the model today's date where the contact is", () => {
      // 2026-09-13 19:12 UTC is already 2026-09-14 in Asia/Kolkata. The live
      // call recorded "today" as 2026-09-13 — a day early.
      const prompt = buildWholesaleCoordinationPrompt(
        ctx(),
        CONTACT,
        new Date("2026-09-13T19:12:49.000Z")
      );

      expect(prompt).toContain("2026-09-14");
      expect(prompt).toMatch(/"Today" means 2026-09-14/);
    });

    it("names the timezone it resolved against", () => {
      const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);
      expect(prompt).toContain("Asia/Kolkata");
    });

    it("falls back to the UTC date rather than throwing on a bad timezone", () => {
      const broken = {
        ...CONTACT,
        workingHours: { ...CONTACT.workingHours, timezone: "Mars/Olympus_Mons" },
      };

      expect(() =>
        buildWholesaleCoordinationPrompt(ctx(), broken, new Date("2026-09-13T19:12:49.000Z"))
      ).not.toThrow();
    });
  });

  describe("a hedged quantity is not a commitment", () => {
    const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);

    it("has a branch for it", () => {
      // The live call heard "approx 200" and answered "About 200 confirmed".
      expect(prompt).toMatch(/HEDGED QUANTITY/);
    });

    // Whitespace-tolerant and case-insensitive: these assert a SAFETY rule is
    // present, and re-wrapping a paragraph must not be able to fail them.
    it("forbids echoing the hedge back as a confirmation", () => {
      expect(prompt).toMatch(/do\s+not\s+echo\s+their\s+hedge/i);
    });

    it("leaves the quantity empty rather than recording an approximation", () => {
      expect(prompt).toMatch(/leave\s+confirmed_quantity\s+empty/i);
    });

    it("says so in the hard rules too", () => {
      expect(prompt).toMatch(/If they hedged it — "about", "approx",\s*"around" — they did not say it/);
    });
  });

  describe("the read-back happens once", () => {
    const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);

    it("says once, and says what once means", () => {
      expect(prompt).toMatch(/Read it back ONCE/);
      expect(prompt).toMatch(/ONCE means once/);
    });

    it("gives a shorter form for a detail that changes afterwards", () => {
      expect(prompt).toMatch(/confirm only THAT detail/);
    });

    it("forbids talking over the supplier", () => {
      // The live call said "Thank you, bye." while he was still speaking.
      expect(prompt).toMatch(/never say goodbye while they are\s*mid-sentence/);
    });
  });
});

describe("the prompt is composed, not static", () => {
  it("frames each rung differently", () => {
    const primary = buildWholesaleCoordinationPrompt(ctx({ rung: 1 }), CONTACT);
    const backup = buildWholesaleCoordinationPrompt(ctx({ rung: 2 }), CONTACT);
    const supervisor = buildWholesaleCoordinationPrompt(ctx({ rung: 3 }), CONTACT);

    expect(primary).toContain("first call about this order");
    expect(backup).toContain("backup contact");
    expect(supervisor).toContain("supervisor-level call");
    expect(primary).not.toEqual(backup);
  });

  it("handles a rung past the ladder without leaving a template hole", () => {
    const prompt = buildWholesaleCoordinationPrompt(ctx({ rung: 7 }), CONTACT);
    expect(prompt).toContain("contact attempt 7");
    expect(prompt).not.toContain("undefined");
  });

  it("frames each urgency differently", () => {
    const urgent = buildWholesaleCoordinationPrompt(ctx({ urgency: "URGENT" }), CONTACT);
    const routine = buildWholesaleCoordinationPrompt(ctx({ urgency: "ROUTINE" }), CONTACT);

    expect(urgent).toMatch(/URGENT/);
    expect(routine).toMatch(/Do not manufacture urgency/);
  });

  it("says the deadline has passed when it has", () => {
    const prompt = buildWholesaleCoordinationPrompt(
      ctx({ requiredBy: "2020-01-01T00:00:00.000Z" }),
      CONTACT
    );
    expect(prompt).toMatch(/ALREADY PASSED/);
  });

  it("renders no unfilled template holes for any rung or urgency", () => {
    for (const rung of [1, 2, 3]) {
      for (const urgency of ["ROUTINE", "PRIORITY", "URGENT"] as const) {
        const prompt = buildWholesaleCoordinationPrompt(ctx({ rung, urgency }), CONTACT);

        for (const hole of ["undefined", "null", "NaN", "[object Object]", "Invalid Date"]) {
          expect(prompt).not.toContain(hole);
        }
      }
    }
  });

  it("singularises the unit in spoken sentences", () => {
    const prompt = buildWholesaleCoordinationPrompt(ctx(), CONTACT);
    expect(prompt).toContain("1850 INR per case");
    expect(prompt).not.toContain("per cases");
  });
});

describe("follow-up prompts", () => {
  it("chases the remainder without re-briefing the whole order", () => {
    const prompt = buildFollowUpPrompt(ctx(), CONTACT, "REMAINING_QUANTITY", {
      confirmedQuantity: 120,
      remainingQuantity: 80,
    });

    expect(prompt).toContain("80 cases");
    expect(prompt).toMatch(/under 45 seconds/);
    expect(prompt).toMatch(/Do not re-brief/);
  });

  it("verifies a dispatch against what was committed", () => {
    const prompt = buildFollowUpPrompt(ctx(), CONTACT, "VERIFICATION", {
      confirmedQuantity: 120,
      dispatchDate: "2026-09-13T11:00:00.000Z",
    });

    expect(prompt).toMatch(/Has the order dispatched\?/);
    expect(prompt).toContain("120 cases");
  });

  it("keeps the safety clauses on follow-ups too", () => {
    for (const kind of ["VERIFICATION", "REMAINING_QUANTITY"] as const) {
      const prompt = buildFollowUpPrompt(ctx(), CONTACT, kind, {});
      expect(prompt).toMatch(/Never disclose order details to anyone who is not/);
      expect(prompt).toMatch(/Never agree to a price/);
    }
  });
});

describe("plan summary and must-ask (FR-4.1)", () => {
  it("summarises the plan for the operator in one line", () => {
    const summary = buildCallPlanSummary(ctx(), CONTACT);

    expect(summary).toContain("Rung 1 (primary)");
    expect(summary).toContain("Rajesh Iyer");
    expect(summary).toContain("ORD-482");
    expect(summary).toContain("200 cases");
  });

  it("labels the backup and supervisor rungs", () => {
    expect(buildCallPlanSummary(ctx({ rung: 2 }), CONTACT)).toContain("(backup)");
    expect(buildCallPlanSummary(ctx({ rung: 3 }), CONTACT)).toContain("(supervisor)");
  });

  it("lists the questions the call must not end without", () => {
    const questions = getMustAskQuestions(ctx());

    expect(questions).toHaveLength(5);
    expect(questions[0]).toMatch(/Am I speaking with/);
    expect(questions[1]).toContain("200 cases");
    expect(questions.join(" ")).toMatch(/dispatch/i);
    expect(questions.join(" ")).toMatch(/price/i);
  });
});

describe("formatForSpeech", () => {
  it("renders a date a human can hear", () => {
    const spoken = formatForSpeech("2026-09-13T12:30:00.000Z", "Asia/Kolkata");

    expect(spoken).toMatch(/September/);
    expect(spoken).not.toContain("T12:30");
  });

  it("degrades to the raw value rather than throwing on a bad date", () => {
    expect(formatForSpeech("not a date", "Asia/Kolkata")).toBe("not a date");
  });

  it("degrades rather than throwing on a bad timezone", () => {
    expect(() => formatForSpeech("2026-09-13T12:30:00.000Z", "Mars/Olympus")).not.toThrow();
  });
});

describe("hoursUntil", () => {
  const now = new Date("2026-09-13T06:00:00.000Z");

  it("measures forward", () => {
    expect(hoursUntil("2026-09-13T12:00:00.000Z", now)).toBe(6);
  });

  it("goes negative once the deadline has passed", () => {
    expect(hoursUntil("2026-09-13T04:00:00.000Z", now)).toBe(-2);
  });

  it("returns Infinity for an unparseable date rather than NaN", () => {
    expect(hoursUntil("whenever", now)).toBe(Number.POSITIVE_INFINITY);
  });
});
