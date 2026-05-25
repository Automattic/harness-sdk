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
  runner: CommandRunner
): Promise<HarnessRunResult> {
  const onEvent = request.onEvent;

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
    onStdout: (data) => emit(onEvent, { type: "stdout", provider, data }),
    onStderr: (data) => emit(onEvent, { type: "stderr", provider, data })
  });

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
    text: commandText(result),
    durationMs: result.durationMs,
    timedOut: result.timedOut
  };
}

function emit(onEvent: ((event: HarnessEvent) => void) | undefined, event: HarnessEvent): void {
  onEvent?.(event);
}
