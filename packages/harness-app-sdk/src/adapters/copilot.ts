import {
  approveAll,
  CopilotClient,
  type PermissionHandler,
  type SessionEvent
} from "@github/copilot-sdk";
import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { runCommand } from "../process.js";
import { detectVersion, extraArgs, runProviderCommand, type AdapterOptions } from "./shared.js";
import { createJsonlStreamParser } from "../streaming.js";
import { createSdkRunRecorder, shouldUseCli } from "./sdk-shared.js";

interface CopilotSdk {
  CopilotClient: typeof CopilotClient;
  approveAll: PermissionHandler;
}

type CopilotAdapterOptions = Partial<AdapterOptions> & {
  sdk?: CopilotSdk;
};

const denyPermissions: PermissionHandler = () => ({
  kind: "reject",
  feedback: "Harness is running this request in read-only mode."
});

export function createCopilotAdapter(options: CopilotAdapterOptions = {}): ProviderAdapter {
  const command = options.command ?? "copilot";
  const runner = options.runner ?? runCommand;
  const env = options.env ?? {};
  const sdk = options.sdk ?? { CopilotClient, approveAll };

  return {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: shouldUseCli(options) ? command : "@github/copilot-sdk",
    async detect(): Promise<ProviderStatus> {
      if (!shouldUseCli(options)) {
        return await detectCopilotSdk(sdk, env);
      }

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
      if (!shouldUseCli(options)) {
        return await runCopilotSdk(sdk, request);
      }

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

async function detectCopilotSdk(sdk: CopilotSdk, env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const client = new sdk.CopilotClient({
    env: { ...process.env, ...env },
    logLevel: "none",
    workingDirectory: process.cwd()
  });

  try {
    await client.start();
    const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);

    return {
      id: "copilot",
      name: "GitHub Copilot CLI",
      command: "@github/copilot-sdk",
      available: true,
      authenticated: auth.isAuthenticated,
      version: status.version,
      message: auth.isAuthenticated
        ? undefined
        : auth.statusMessage ?? "Copilot is installed but not authenticated."
    };
  } catch (error) {
    return {
      id: "copilot",
      name: "GitHub Copilot CLI",
      command: "@github/copilot-sdk",
      available: false,
      authenticated: false,
      message: error instanceof Error ? error.message : "Unable to start the Copilot SDK runtime."
    };
  } finally {
    await client.stop().catch(() => []);
  }
}

async function runCopilotSdk(sdk: CopilotSdk, request: ResolvedHarnessRunRequest) {
  const command = "@github/copilot-sdk";
  const args = ["send", ...(request.model ? ["--model", request.model] : [])];
  const recorder = createSdkRunRecorder("copilot", command, args, request);
  const client = new sdk.CopilotClient({
    env: request.env,
    logLevel: "none",
    workingDirectory: request.cwd
  });
  let session: Awaited<ReturnType<InstanceType<typeof CopilotClient>["createSession"]>> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const handleEvent = (event: SessionEvent) => {
    recorder.emitRaw(event);

    if (event.type === "session.error") {
      recorder.emitStderr(event.data.message);
    }
  };

  try {
    await client.start();
    session = await client.createSession({
      model: request.model,
      onEvent: handleEvent,
      onPermissionRequest: request.allowEdits ? sdk.approveAll : denyPermissions,
      streaming: request.stream,
      workingDirectory: request.cwd
    });

    const abort = () => {
      void session?.abort().catch(() => undefined);
    };

    recorder.signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => recorder.signal.removeEventListener("abort", abort);

    const response = await session.sendAndWait({ prompt: request.prompt }, request.timeoutMs);

    if (response?.data.content) {
      recorder.recordText(response.data.content);
    }

    return recorder.result();
  } catch (error) {
    recorder.fail(error);
    return recorder.result(recorder.aborted || recorder.timedOut ? null : 1);
  } finally {
    removeAbortListener?.();
    await session?.disconnect().catch(() => undefined);
    await client.stop().catch(() => []);
    recorder.close();
  }
}

function withoutVersionResult<T extends ProviderStatus & { versionResult?: unknown }>(
  status: T
): ProviderStatus {
  const { versionResult: _versionResult, ...publicStatus } = status;
  return publicStatus;
}
