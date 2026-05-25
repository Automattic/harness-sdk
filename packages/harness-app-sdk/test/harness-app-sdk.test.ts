import { describe, expect, it } from "vitest";
import {
  createClaudeAdapter,
  createCodexAdapter,
  createCopilotAdapter,
  createHarnessClient,
  HarnessSdkError,
  type CommandResult,
  type CommandRunner,
  type ProviderAdapter,
  type ResolvedHarnessRunRequest
} from "../src/index.js";

interface RunnerCall {
  command: string;
  args: string[];
}

function createMockRunner(
  handler: (command: string, args: string[]) => Partial<CommandResult>
): CommandRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner = (async (command, args, options) => {
    calls.push({ command, args });
    const result = handler(command, args);

    return {
      command,
      args,
      cwd: options.cwd,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      ...result
    };
  }) as CommandRunner & { calls: RunnerCall[] };

  runner.calls = calls;
  return runner;
}

describe("provider adapters", () => {
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

  it("uses conservative command flags by default", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));
    const request = createRequest();

    await createClaudeAdapter({ runner }).run(request);
    await createCodexAdapter({ runner }).run(request);
    await createCopilotAdapter({ runner }).run(request);

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
    expect(runner.calls[2]?.args).toContain("--no-ask-user");
  });

  it("lets callers opt in to edit-capable provider modes", async () => {
    const runner = createMockRunner(() => ({ stdout: "ok\n" }));

    await createClaudeAdapter({ runner }).run(createRequest({ allowEdits: true }));
    await createCodexAdapter({ runner }).run(createRequest({ allowEdits: true }));

    expect(runner.calls[0]?.args).toContain("default");
    expect(runner.calls[1]?.args).toContain("workspace-write");
  });
});

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
    ...overrides
  };
}

function fakeProvider(
  id: "claude" | "codex" | "copilot",
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
        ...result
      };
    }
  };
}
