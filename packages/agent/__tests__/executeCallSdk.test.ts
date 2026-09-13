/**
 * packages/agent/__tests__/executeCallSdk.test.ts
 *
 * `execute_call` against a FAKE CALL-E SDK.
 *
 * Every other test in this repo runs the mock driver, which never touches
 * `calle.calls.create()` — so the branch that actually places phone calls had
 * no coverage at all. These tests stub `getCalle` and assert the one property
 * that matters more than any other in this codebase:
 *
 *   ONE run of execute_call places AT MOST ONE call.
 *
 * That is not a style preference. CALL-E exposes no cancel API (testing log
 * F-013) and has twice completed a call we had already given up on, so a
 * second `create()` rings a supplier who is, at that moment, mid-conversation
 * with the first one.
 */

import { executeCall } from "../nodes/executeCall";
import { CallTimeoutError } from "../../calle/progress";
import { makeState } from "./fixtures";

jest.mock("../../calle/client", () => ({ getCalle: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCalle } = require("../../calle/client") as { getCalle: jest.Mock };

/** A finished call, in the shape both the poller and the result mapper read. */
const COMPLETED = {
  id: "call_fake_1",
  status: "completed",
  taskCompleted: true,
  completionConfidence: { score: 0.9, label: "high" },
  evidence: ["[FAKE] synthetic evidence"],
  structuredResult: {
    contact_reached: "yes",
    stock_status: "confirmed",
    confirmed_quantity: 200,
    next_action: "CONFIRM_ORDER",
  },
  recipients: [{ attempts: [{ status: "completed", transcriptTurns: [] }] }],
};

/** Still queued — what CALL-E returns for minutes on end (F-012, F-014). */
const QUEUED = {
  id: "call_fake_1",
  status: "queued",
  recipients: [{ attempts: [{ status: "in_progress", transcriptTurns: [] }] }],
};

interface Fake {
  create: jest.Mock;
  get: jest.Mock;
}

function fakeSdk(get: jest.Mock, create?: jest.Mock): Fake {
  const createMock = create ?? jest.fn().mockResolvedValue(COMPLETED);
  const sdk = { calls: { create: createMock, get } };
  getCalle.mockResolvedValue(sdk);
  return { create: createMock, get };
}

const persistCall = jest.fn().mockResolvedValue({ callId: "db-call-1" });

/** Real SDK path, no sleeping, poll as fast as the loop allows. */
const OPTS = {
  useMock: false,
  pollIntervalMs: 0,
  retry: { baseDelayMs: 0, sleep: async () => {} },
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("a transient poll failure does NOT place a second call", () => {
  it("retries the GET, not the call", async () => {
    // One dropped poll out of three. This documents the intended shape; the
    // test below it is the actual regression guard — verified by restoring the
    // old create+poll retry, which fails that one and leaves this one passing.
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error("503 upstream"))
      .mockResolvedValue(COMPLETED);

    const sdk = fakeSdk(get);

    const { result } = await executeCall(makeState(), persistCall, OPTS);

    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.length).toBeGreaterThan(1);
    expect(result.status).toBe("completed");
  });

  it("places exactly one call even when the polls never recover", async () => {
    const get = jest.fn().mockRejectedValue(new Error("persistent outage"));
    const sdk = fakeSdk(get);

    await expect(executeCall(makeState(), persistCall, OPTS)).rejects.toThrow(
      "persistent outage"
    );

    // The GET was retried to exhaustion (3 attempts) and then gave up. The
    // supplier's phone rang once.
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("does not persist anything when the call could not be followed", async () => {
    fakeSdk(jest.fn().mockRejectedValue(new Error("persistent outage")));

    await expect(executeCall(makeState(), persistCall, OPTS)).rejects.toThrow();

    expect(persistCall).not.toHaveBeenCalled();
  });
});

describe("a timeout does not redial", () => {
  it("gives up on the poll without creating a second call", async () => {
    // Exactly the 2026-09-14 shape: queued forever, never terminal.
    const get = jest.fn().mockResolvedValue(QUEUED);
    const sdk = fakeSdk(get);

    await expect(
      executeCall(makeState(), persistCall, { ...OPTS, timeoutMs: 0 })
    ).rejects.toBeInstanceOf(CallTimeoutError);

    expect(sdk.create).toHaveBeenCalledTimes(1);
  });
});

describe("create() itself IS retried — no call exists yet", () => {
  it("retries a failed create and succeeds", async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(new Error("503 upstream"))
      .mockResolvedValue(COMPLETED);

    const sdk = fakeSdk(jest.fn().mockResolvedValue(COMPLETED), create);

    const { result } = await executeCall(makeState(), persistCall, OPTS);

    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
  });

  it("gives up after three creates rather than dialling forever", async () => {
    const create = jest.fn().mockRejectedValue(new Error("CALL-E is down"));
    fakeSdk(jest.fn(), create);

    await expect(executeCall(makeState(), persistCall, OPTS)).rejects.toThrow(
      "CALL-E is down"
    );

    expect(create).toHaveBeenCalledTimes(3);
  });
});

describe("what we actually send CALL-E", () => {
  it("dials the selected contact, with the order on the metadata", async () => {
    const sdk = fakeSdk(jest.fn().mockResolvedValue(COMPLETED));
    const state = makeState();

    await executeCall(state, persistCall, OPTS);

    const payload = sdk.create.mock.calls[0][0];
    expect(payload.recipient.phone).toBe(state.currentContact!.phoneE164);
    expect(payload.metadata).toMatchObject({
      orderId: state.orderId,
      reference: state.reference,
      traceId: state.traceId,
      rung: state.rung,
    });
    expect(payload.resultSchema.properties.contact_reached).toBeDefined();
  });

  it("persists the MAPPED state, not CALL-E's raw task status", async () => {
    // A call whose attempt has failed while task.status still reads "queued"
    // — the F-010 case that recorded a failed call as queued in the audit.
    fakeSdk(
      jest.fn().mockResolvedValue({
        ...COMPLETED,
        status: "queued",
        recipients: [{ attempts: [{ status: "failed", failureCode: "480" }] }],
      })
    );

    await executeCall(makeState(), persistCall, OPTS);

    expect(persistCall).toHaveBeenCalledTimes(1);
    expect(persistCall.mock.calls[0][0].status).toBe("no_answer");
  });
});
