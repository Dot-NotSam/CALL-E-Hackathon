/**
 * packages/calle/__tests__/progress.test.ts
 * Tests for the live-call progress layer (FR-5.2, FR-5.4, F10).
 */

import {
  toSentinelCallState,
  isTerminalState,
  collectTurns,
  pollCallToCompletion,
  withRetry,
  CallTimeoutError,
  type PollableCall,
  type CalleAttemptStatus,
} from "../progress";

const noSleep = async () => {};

function call(
  taskStatus: PollableCall["status"],
  attemptStatus?: CalleAttemptStatus,
  extra: {
    failureCode?: string;
    turns?: { speaker: string; text: string }[];
    /** Backfilled by CALL-E at completion — never set mid-call. */
    startedAt?: string | null;
    providerCallId?: string | null;
  } = {}
): PollableCall {
  return {
    id: "call-1",
    status: taskStatus,
    recipients: attemptStatus
      ? [
          {
            attempts: [
              {
                status: attemptStatus,
                failureCode: extra.failureCode ?? null,
                startedAt: extra.startedAt ?? null,
                providerCallId: extra.providerCallId ?? null,
                transcriptTurns: (extra.turns ?? []).map((t) => ({
                  ...t,
                  offset_seconds: null,
                })),
              },
            ],
          },
        ]
      : [],
  };
}

// ─── Status mapping (FR-5.2) ─────────────────────────────────────────────────

describe("toSentinelCallState", () => {
  test.each<[CalleAttemptStatus, string]>([
    ["queued", "queued"],
    ["dialing", "dialling"],       // CALL-E spells it American, our contract British
  ])("attempt %s → %s", (attemptStatus, expected) => {
    expect(toSentinelCallState(call("in_progress", attemptStatus))).toBe(expected);
  });

  // Grounded in a real call (2026-09-08): CALL-E held `in_progress` for ~50s on
  // a call that never connected — no turns, startedAt == completedAt. Claiming
  // "in conversation" there would have lit the dashboard for a silent line.
  test("in_progress with no transcript yet → dialling, not in_conversation", () => {
    expect(toSentinelCallState(call("in_progress", "in_progress"))).toBe("dialling");
  });

  test("in_progress once a turn exists → in_conversation", () => {
    expect(
      toSentinelCallState(
        call("in_progress", "in_progress", { turns: [{ speaker: "agent", text: "Hello" }] })
      )
    ).toBe("in_conversation");
  });

  test("attempt completed but task still running → extracting", () => {
    expect(toSentinelCallState(call("in_progress", "completed"))).toBe("extracting");
  });

  test("attempt and task completed → completed", () => {
    expect(toSentinelCallState(call("completed", "completed"))).toBe("completed");
  });

  test("failure with a no-answer code → no_answer, not failed", () => {
    // F1 and F9 diverge downstream, so the distinction has to survive mapping.
    expect(
      toSentinelCallState(call("failed", "failed", { failureCode: "no_answer" }))
    ).toBe("no_answer");
  });

  test("failure with a transport code → failed", () => {
    expect(
      toSentinelCallState(call("failed", "failed", { failureCode: "carrier_rejected" }))
    ).toBe("failed");
  });

  // Observed live: failureCode carries bare SIP response codes, undocumented.
  test.each([
    ["408", "no_answer"],   // Request Timeout
    ["480", "no_answer"],   // Temporarily Unavailable — seen on a real call
    ["486", "no_answer"],   // Busy Here
    ["603", "no_answer"],   // Decline
    ["404", "failed"],      // Not Found — unroutable, seen on a real call
    ["500", "failed"],      // Server Error
  ])("SIP failureCode %s → %s", (code, expected) => {
    expect(toSentinelCallState(call("failed", "failed", { failureCode: code }))).toBe(expected);
  });

  test("a 480 while the task still reads queued is still no_answer", () => {
    // The task-level status lags the attempt by seconds — do not trust it.
    expect(
      toSentinelCallState(call("queued", "failed", { failureCode: "480" }))
    ).toBe("no_answer");
  });

  test("canceled → failed", () => {
    expect(toSentinelCallState(call("canceled", "canceled"))).toBe("failed");
  });

  test("falls back to task status when there are no attempts yet", () => {
    expect(toSentinelCallState(call("queued"))).toBe("queued");
  });

  test("terminal states are exactly completed / failed / no_answer", () => {
    expect(isTerminalState("completed")).toBe(true);
    expect(isTerminalState("failed")).toBe(true);
    expect(isTerminalState("no_answer")).toBe(true);
    expect(isTerminalState("dialling")).toBe(false);
    expect(isTerminalState("in_conversation")).toBe(false);
  });
});

describe("collectTurns", () => {
  test("normalises speaker labels to the frozen AGENT/HUMAN union", () => {
    const turns = collectTurns(
      call("completed", "completed", {
        turns: [
          { speaker: "assistant", text: "Hello" },
          { speaker: "user", text: "I'm busy" },
          { speaker: "AGENT", text: "What is your ETA?" },
        ],
      })
    );
    expect(turns.map((t) => t.speaker)).toEqual(["AGENT", "HUMAN", "AGENT"]);
    expect(turns[1].text).toBe("I'm busy");
  });
});

// ─── Polling loop (FR-5.2) ───────────────────────────────────────────────────

describe("pollCallToCompletion", () => {
  test("emits each state exactly once, in order, and never repeats", async () => {
    const sequence: PollableCall[] = [
      call("queued", "queued"),
      call("in_progress", "dialing"),
      call("in_progress", "dialing"),      // unchanged — must not re-emit
      call("in_progress", "in_progress", { turns: [{ speaker: "agent", text: "Hello" }] }),
      call("completed", "completed"),
    ];
    let i = 0;
    const states: string[] = [];

    await pollCallToCompletion(
      "call-1",
      async () => sequence[Math.min(i++, sequence.length - 1)],
      { onState: (s) => states.push(s) },
      { intervalMs: 0 }
    );

    expect(states).toEqual(["queued", "dialling", "in_conversation", "completed"]);
  });

  test("streams each transcript turn once as it appears", async () => {
    const sequence: PollableCall[] = [
      call("in_progress", "in_progress", { turns: [{ speaker: "agent", text: "one" }] }),
      call("in_progress", "in_progress", {
        turns: [
          { speaker: "agent", text: "one" },
          { speaker: "human", text: "two" },
        ],
      }),
      call("completed", "completed", {
        turns: [
          { speaker: "agent", text: "one" },
          { speaker: "human", text: "two" },
        ],
      }),
    ];
    let i = 0;
    const texts: string[] = [];

    await pollCallToCompletion(
      "call-1",
      async () => sequence[Math.min(i++, sequence.length - 1)],
      { onTranscript: (t) => texts.push(t.text) },
      { intervalMs: 0 }
    );

    expect(texts).toEqual(["one", "two"]);
  });

  test("does not re-emit a state the caller already emitted", async () => {
    // executeCall emits the opening state straight after create(); the first
    // poll must not repeat it.
    const states: string[] = [];
    await pollCallToCompletion(
      "call-1",
      async () => call("completed", "completed"),
      { onState: (s) => states.push(s) },
      { intervalMs: 0, alreadyEmitted: "completed" }
    );
    expect(states).toEqual([]);
  });

  test("does not re-emit a turn that CALL-E later revises", async () => {
    // Observed live: "hello." was republished as "Hello." on a later poll,
    // which re-streamed the whole tail of the conversation to the dashboard.
    const sequence: PollableCall[] = [
      call("in_progress", "in_progress", {
        turns: [{ speaker: "human", text: "hello." }],
      }),
      call("completed", "completed", {
        turns: [
          { speaker: "human", text: "Hello." },       // same turn, recased
          { speaker: "agent", text: "Are you available?" },
        ],
      }),
    ];
    let i = 0;
    const texts: string[] = [];

    await pollCallToCompletion(
      "call-1",
      async () => sequence[Math.min(i++, sequence.length - 1)],
      { onTranscript: (t) => texts.push(t.text) },
      { intervalMs: 0 }
    );

    expect(texts).toEqual(["hello.", "Are you available?"]);
  });

  test("stops as soon as a terminal state is reached", async () => {
    let polls = 0;
    await pollCallToCompletion(
      "call-1",
      async () => { polls++; return call("completed", "completed"); },
      {},
      { intervalMs: 0 }
    );
    expect(polls).toBe(1);
  });

  // A call may never run unbounded — but the budget starts when the phone
  // actually rings, not when we handed the task to CALL-E.
  const dialling = () =>
    call("in_progress", "in_progress", { startedAt: "2026-09-13T18:56:10Z" });

  test("throws CallTimeoutError once the conversation ceiling is passed", async () => {
    await expect(
      pollCallToCompletion("call-1", async () => dialling(), {}, {
        intervalMs: 0,
        timeoutMs: 0,
      })
    ).rejects.toBeInstanceOf(CallTimeoutError);
  });

  test("emits a failed state before giving up on timeout", async () => {
    const states: string[] = [];
    await pollCallToCompletion("call-1", async () => dialling(), {
      onState: (s) => states.push(s),
    }, { intervalMs: 0, timeoutMs: 0 }).catch(() => {});

    expect(states[states.length - 1]).toBe("failed");
  });
});

// ─── A call in progress is indistinguishable from a call in the queue ────────
//
// OBSERVED (live call 2026-09-14, call_pTAB-O4ueJdAITNenOEA5Q): a 44-turn
// conversation ran to completion while every poll returned task "queued",
// attempt "in_progress", startedAt null, providerCallId null, zero turns. The
// fields only appeared once the task went terminal.
//
// These tests exist to stop anyone reintroducing a "has the dial started?"
// heuristic. There is no such signal; a budget built on one cuts off real
// calls, and we have discarded two genuine commitments proving it.

describe("polling a call that never looks like it started", () => {
  test("keeps polling through a queue-shaped call and returns the real result", async () => {
    let polls = 0;

    const result = await pollCallToCompletion(
      "call-1",
      async () => {
        polls++;
        // Exactly what CALL-E returned for 90 consecutive polls on 2026-09-14.
        if (polls <= 90) return call("queued", "in_progress");
        // …and then, all at once, the whole call.
        return call("completed", "completed", {
          startedAt: "2026-09-13T19:12:49Z",
          providerCallId: "e755290e",
          turns: [{ speaker: "bot", text: "hello" }],
        });
      },
      {},
      { intervalMs: 0, timeoutMs: 60_000 }
    );

    expect(toSentinelCallState(result)).toBe("completed");
    expect(polls).toBe(91);
  });

  test("gives up on one overall deadline, not a queue-specific one", async () => {
    await expect(
      pollCallToCompletion(
        "call-1",
        async () => call("queued", "in_progress"),
        {},
        { intervalMs: 0, timeoutMs: 0 }
      )
    ).rejects.toBeInstanceOf(CallTimeoutError);
  });

  test("the timeout message says the call may still be live", async () => {
    // Not cosmetic: graph.ts matches this substring to decide NOT to escalate.
    // If the wording changes here, a timeout starts ringing the next contact
    // while the first one is possibly mid-conversation. Keep them in step.
    await expect(
      pollCallToCompletion(
        "call-1",
        async () => call("queued", "in_progress"),
        {},
        { intervalMs: 0, timeoutMs: 0 }
      )
    ).rejects.toThrow(/may still be live/);
  });

  test("emits failed to the dashboard so the theatre does not hang", async () => {
    const states: string[] = [];

    await pollCallToCompletion(
      "call-1",
      async () => call("queued", "in_progress"),
      { onState: (s) => states.push(s) },
      { intervalMs: 0, timeoutMs: 0 }
    ).catch(() => {});

    expect(states.at(-1)).toBe("failed");
  });
});

// ─── Retry policy (F10) ──────────────────────────────────────────────────────

describe("withRetry", () => {
  test("retries a transient failure and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("503 upstream");
      return "ok";
    }, { sleep: noSleep });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("gives up after 3 attempts and rethrows the last error", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error("persistent outage");
      }, { sleep: noSleep })
    ).rejects.toThrow("persistent outage");

    expect(attempts).toBe(3);
  });

  test("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    await withRetry(
      async () => { throw new Error("fail"); },
      { baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } }
    ).catch(() => {});

    expect(delays).toEqual([100, 200]);   // 2 sleeps for 3 attempts
  });

  test("never retries a timeout — the technician's phone already rang", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new CallTimeoutError("call-1", 1000);
      }, { sleep: noSleep })
    ).rejects.toBeInstanceOf(CallTimeoutError);

    expect(attempts).toBe(1);
  });
});
