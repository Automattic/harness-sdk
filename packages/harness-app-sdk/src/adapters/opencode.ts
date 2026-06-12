import {
  createOpencode,
  type OpencodeClient,
  type ProviderListResponse,
  type ServerOptions,
  type SessionCreateResponse,
  type SessionPromptResponse
} from "@opencode-ai/sdk";
import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { createSdkRunRecorder, envForSdk, errorMessage } from "./sdk-shared.js";

interface OpenCodeServer {
  url: string;
  close(): void;
}

interface OpenCodeInstance {
  client: OpencodeClient;
  server: OpenCodeServer;
}

interface OpenCodeSdk {
  createOpencode(options?: ServerOptions): Promise<OpenCodeInstance>;
}

type OpenCodeAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  sdk?: OpenCodeSdk;
  serverTimeoutMs?: number;
};

type OpenCodeModel = {
  providerID: string;
  modelID: string;
};

const DEFAULT_SERVER_TIMEOUT_MS = 5_000;

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): ProviderAdapter {
  const env = options.env ?? {};
  const sdk = options.sdk ?? { createOpencode };
  const serverTimeoutMs = options.serverTimeoutMs ?? DEFAULT_SERVER_TIMEOUT_MS;

  return {
    id: "opencode",
    name: "OpenCode",
    command: "@opencode-ai/sdk",
    async detect(): Promise<ProviderStatus> {
      let opencode: OpenCodeInstance | undefined;

      try {
        opencode = await withProcessEnv(env, () =>
          sdk.createOpencode({
            timeout: serverTimeoutMs
          })
        );

        const providers = dataOrThrow<ProviderListResponse>(
          await opencode.client.provider.list({
            query: { directory: process.cwd() }
          }),
          "OpenCode provider detection"
        );
        const connected = providers.connected ?? [];

        return {
          id: "opencode",
          name: "OpenCode",
          command: "@opencode-ai/sdk",
          available: true,
          authenticated: connected.length > 0 ? true : null,
          message:
            connected.length > 0
              ? `Connected OpenCode provider${connected.length === 1 ? "" : "s"}: ${connected.join(", ")}.`
              : "OpenCode is available; provider authentication is checked when a run starts."
        };
      } catch (error) {
        return {
          id: "opencode",
          name: "OpenCode",
          command: "@opencode-ai/sdk",
          available: false,
          authenticated: false,
          message: errorMessage(error) || "Unable to start the OpenCode SDK runtime."
        };
      } finally {
        opencode?.server.close();
      }
    },
    async run(request: ResolvedHarnessRunRequest) {
      return await runOpenCodeSdk(sdk, request, serverTimeoutMs);
    }
  };
}

async function runOpenCodeSdk(
  sdk: OpenCodeSdk,
  request: ResolvedHarnessRunRequest,
  serverTimeoutMs: number
) {
  const command = "@opencode-ai/sdk";
  const args = ["session.prompt", ...(request.model ? ["--model", request.model] : [])];
  const recorder = createSdkRunRecorder("opencode", command, args, request);
  let opencode: OpenCodeInstance | undefined;
  let sessionId: string | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    const promptModel = openCodeModel(request.model);
    const serverOptions: ServerOptions = {
      signal: recorder.signal,
      timeout: Math.min(request.timeoutMs, serverTimeoutMs)
    };

    if (request.model && !promptModel) {
      serverOptions.config = { model: request.model };
    }

    opencode = await withProcessEnv(request.env, () => sdk.createOpencode(serverOptions));

    const abort = () => {
      if (!sessionId) {
        return;
      }

      void opencode?.client.session
        .abort({
          path: { id: sessionId },
          query: { directory: request.cwd }
        })
        .catch(() => undefined);
    };

    recorder.signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => recorder.signal.removeEventListener("abort", abort);

    const session = dataOrThrow<SessionCreateResponse>(
      await opencode.client.session.create({
        query: { directory: request.cwd },
        body: { title: "Harness run" }
      }),
      "OpenCode session creation"
    );
    sessionId = session.id;

    const body = {
      ...(promptModel ? { model: promptModel } : {}),
      parts: [{ type: "text" as const, text: request.prompt }]
    };
    const response = dataOrThrow<SessionPromptResponse>(
      await opencode.client.session.prompt({
        path: { id: sessionId },
        query: { directory: request.cwd },
        body
      }),
      "OpenCode prompt"
    );
    const messageError = openCodeMessageError(response.info);

    recorder.emitRaw(response);

    if (messageError) {
      recorder.emitStderr(messageError);
    }

    recorder.recordText(openCodePartsText(response.parts));
    return recorder.result(messageError ? 1 : 0);
  } catch (error) {
    recorder.fail(error);
    return recorder.result(recorder.aborted || recorder.timedOut ? null : 1);
  } finally {
    removeAbortListener?.();
    opencode?.server.close();
    recorder.close();
  }
}

function openCodeModel(model: string | undefined): OpenCodeModel | undefined {
  if (!model) {
    return undefined;
  }

  const separator = model.includes("/") ? "/" : model.includes(":") ? ":" : undefined;

  if (!separator) {
    return undefined;
  }

  const [providerID, ...modelParts] = model.split(separator);
  const modelID = modelParts.join(separator);

  return providerID && modelID ? { providerID, modelID } : undefined;
}

function openCodePartsText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function openCodeMessageError(info: unknown): string {
  const record = asRecord(info);
  const error = record ? asRecord(record.error) : undefined;

  if (typeof error?.message === "string") {
    return error.message;
  }

  return typeof record?.error === "string" ? record.error : "";
}

function dataOrThrow<T>(result: { data?: T; error?: unknown }, action: string): T {
  if (result.data !== undefined) {
    return result.data;
  }

  throw new Error(`${action} failed: ${formatError(result.error)}`);
}

async function withProcessEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const values = envForSdk(env);
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function formatError(value: unknown): string {
  if (!value) {
    return "unknown error";
  }

  if (value instanceof Error) {
    return value.message;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
