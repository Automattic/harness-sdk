import { describe, expect, it } from "vitest";
import {
  createClaudeAdapter,
  createCodexAdapter,
  createCopilotAdapter,
  createCursorAdapter,
  createGeminiAdapter,
  createHarnessClient,
  createOpenCodeAdapter,
  createWpStudioAdapter,
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
    await createWpStudioAdapter({ runner }).run(request);

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
      "--skip-trust",
      "--approval-mode",
      "plan"
    ]);
    expect(runner.calls[4]?.command).toBe("npx");
    expect(runner.calls[4]?.args).toEqual(["-y", "wp-studio@latest", "code", "Say hello", "--json"]);
  });

  it("uses native streaming flags for every provider", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));
    const request = createRequest({ stream: true });

    await createClaudeAdapter({ runner }).run(request);
    await createCodexAdapter({ runner }).run(request);
    await createCopilotAdapter({ runner }).run(request);
    await createGeminiAdapter({ runner }).run(request);
    await createWpStudioAdapter({ runner }).run(request);

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
      "--skip-trust",
      "--approval-mode",
      "plan"
    ]);
    expect(runner.calls[4]?.args).toEqual(["-y", "wp-studio@latest", "code", "Say hello", "--json"]);
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
    await createWpStudioAdapter({ runner }).run(createRequest({ args: ["--foo", "bar"] }));

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
    expect(runner.calls[4]?.args).toEqual([
      "-y",
      "wp-studio@latest",
      "code",
      "Say hello",
      "--foo",
      "bar",
      "--json"
    ]);
  });
});

describe("adapter streaming", () => {
  it("uses the Claude Agent SDK by default", async () => {
    const events: HarnessEvent[] = [];
    const adapter = createClaudeAdapter({
      sdk: {
        query: () =>
          fakeClaudeQuery([
            {
              type: "stream_event",
              event: { type: "content_block_delta", delta: { text: "HELLO" } }
            },
            { type: "result", subtype: "success", result: "HELLO" }
          ])
      }
    });

    const result = await adapter.run(createRequest({ stream: true, onEvent: (event) => events.push(event) }));

    expect(result.command).toBe("@anthropic-ai/claude-agent-sdk");
    expect(result.text).toBe("HELLO");
    expect(chunkText(events)).toBe("HELLO");
  });

  it("keeps Claude Agent SDK runs programmatic when request args are present", async () => {
    const adapter = createClaudeAdapter({
      sdk: {
        query: () => fakeClaudeQuery([{ type: "result", subtype: "success", result: "HELLO" }])
      }
    });

    const result = await adapter.run(createRequest({ args: ["--debug"] }));

    expect(result.command).toBe("@anthropic-ai/claude-agent-sdk");
    expect(result.args).not.toContain("--debug");
    expect(result.text).toBe("HELLO");
  });

  it("uses the Codex SDK by default", async () => {
    const events: HarnessEvent[] = [];
    const adapter = createCodexAdapter({
      sdk: {
        Codex: class {
          startThread() {
            return {
              async runStreamed() {
                return {
                  events: fakeAsyncEvents([
                    { type: "thread.started", thread_id: "thread" },
                    {
                      type: "item.completed",
                      item: { id: "item", type: "agent_message", text: "HELLO" }
                    },
                    {
                      type: "turn.completed",
                      usage: {
                        cached_input_tokens: 0,
                        input_tokens: 1,
                        output_tokens: 1,
                        reasoning_output_tokens: 0
                      }
                    }
                  ])
                };
              }
            };
          }
        } as never
      }
    });

    const result = await adapter.run(createRequest({ stream: true, onEvent: (event) => events.push(event) }));

    expect(result.command).toBe("@openai/codex-sdk");
    expect(result.text).toBe("HELLO");
    expect(chunkText(events)).toBe("HELLO");
  });

  it("keeps Codex SDK runs programmatic when request args are present", async () => {
    const adapter = createCodexAdapter({
      sdk: {
        Codex: class {
          startThread() {
            return {
              async run() {
                return { finalResponse: "HELLO" };
              }
            };
          }
        } as never
      }
    });

    const result = await adapter.run(createRequest({ args: ["--profile", "work"] }));

    expect(result.command).toBe("@openai/codex-sdk");
    expect(result.args).not.toContain("--profile");
    expect(result.text).toBe("HELLO");
  });

  it("uses the Copilot SDK by default", async () => {
    const events: HarnessEvent[] = [];
    const adapter = createCopilotAdapter({
      sdk: {
        approveAll: () => ({ kind: "approve-once" }),
        CopilotClient: class {
          async start() {}
          async stop() {
            return [];
          }
          async createSession(config: { onEvent?: (event: unknown) => void }) {
            return {
              async abort() {},
              async disconnect() {},
              async sendAndWait() {
                config.onEvent?.({
                  type: "assistant.message_delta",
                  data: { messageId: "message", deltaContent: "HELLO" }
                });
                config.onEvent?.({
                  type: "assistant.message",
                  data: { messageId: "message", content: "HELLO" }
                });
                return { data: { content: "HELLO" } };
              }
            };
          }
        } as never
      }
    });

    const result = await adapter.run(createRequest({ stream: true, onEvent: (event) => events.push(event) }));

    expect(result.command).toBe("@github/copilot-sdk");
    expect(result.text).toBe("HELLO");
    expect(chunkText(events)).toBe("HELLO");
  });

  it("keeps Copilot SDK runs programmatic when request args are present", async () => {
    const adapter = createCopilotAdapter({
      sdk: {
        approveAll: () => ({ kind: "approve-once" }),
        CopilotClient: class {
          async start() {}
          async stop() {
            return [];
          }
          async createSession() {
            return {
              async abort() {},
              async disconnect() {},
              async sendAndWait() {
                return { data: { content: "HELLO" } };
              }
            };
          }
        } as never
      }
    });

    const result = await adapter.run(createRequest({ args: ["--model", "gpt-5.2"] }));

    expect(result.command).toBe("@github/copilot-sdk");
    expect(result.args).not.toContain("--model");
    expect(result.text).toBe("HELLO");
  });

  it("detects and runs Cursor through the Cursor SDK", async () => {
    const events: HarnessEvent[] = [];
    const adapter = createCursorAdapter({
      env: { CURSOR_API_KEY: "cursor-key" },
      sdk: {
        Cursor: class {
          static async me() {
            return { apiKeyName: "test", createdAt: "2026-01-01T00:00:00.000Z", userEmail: "dev@example.com" };
          }
        } as never,
        Agent: class {
          static async create() {
            return {
              close() {},
              async send() {
                return {
                  supports: () => true,
                  async *stream() {
                    yield {
                      type: "assistant",
                      agent_id: "agent",
                      run_id: "run",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "HELLO" }]
                      }
                    };
                  },
                  async wait() {
                    return { id: "run", agentId: "agent", status: "finished", result: "HELLO" };
                  },
                  async cancel() {}
                };
              }
            };
          }
        } as never
      }
    });

    const status = await adapter.detect();
    const result = await adapter.run(createRequest({ stream: true, onEvent: (event) => events.push(event) }));

    expect(status.authenticated).toBe(true);
    expect(result.command).toBe("@cursor/sdk");
    expect(result.text).toBe("HELLO");
    expect(chunkText(events)).toBe("HELLO");
  });

  it("detects and runs OpenCode through the OpenCode SDK", async () => {
    const events: HarnessEvent[] = [];
    let closed = false;
    const adapter = createOpenCodeAdapter({
      sdk: {
        async createOpencode() {
          return {
            client: {
              provider: {
                async list() {
                  return {
                    data: {
                      all: [],
                      default: {},
                      connected: ["anthropic"]
                    }
                  };
                }
              },
              session: {
                async create() {
                  return {
                    data: {
                      id: "session-1",
                      parentID: undefined,
                      title: "Harness run",
                      version: "1.0.0",
                      time: { created: Date.now(), updated: Date.now() }
                    }
                  };
                },
                async prompt(options: { body?: { model?: { providerID: string; modelID: string } } }) {
                  return {
                    data: {
                      info: {
                        id: "message-1",
                        sessionID: "session-1",
                        role: "assistant",
                        time: { created: Date.now() },
                        modelID: options.body?.model?.modelID ?? "claude-sonnet-4-5",
                        providerID: options.body?.model?.providerID ?? "anthropic"
                      },
                      parts: [
                        {
                          id: "part-1",
                          sessionID: "session-1",
                          messageID: "message-1",
                          type: "text",
                          text: "HELLO"
                        }
                      ]
                    }
                  };
                },
                async abort() {
                  return { data: true };
                }
              }
            },
            server: {
              url: "http://127.0.0.1:4096",
              close() {
                closed = true;
              }
            }
          };
        }
      } as never
    });

    const status = await adapter.detect();
    const result = await adapter.run(
      createRequest({
        model: "anthropic/claude-sonnet-4-5",
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(status).toMatchObject({
      id: "opencode",
      available: true,
      authenticated: true
    });
    expect(result.command).toBe("@opencode-ai/sdk");
    expect(result.args).toEqual(["session.prompt", "--model", "anthropic/claude-sonnet-4-5"]);
    expect(result.text).toBe("HELLO");
    expect(chunkText(events)).toBe("HELLO");
    expect(closed).toBe(true);
  });

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

  it("extracts WP Studio assistant deltas and ignores echoed/final duplicate messages", async () => {
    const events: HarnessEvent[] = [];
    const runner = createMockRunner((_command, _args, options) => {
      options.onStdout?.(
        [
          '{"type":"turn.started","timestamp":"2026-05-26T15:53:57.205Z"}',
          '{"type":"message","message":{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}}',
          '{"type":"message","message":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"HEL"},"message":{"role":"assistant","content":[{"type":"text","text":"HEL"}]}}}',
          '{"type":"message","message":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"LO"},"message":{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}}}',
          '{"type":"message","message":{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"HELLO"},"message":{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}}}',
          '{"type":"message","message":{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}}}',
          '{"type":"message","message":{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}}}',
          '{"type":"message","message":{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]},{"role":"assistant","content":[{"type":"text","text":"HELLO"}]}]}}',
          '{"type":"turn.completed","status":"success"}'
        ].join("\n") + "\n"
      );
      return { stdout: "" };
    });

    const result = await createWpStudioAdapter({ runner }).run(
      createRequest({
        stream: true,
        onEvent: (event) => events.push(event)
      })
    );

    expect(chunkText(events)).toBe("HELLO");
    expect(chunkText(events)).not.toContain("hello");
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

function fakeClaudeQuery(messages: unknown[]) {
  const iterator = fakeAsyncEvents(messages);

  return Object.assign(iterator, {
    close() {}
  });
}

async function* fakeAsyncEvents(messages: unknown[]) {
  for (const message of messages) {
    yield message;
  }
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
