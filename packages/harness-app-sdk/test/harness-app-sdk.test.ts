import { describe, expect, it } from "vitest";
import {
  createClaudeAdapter,
  createCodexAdapter,
  createCopilotAdapter,
  createGeminiAdapter,
  createHarnessClient,
  HarnessSdkError,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions,
  type HarnessEvent,
  type ProviderAdapter,
  type ProviderId,
  type ResolvedHarnessRunRequest
} from "../src/index.js";
import { redactSecrets } from "../src/process.js";

interface RunnerCall {
  command: string;
  args: string[];
}

function createMockRunner(
  handler: (
    command: string,
    args: string[],
    options: CommandRunnerOptions
  ) => Partial<CommandResult> | void
): CommandRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner = (async (command, args, options) => {
    calls.push({ command, args });
    const wrappedOptions: CommandRunnerOptions = {
      ...options,
      onStdout: (chunk) => options.onStdout?.(redactSecrets(chunk)),
      onStderr: (chunk) => options.onStderr?.(redactSecrets(chunk))
    };
    const result = handler(command, args, wrappedOptions) ?? {};

    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      aborted: false,
      ...result
    };
  }) as CommandRunner & { calls: RunnerCall[] };

  runner.calls = calls;
  return runner;
}

describe("provider detection", () => {
  it("detects Claude availability and auth through the local CLI", async () => {
    const runner = createMockRunner((_command, args) => {
      if (args.join(" ") === "--version") {
        return { stdout: "2.1.85 (Claude Code)\n" };
      }

      if (args.join(" ") === "auth status") {
        return { stdout: JSON.stringify({ loggedIn: true }) };
      }

      return {};
    });

    const adapter = createClaudeAdapter({ runner });
    const status = await adapter.detect();

    expect(status).toMatchObject({
      id: "claude",
      available: true,
      authenticated: true,
      version: "2.1.85 (Claude Code)"
    });
  });

  it("returns a useful Claude login message when auth fails", async () => {
    const runner = createMockRunner((_command, args) => {
      if (args.join(" ") === "--version") {
        return { stdout: "2.1.85 (Claude Code)\n" };
      }

      if (args.join(" ") === "auth status") {
        return { exitCode: 1, stderr: "not logged in" };
      }

      return {};
    });

    const adapter = createClaudeAdapter({ runner });
    const status = await adapter.detect();

    expect(status.authenticated).toBe(false);
    expect(status.message).toBe("Claude is installed but not logged in. Run `claude auth login`.");
  });

  it("reports missing provider binaries", async () => {
    const runner = createMockRunner(() => ({
      exitCode: null,
      error: Object.assign(new Error("not found"), { code: "ENOENT" })
    }));

    const status = await createGeminiAdapter({ runner }).detect();

    expect(status).toMatchObject({
      id: "gemini",
      available: false,
      authenticated: false
    });
    expect(status.message).toContain("Gemini CLI is not installed");
  });
});

describe("adapter command construction", () => {
  it("uses conservative non-streaming command flags by default", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));
    const request = createRequest();

    await createClaudeAdapter({ runner }).run(request);
    await createCodexAdapter({ runner }).run(request);
    await createCopilotAdapter({ runner }).run(request);
    await createGeminiAdapter({ runner }).run(request);

    expect(runner.calls[0]?.args).toEqual([
      "-p",
      "Say hello",
      "--output-format",
      "text",
      "--permission-mode",
      "plan"
    ]);
    expect(runner.calls[1]?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "Say hello"
    ]);
    expect(runner.calls[2]?.args).toEqual([
      "-p",
      "Say hello",
      "--no-ask-user",
      "--no-auto-update",
      "--output-format",
      "text",
      "--stream",
      "off"
    ]);
    expect(runner.calls[3]?.args).toEqual([
      "-p",
      "Say hello",
      "--output-format",
      "text",
      "--approval-mode",
      "plan"
    ]);
  });

  it("uses native streaming flags for every provider", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));
    const request = createRequest({ stream: true });

    await createClaudeAdapter({ runner }).run(request);
    await createCodexAdapter({ runner }).run(request);
    await createCopilotAdapter({ runner }).run(request);
    await createGeminiAdapter({ runner }).run(request);

    expect(runner.calls[0]?.args).toEqual([
      "-p",
      "Say hello",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "plan"
    ]);
    expect(runner.calls[1]?.args).toContain("--json");
    expect(runner.calls[2]?.args).toEqual([
      "-p",
      "Say hello",
      "--no-ask-user",
      "--no-auto-update",
      "--output-format",
      "json",
      "--stream",
      "on"
    ]);
    expect(runner.calls[3]?.args).toEqual([
      "-p",
      "Say hello",
      "--output-format",
      "stream-json",
      "--approval-mode",
      "plan"
    ]);
  });

  it("lets callers opt in to edit-capable provider modes", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));

    await createClaudeAdapter({ runner }).run(createRequest({ allowEdits: true }));
    await createCodexAdapter({ runner }).run(createRequest({ allowEdits: true }));
    await createGeminiAdapter({ runner }).run(createRequest({ allowEdits: true }));

    expect(runner.calls[0]?.args).toContain("default");
    expect(runner.calls[1]?.args).toContain("workspace-write");
    expect(runner.calls[2]?.args).toContain("auto_edit");
  });

  it("passes request args through to provider CLIs", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));

    await createClaudeAdapter({ runner }).run(createRequest({ args: ["--debug"] }));
    await createCodexAdapter({ runner }).run(createRequest({ args: ["--profile", "work"] }));
    await createCopilotAdapter({ runner }).run(createRequest({ args: ["--model", "gpt-5.2"] }));
    await createGeminiAdapter({ runner }).run(createRequest({ args: ["--sandbox"] }));

    expect(runner.calls[0]?.args.at(-1)).toBe("--debug");
    expect(runner.calls[1]?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--profile",
      "work",
      "Say hello"
    ]);
    expect(runner.calls[2]?.args.slice(-2)).toEqual(["--model", "gpt-5.2"]);
    expect(runner.calls[3]?.args.at(-1)).toBe("--sandbox");
  });
});

describe("adapter streaming", () => {
  it("extracts Claude content block deltas without duplicating final result events", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.(
        [
          '{"type":"system","subtype":"init"}',
          '{"type":"stream_event","event":{"type":"message_start","message":{"content":[]}}}',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"HEL"}}}',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"LO"}}}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"HELLO"}]}}',
          '{"type":"result","subtype":"success","result":"HELLO"}'
        ].join("\n") + "\n"
      );
      return {
        stdout: ""
      };
    });

    const result = await createClaudeAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(events.some((event) => event.type === "raw")).toBe(true);
    expect(chunkText(events)).toBe("HELLO");
    expect(result.text).toBe("HELLO");
  });

  it("extracts Codex completed agent messages instead of event names", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.(
        [
          '{"type":"thread.started","thread_id":"thread"}',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"HELLO"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1}}'
        ].join("\n") + "\n"
      );
      return { stdout: "" };
    });

    const result = await createCodexAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(chunkText(events)).toBe("HELLO");
    expect(chunkText(events)).not.toContain("thread.started");
    expect(result.text).toBe("HELLO");
  });

  it("extracts Copilot assistant deltas and ignores final duplicate message events", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.(
        [
          '{"type":"session.mcp_servers_loaded","data":{"servers":[]}}',
          '{"type":"assistant.message_delta","data":{"messageId":"msg","deltaContent":"H"}}',
          '{"type":"assistant.message_delta","data":{"messageId":"msg","deltaContent":"ELLO"}}',
          '{"type":"assistant.message","data":{"messageId":"msg","content":"HELLO"}}',
          '{"type":"result","exitCode":0}'
        ].join("\n") + "\n"
      );
      return { stdout: "" };
    });

    const result = await createCopilotAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(chunkText(events)).toBe("HELLO");
    expect(chunkText(events)).not.toContain("assistant.message_delta");
    expect(result.text).toBe("HELLO");
  });

  it("extracts Gemini assistant message deltas and skips user/result events", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.(
        [
          '{"type":"init","session_id":"session","model":"gemini-3-flash-preview"}',
          '{"type":"message","role":"user","content":"Reply with exactly HELLO."}',
          '{"type":"message","role":"assistant","content":"HELLO","delta":true}',
          '{"type":"result","status":"success"}'
        ].join("\n") + "\n"
      );
      return { stdout: "" };
    });

    const result = await createGeminiAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(chunkText(events)).toBe("HELLO");
    expect(chunkText(events)).not.toContain("Reply with exactly HELLO");
    expect(result.text).toBe("HELLO");
  });

  it("keeps malformed JSONL as raw events without throwing from the parser", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.("{not-json}\n");
      return { stdout: "{not-json}\n" };
    });

    await createGeminiAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "raw",
          data: "{not-json}",
          message: "Unable to parse provider JSONL event."
        })
      ])
    );
  });

  it("redacts streamed stdout and stderr chunks", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.("OPENAI_API_KEY=secret-value\n");
      options.onStderr?.("TOKEN=another-secret\n");
      return {
        stdout: "OPENAI_API_KEY=[redacted]\n",
        stderr: "TOKEN=[redacted]\n"
      };
    });

    await createClaudeAdapter({ runner }).run(
      createRequest({
        onEvent: (event) => events.push(event)
      })
    );

    expect(events.map((event) => event.data).join("\n")).not.toContain("secret-value");
    expect(events.map((event) => event.data).join("\n")).not.toContain("another-secret");
  });
});

function chunkText(events: HarnessEvent[]): string {
  return events
    .filter((event) => event.type === "chunk")
    .map((event) => event.text)
    .join("");
}

describe("harness client", () => {
  it("auto-selects the first available authenticated provider", async () => {
    const providers: ProviderAdapter[] = [
      fakeProvider("claude", false),
      fakeProvider("codex", true, "from codex")
    ];
    const client = createHarnessClient({ providers });

    const result = await client.run({ prompt: "Summarize this project" });

    expect(result.provider).toBe("codex");
    expect(result.text).toBe("from codex");
  });

  it("calls both client-level and request-level event handlers", async () => {
    const clientEvents: HarnessEvent[] = [];
    const requestEvents: HarnessEvent[] = [];
    const client = createHarnessClient({
      providers: [fakeProvider("gemini", true, "from gemini")],
      onEvent: (event) => clientEvents.push(event)
    });

    await client.run({
      prompt: "Stream this",
      onEvent: (event) => requestEvents.push(event)
    });

    expect(clientEvents.map((event) => event.type)).toContain("chunk");
    expect(requestEvents.map((event) => event.type)).toContain("chunk");
  });

  it("throws a normalized error for failed provider runs", async () => {
    const client = createHarnessClient({
      providers: [
        fakeProvider("copilot", true, "", {
          exitCode: 1,
          stderr: "permission denied"
        })
      ]
    });

    await expect(client.run({ prompt: "Edit files" })).rejects.toMatchObject({
      name: "HarnessSdkError",
      code: "PROVIDER_RUN_FAILED",
      provider: "copilot",
      message: "permission denied"
    } satisfies Partial<HarnessSdkError>);
  });
});

function createRequest(overrides: Partial<ResolvedHarnessRunRequest> = {}): ResolvedHarnessRunRequest {
  return {
    prompt: "Say hello",
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1_000,
    stream: Boolean(overrides.onEvent),
    ...overrides
  };
}

function fakeProvider(
  id: ProviderId,
  authenticated: boolean,
  text = "ok",
  result: Partial<CommandResult> = {}
): ProviderAdapter {
  return {
    id,
    name: id,
    command: id,
    async detect() {
      return {
        id,
        name: id,
        command: id,
        available: true,
        authenticated
      };
    },
    async run(request) {
      request.onEvent?.({ type: "start", provider: id, command: id, args: [request.prompt] });
      request.onEvent?.({ type: "chunk", provider: id, text, data: text });
      request.onEvent?.({ type: "exit", provider: id, command: id, args: [request.prompt], exitCode: 0 });

      return {
        provider: id,
        command: id,
        args: [request.prompt],
        cwd: request.cwd,
        exitCode: 0,
        stdout: `${text}\n`,
        stderr: "",
        text,
        durationMs: 1,
        timedOut: false,
        aborted: false,
        ...result
      };
    }
  };
}
