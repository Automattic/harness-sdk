import { redactSecrets } from "../process.js";
import { extractProviderText } from "../streaming.js";
import type { HarnessEvent, HarnessRunResult, ProviderId, ResolvedHarnessRunRequest } from "../types.js";

export interface SdkRunRecorder {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  emitRaw(raw: unknown): void;
  emitChunk(text: string, raw?: unknown): void;
  emitStdout(data: string): void;
  emitStderr(data: string): void;
  recordText(text: string): void;
  fail(error: unknown): void;
  result(exitCode?: number | null): HarnessRunResult;
  close(): void;
}

export function createSdkRunRecorder(
  provider: ProviderId,
  command: string,
  args: string[],
  request: ResolvedHarnessRunRequest
): SdkRunRecorder {
  const startedAt = Date.now();
  const controller = new AbortController();
  const onEvent = request.onEvent;
  let stdout = "";
  let stderr = "";
  let text = "";
  let emittedText = false;
  let timedOut = false;
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;

  const onAbort = () => {
    aborted = true;
    controller.abort();
  };

  if (request.signal?.aborted) {
    onAbort();
  } else {
    request.signal?.addEventListener("abort", onAbort, { once: true });
  }

  if (request.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
  }

  emit(onEvent, { type: "start", provider, command, args });

  const recorder: SdkRunRecorder = {
    get signal() {
      return controller.signal;
    },
    get aborted() {
      return aborted || request.signal?.aborted === true;
    },
    get timedOut() {
      return timedOut;
    },
    emitRaw(raw) {
      const data = serializeRaw(raw);
      emit(onEvent, { type: "raw", provider, data, raw });

      const chunk = extractProviderText(provider, raw, emittedText);

      if (chunk) {
        recorder.emitChunk(chunk, raw);
      }
    },
    emitChunk(chunk, raw) {
      const redacted = redactSecrets(chunk);
      text += redacted;
      emittedText = true;
      emit(onEvent, { type: "chunk", provider, data: redacted, text: redacted, raw });
    },
    emitStdout(data) {
      const redacted = redactSecrets(data);
      stdout += redacted;
      emit(onEvent, { type: "stdout", provider, data: redacted });
    },
    emitStderr(data) {
      const redacted = redactSecrets(data);
      stderr += redacted;
      emit(onEvent, { type: "stderr", provider, data: redacted });
    },
    recordText(value) {
      const redacted = redactSecrets(value);

      if (!text) {
        text = redacted;
      }

      if (!stdout) {
        stdout = redacted;
      }
    },
    fail(error) {
      const message = errorMessage(error);
      stderr += stderr ? `\n${message}` : message;
      emit(onEvent, {
        type: "error",
        provider,
        command,
        args,
        error: error instanceof Error ? error : undefined,
        message
      });
    },
    result(exitCode = 0) {
      emit(onEvent, { type: "exit", provider, command, args, exitCode });

      return {
        provider,
        command,
        args,
        cwd: request.cwd,
        exitCode,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        text: text.trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted: recorder.aborted
      };
    },
    close() {
      if (timer) {
        clearTimeout(timer);
      }

      request.signal?.removeEventListener("abort", onAbort);
    }
  };

  return recorder;
}

export function envForSdk(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

export function shouldUseCli(options: { command?: string; runner?: unknown }, request?: ResolvedHarnessRunRequest): boolean {
  return Boolean(options.command || options.runner || request?.args?.length);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializeRaw(raw: unknown): string {
  try {
    return redactSecrets(JSON.stringify(raw));
  } catch {
    return redactSecrets(String(raw));
  }
}

function emit(onEvent: ((event: HarnessEvent) => void) | undefined, event: HarnessEvent): void {
  onEvent?.(event);
}
