import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";

export function createClaudeAdapter(options: Partial<AdapterOptions> = {}): ProviderAdapter {
  const command = options.command ?? "claude";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};

  return {
    id: "claude",
    name: "Claude Code",
    command,
    async detect(): Promise<ProviderStatus> {
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
      const args = ["-p", request.prompt, "--output-format"];
      args.push(request.stream ? "stream-json" : "text");

      if (request.stream) {
        args.push("--include-partial-messages");
      }

      args.push("--permission-mode");
      args.push(request.allowEdits ? "default" : "plan");

      if (request.model) {
        args.push("--model", request.model);
      }

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

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
