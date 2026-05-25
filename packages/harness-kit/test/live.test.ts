import { describe, expect, test } from "vitest";
import { createHarnessClient } from "../src/index.js";

const liveTest = process.env.HARNESS_KIT_LIVE === "1" ? test : test.skip;

describe("live local providers", () => {
  liveTest("detects installed provider CLIs without requiring API keys", async () => {
    const client = createHarnessClient();
    const statuses = await client.detect();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.some((status) => status.available)).toBe(true);
  });
});
