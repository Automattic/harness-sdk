import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { createJsonlStreamParser } from "../streaming.js";
import { detectVersion, runProviderCommand, type AdapterOptions } from "./shared.js";

export function createGeminiAdapter(options: Partial<AdapterOptions> = {}): ProviderAdapter {
  const command = options.command ?? "gemini";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};

  return {
    id: "gemini",
    name: "Gemini CLI",
    command,
    async detect(): Promise<ProviderStatus> {
      const base = await detectVersion("gemini", "Gemini CLI", command, runner, process.cwd(), env);

      if (!base.available) {
        return withoutVersionResult(base);
      }

      return {
        ...withoutVersionResult(base),
        authenticated: null,
        message: "Gemini authentication is checked when a run starts. Run `gemini` to sign in if it fails."
      };
    },
    async run(request: ResolvedHarnessRunRequest) {
      const args = ["-p", request.prompt, "--output-format"];
      args.push(request.stream ? "stream-json" : "text");
      args.push("--approval-mode", request.allowEdits ? "auto_edit" : "plan");

      if (request.model) {
        args.push("-m", request.model);
      }

      return await runProviderCommand(
        "gemini",
        command,
        args,
        request,
        runner,
        request.stream ? createJsonlStreamParser("gemini") : undefined
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
