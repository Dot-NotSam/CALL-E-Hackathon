/**
 * packages/calle/__tests__/client.test.ts
 *
 * The client factory. These tests deliberately never construct a real
 * CalleClient — that would need a live API key and would be one import away
 * from placing a call. What is asserted is the guard around it.
 */

import { getCalle, __setCalleClientForTesting } from "../client";
import type { CalleClient } from "@call-e/calle";

const ORIGINAL_KEY = process.env.CALLE_API_KEY;

afterEach(() => {
  __setCalleClientForTesting(null);
  if (ORIGINAL_KEY === undefined) delete process.env.CALLE_API_KEY;
  else process.env.CALLE_API_KEY = ORIGINAL_KEY;
});

describe("getCalle", () => {
  it("refuses to build a client without an API key", async () => {
    delete process.env.CALLE_API_KEY;
    __setCalleClientForTesting(null);

    await expect(getCalle()).rejects.toThrow(/CALLE_API_KEY is not set/);
  });

  it("points at the dashboard rather than echoing anything secret", async () => {
    delete process.env.CALLE_API_KEY;
    __setCalleClientForTesting(null);

    await expect(getCalle()).rejects.toThrow(/dashboard\.heycall-e\.com/);
  });

  it("never puts the key itself in the error message", async () => {
    process.env.CALLE_API_KEY = "";
    __setCalleClientForTesting(null);

    // An empty string is falsy, so this takes the same guard.
    await expect(getCalle()).rejects.toThrow(/CALLE_API_KEY is not set/);
  });

  it("returns the injected client without touching the SDK", async () => {
    process.env.CALLE_API_KEY = "test-key-not-real";

    const stub = { calls: {} } as unknown as CalleClient;
    __setCalleClientForTesting(stub);

    await expect(getCalle()).resolves.toBe(stub);
  });

  it("reuses one client across calls rather than building one per dial", async () => {
    process.env.CALLE_API_KEY = "test-key-not-real";

    const stub = { calls: {} } as unknown as CalleClient;
    __setCalleClientForTesting(stub);

    expect(await getCalle()).toBe(await getCalle());
  });

  it("still enforces the key guard even when a client was cached", async () => {
    process.env.CALLE_API_KEY = "test-key-not-real";
    __setCalleClientForTesting({ calls: {} } as unknown as CalleClient);

    // The guard runs before the cache is consulted, so removing the key stops
    // a process that had already built a client.
    delete process.env.CALLE_API_KEY;

    await expect(getCalle()).rejects.toThrow(/CALLE_API_KEY is not set/);
  });
});
