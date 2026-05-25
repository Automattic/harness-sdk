import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";

export function createCopilotAdapter(options: Partial<AdapterOptions> = {}): ProviderAdapter {
  const command = options.command ?? "copilot";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};

  return {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command,
    async detect(): Promise<ProviderStatus> {
      const base = await detectVersion(
        "copilot",
        "GitHub Copilot CLI",
        command,
        runner,
        process.cwd(),
        env
      );

      if (!base.available) {
        return withoutVersionResult(base);
      }

      return {
        ...withoutVersionResult(base),
        authenticated: null,
        message: "Copilot authentication is checked when a run starts. Run `copilot login` if it fails."
      };
    },
    async run(request: ResolvedHarnessRunRequest) {
      const args = [
        "-p",
        request.prompt,
        "--no-ask-user",
        "--no-auto-update",
        "--output-format",
        request.stream ? "json" : "text",
        "--stream",
        request.stream ? "on" : "off"
      ];

      if (request.model) {
        args.push("--model", request.model);
      }

      args.push(...extraArgs(request));

      return await runProviderCommand(
        "copilot",
        command,
        args,
        request,
        runner,
        request.stream ? createJsonlStreamParser("copilot") : undefined
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
