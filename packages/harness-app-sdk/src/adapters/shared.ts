import type {
  CommandResult,
  CommandRunner,
  HarnessEvent,
  HarnessRunResult,
  ProviderId,
  ProviderStatus,
  ResolvedHarnessRunRequest
} from "../types.js";
import { commandText } from "../process.js";
import { createTextStreamParser, type StreamParser } from "../streaming.js";

export interface AdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

export async function detectVersion(
  id: ProviderId,
  name: string,
  command: string,
  runner: CommandRunner,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<ProviderStatus & { versionResult: CommandResult }> {
  const versionResult = await runner(command, ["--version"], {
    cwd,
    env,
    timeoutMs: 5_000
  });

  if (versionResult.error?.code === "ENOENT" || versionResult.exitCode === null) {
    return {
      id,
      name,
      command,
      available: false,
      authenticated: false,
      message: `${name} is not installed or is not available on PATH.`,
      versionResult
    };
  }

  if (versionResult.exitCode !== 0) {
    return {
      id,
      name,
      command,
      available: false,
      authenticated: false,
      message: `${name} did not respond to ${command} --version.`,
      versionResult
    };
  }

  return {
    id,
    name,
    command,
    available: true,
    authenticated: null,
    version: commandText(versionResult),
    versionResult
  };
}

export async function runProviderCommand(
  provider: ProviderId,
  command: string,
  args: string[],
  request: ResolvedHarnessRunRequest,
  runner: CommandRunner,
  streamParser: StreamParser = createTextStreamParser(provider)
): Promise<HarnessRunResult> {
  const onEvent = request.onEvent;
  const parser = request.stream ? streamParser : undefined;

  emit(onEvent, {
    type: "start",
    provider,
    command,
    args
  });

  const result = await runner(command, args, {
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    onStdout: (data) => {
      emit(onEvent, { type: "stdout", provider, data });
      parser?.onStdout(data, (event) => emit(onEvent, event));
    },
    onStderr: (data) => emit(onEvent, { type: "stderr", provider, data })
  });

  parser?.flush((event) => emit(onEvent, event));

  if (result.error) {
    emit(onEvent, {
      type: "error",
      provider,
      command,
      args,
      error: result.error,
      message: result.error.message
    });
  }

  emit(onEvent, {
    type: "exit",
    provider,
    command,
    args,
    exitCode: result.exitCode
  });

  return {
    provider,
    command,
    args,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    text: parser?.text() || commandText(result),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted
  };
}

function emit(onEvent: ((event: HarnessEvent) => void) | undefined, event: HarnessEvent): void {
  onEvent?.(event);
}
