import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";

export function createCodexAdapter(options: Partial<AdapterOptions> = {}): ProviderAdapter {
  const command = options.command ?? "codex";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};

  return {
    id: "codex",
    name: "Codex CLI",
    command,
    async detect(): Promise<ProviderStatus> {
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

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
