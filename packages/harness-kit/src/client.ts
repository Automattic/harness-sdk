import { createClaudeAdapter } from "./adapters/claude.js";
import { createCodexAdapter } from "./adapters/codex.js";
import { createCopilotAdapter } from "./adapters/copilot.js";
import { HarnessKitError } from "./errors.js";
import type {
  HarnessClientOptions,
  HarnessRunRequest,
  HarnessRunResult,
  ProviderAdapter,
  ProviderId,
  ProviderSelector,
  ProviderStatus,
  ResolvedHarnessRunRequest
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface HarnessClient {
  detect(): Promise<ProviderStatus[]>;
  run(request: HarnessRunRequest): Promise<HarnessRunResult>;
  providers(): ProviderAdapter[];
}

export function createHarnessClient(options: HarnessClientOptions = {}): HarnessClient {
  const providers =
    options.providers ??
    [
      createClaudeAdapter({ runner: options.runner, env: options.env }),
      createCodexAdapter({ runner: options.runner, env: options.env }),
      createCopilotAdapter({ runner: options.runner, env: options.env })
    ];

  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultProvider = options.defaultProvider ?? "auto";

  return {
    providers: () => [...providers],
    async detect() {
      return await Promise.all(providers.map((provider) => provider.detect()));
    },
    async run(request) {
      if (!request.prompt.trim()) {
        throw new HarnessKitError("INVALID_REQUEST", "Harness run requests require a non-empty prompt.");
      }

      const provider = await resolveProvider(request.provider ?? defaultProvider, providers);
      const resolvedRequest: ResolvedHarnessRunRequest = {
        ...request,
        cwd: request.cwd ?? cwd,
        env: { ...process.env, ...options.env, ...request.env },
        timeoutMs: request.timeoutMs ?? timeoutMs,
        onEvent: options.onEvent
      };

      const status = await provider.detect();

      if (!status.available) {
        throw new HarnessKitError(
          "PROVIDER_NOT_FOUND",
          status.message ?? `${provider.name} is not installed or available on PATH.`,
          { provider: provider.id, statuses: [status] }
        );
      }

      if (status.authenticated === false) {
        throw new HarnessKitError(
          "PROVIDER_NOT_AUTHENTICATED",
          status.message ?? `${provider.name} is installed but not logged in.`,
          { provider: provider.id, statuses: [status] }
        );
      }

      const result = await provider.run(resolvedRequest);

      if (result.exitCode !== 0) {
        throw new HarnessKitError(
          "PROVIDER_RUN_FAILED",
          result.stderr.trim() || result.stdout.trim() || `${provider.name} exited with ${result.exitCode}.`,
          { provider: provider.id }
        );
      }

      return result;
    }
  };
}

async function resolveProvider(
  selector: ProviderSelector,
  providers: ProviderAdapter[]
): Promise<ProviderAdapter> {
  if (selector !== "auto") {
    const provider = providers.find((candidate) => candidate.id === selector);

    if (!provider) {
      throw new HarnessKitError("PROVIDER_NOT_FOUND", `Unknown Harness provider: ${selector}.`);
    }

    return provider;
  }

  const statuses = await Promise.all(providers.map((provider) => provider.detect()));
  const status = statuses.find((candidate) => candidate.available && candidate.authenticated !== false);

  if (!status) {
    throw new HarnessKitError(
      "PROVIDER_NOT_FOUND",
      "No local Harness provider is available. Install and log in to Claude, Codex, or Copilot.",
      { statuses }
    );
  }

  const provider = providers.find((candidate) => candidate.id === status.id);

  if (!provider) {
    throw new HarnessKitError("PROVIDER_NOT_FOUND", `Detected unknown Harness provider: ${status.id}.`);
  }

  return provider;
}

export type { ProviderId };
