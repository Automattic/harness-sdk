import { query as claudeQuery, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";
import { createSdkRunRecorder, envForSdk, shouldUseCli } from "./sdk-shared.js";

interface ClaudeSdk {
  query: typeof claudeQuery;
}

type ClaudeAdapterOptions = Partial<AdapterOptions> & {
  sdk?: ClaudeSdk;
};

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): ProviderAdapter {
  const command = options.command ?? "claude";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};
  const sdk = options.sdk ?? { query: claudeQuery };

  return {
    id: "claude",
    name: "Claude Code",
    command: shouldUseCli(options) ? command : "@anthropic-ai/claude-agent-sdk",
    async detect(): Promise<ProviderStatus> {
      if (!shouldUseCli(options)) {
        return {
          id: "claude",
          name: "Claude Code",
          command: "@anthropic-ai/claude-agent-sdk",
          available: true,
          authenticated: null,
          message: "Claude authentication is checked when an SDK run starts."
        };
      }

      const base = await detectVersion("claude", "Claude Code", command, runner, process.cwd(), env);

      if (!base.available) {
        return withoutVersionResult(base);
      }

      const auth = await runner(command, ["auth", "status"], {
        cwd: process.cwd(),
        env,
        timeoutMs: 5_000
      });

      if (auth.exitCode !== 0) {
        return {
          ...withoutVersionResult(base),
          authenticated: false,
          message: "Claude is installed but not logged in. Run `claude auth login`."
        };
      }

      try {
        const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean };

        return {
          ...withoutVersionResult(base),
          authenticated: parsed.loggedIn === true,
          message:
            parsed.loggedIn === true
              ? undefined
              : "Claude is installed but not logged in. Run `claude auth login`."
        };
      } catch {
        return {
          ...withoutVersionResult(base),
          authenticated: true
        };
      }
    },
    async run(request: ResolvedHarnessRunRequest) {
      if (!shouldUseCli(options)) {
        return await runClaudeSdk(sdk, request);
      }

      const args = ["-p", request.prompt, "--output-format"];
      args.push(request.stream ? "stream-json" : "text");

      if (request.stream) {
        args.push("--include-partial-messages");
        args.push("--verbose");
      }

      args.push("--permission-mode");
      args.push(request.allowEdits ? "default" : "plan");

      if (request.model) {
        args.push("--model", request.model);
      }

      args.push(...extraArgs(request));

      return await runProviderCommand(
        "claude",
        command,
        args,
        request,
        runner,
        request.stream ? createJsonlStreamParser("claude") : undefined
      );
    }
  };
}

async function runClaudeSdk(sdk: ClaudeSdk, request: ResolvedHarnessRunRequest) {
  const command = "@anthropic-ai/claude-agent-sdk";
  const args = [
    "query",
    "--permission-mode",
    request.allowEdits ? "default" : "plan",
    ...(request.model ? ["--model", request.model] : [])
  ];
  const recorder = createSdkRunRecorder("claude", command, args, request);
  let query: Query | undefined;

  try {
    query = sdk.query({
      prompt: request.prompt,
      options: {
        abortController: abortControllerFromSignal(recorder.signal),
        cwd: request.cwd,
        env: envForSdk(request.env),
        includePartialMessages: request.stream,
        model: request.model,
        permissionMode: request.allowEdits ? "default" : "plan"
      }
    });

    for await (const message of query as AsyncIterable<SDKMessage>) {
      recorder.emitRaw(message);

      if (message.type === "result") {
        if (message.subtype === "success") {
          recorder.recordText(message.result);
        } else {
          recorder.emitStderr(message.errors.join("\n") || message.subtype);
        }
      }
    }

    return recorder.result();
  } catch (error) {
    recorder.fail(error);
    return recorder.result(recorder.aborted || recorder.timedOut ? null : 1);
  } finally {
    query?.close();
    recorder.close();
  }
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller;
}

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
