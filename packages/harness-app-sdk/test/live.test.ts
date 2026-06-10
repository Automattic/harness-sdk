import { describe, expect, test } from "vitest";
import { createHarnessClient, type ProviderId } from "../src/index.js";

const liveTest = process.env.HARNESS_APP_SDK_LIVE === "1" ? test : test.skip;
const providers: ProviderId[] = ["claude", "codex", "copilot", "cursor", "gemini", "wp-studio"];

describe("live providers", () => {
  liveTest.each(providers)("detects %s with its configured authentication", async (provider) => {
    const client = createHarnessClient();
    const statuses = await client.detect();
    const status = statuses.find((candidate) => candidate.id === provider);

    expect(status).toBeDefined();

    if (!status?.available) {
      console.warn(`${provider} is not installed; live smoke skipped for this provider.`);
      return;
    }

    if (status.authenticated === false) {
      console.warn(`${provider} is installed but not authenticated; live smoke skipped for this provider.`);
      return;
    }

    expect(status.available).toBe(true);
  });

  liveTest.each(providers)("streams a tiny prompt with %s when available", async (provider) => {
    const client = createHarnessClient();
    const status = (await client.detect()).find((candidate) => candidate.id === provider);

    if (!status?.available || status.authenticated === false) {
      console.warn(`${provider} is unavailable or unauthenticated; live streaming smoke skipped.`);
      return;
    }

    const events: string[] = [];
    const result = await client.run({
      provider,
      prompt: "Reply with exactly: hello",
      stream: true,
      timeoutMs: 30_000,
      onEvent(event) {
        if (event.type === "chunk" && event.text) {
          events.push(event.text);
        }
      }
    });

    expect(result.provider).toBe(provider);
    expect(result.exitCode).toBe(0);
    expect(result.text || events.join("")).toContain("hello");
  });
});
