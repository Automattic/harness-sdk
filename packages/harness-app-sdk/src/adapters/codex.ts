import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";
import { createSdkRunRecorder, envForSdk, shouldUseCli } from "./sdk-shared.js";

interface CodexSdk {
  Codex: typeof Codex;
}

type CodexAdapterOptions = Partial<AdapterOptions> & {
  sdk?: CodexSdk;
};

export function createCodexAdapter(options: CodexAdapterOptions = {}): ProviderAdapter {
  const command = options.command ?? "codex";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};
  const sdk = options.sdk ?? { Codex };

  return {
    id: "codex",
    name: "Codex CLI",
    command: shouldUseCli(options) ? command : "@openai/codex-sdk",
    async detect(): Promise<ProviderStatus> {
      if (!shouldUseCli(options)) {
        return {
          id: "codex",
          name: "Codex CLI",
          command: "@openai/codex-sdk",
          available: true,
          authenticated: null,
          message: "Codex authentication is checked when an SDK run starts."
        };
      }

      const base = await detectVersion("codex", "Codex CLI", command, runner, process.cwd(), env);

      if (!base.available) {
        return withoutVersionResult(base);
      }

      const auth = await runner(command, ["login", "status"], {
        cwd: process.cwd(),
        env,
        timeoutMs: 5_000
      });

      return {
        ...withoutVersionResult(base),
        authenticated: auth.exitCode === 0,
        message:
          auth.exitCode === 0
            ? undefined
            : "Codex is installed but not logged in. Run `codex login`."
      };
    },
    async run(request: ResolvedHarnessRunRequest) {
      if (!shouldUseCli(options)) {
        return await runCodexSdk(sdk, request);
      }

      const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox"];
      args.push(request.allowEdits ? "workspace-write" : "read-only");

      if (request.model) {
        args.push("--model", request.model);
      }

      args.push(...extraArgs(request));
      args.push(request.prompt);

      return await runProviderCommand("codex", command, args, request, runner, createJsonlStreamParser("codex"));
    }
  };
}

async function runCodexSdk(sdk: CodexSdk, request: ResolvedHarnessRunRequest) {
  const command = "@openai/codex-sdk";
  const args = [
    "run",
    "--sandbox",
    request.allowEdits ? "workspace-write" : "read-only",
    ...(request.model ? ["--model", request.model] : [])
  ];
  const recorder = createSdkRunRecorder("codex", command, args, request);

  try {
    const codex = new sdk.Codex({ env: envForSdk(request.env) });
    const thread = codex.startThread({
      model: request.model,
      sandboxMode: request.allowEdits ? "workspace-write" : "read-only",
      skipGitRepoCheck: true,
      workingDirectory: request.cwd
    });

    if (request.stream) {
      const streamed = await thread.runStreamed(request.prompt, { signal: recorder.signal });

      for await (const event of streamed.events as AsyncGenerator<ThreadEvent>) {
        recorder.emitRaw(event);

        if (event.type === "turn.failed") {
          recorder.emitStderr(event.error.message);
        }
      }

      return recorder.result();
    }

    const turn = await thread.run(request.prompt, { signal: recorder.signal });
    recorder.recordText(turn.finalResponse);
    return recorder.result();
  } catch (error) {
    recorder.fail(error);
    return recorder.result(recorder.aborted || recorder.timedOut ? null : 1);
  } finally {
    recorder.close();
  }
}

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
