import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { createJsonlStreamParser } from "../streaming.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";

const WP_STUDIO_PACKAGE = "wp-studio@latest";

export function createWpStudioAdapter(options: Partial<AdapterOptions> = {}): ProviderAdapter {
  const command = options.command ?? "npx";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};

  return {
    id: "wp-studio",
    name: "WP Studio",
    command,
    async detect(): Promise<ProviderStatus> {
      const base = await detectVersion("wp-studio", "WP Studio", command, runner, process.cwd(), env);

      if (!base.available) {
        return withoutVersionResult(base);
      }

      return {
        ...withoutVersionResult(base),
        authenticated: null,
        message: "WP Studio runs through npx; package availability is checked when a run starts."
      };
    },
    async run(request: ResolvedHarnessRunRequest) {
      const args = [...npxYesArgs(command), WP_STUDIO_PACKAGE, "code", request.prompt];

      args.push(...extraArgs(request));
      args.push("--json");

      return await runProviderCommand(
        "wp-studio",
        command,
        args,
        request,
        runner,
        createJsonlStreamParser("wp-studio")
      );
    }
  };
}

function npxYesArgs(command: string): string[] {
  return command === "npx" || command.endsWith("/npx") || command.endsWith("\\npx") ? ["-y"] : [];
}

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
