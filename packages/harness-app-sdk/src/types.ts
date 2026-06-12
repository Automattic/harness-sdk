export type ProviderId =
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "wp-studio";

export type ProviderSelector = ProviderId | "auto";

export interface HarnessClientOptions {
  cwd?: string;
  defaultProvider?: ProviderSelector;
  env?: NodeJS.ProcessEnv;
  providers?: ProviderAdapter[];
  runner?: CommandRunner;
  timeoutMs?: number;
  onEvent?: (event: HarnessEvent) => void;
}

export interface HarnessRunRequest {
  prompt: string;
  provider?: ProviderSelector;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  args?: string[];
  timeoutMs?: number;
  allowEdits?: boolean;
  stream?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
}

export interface HarnessRunResult {
  provider: ProviderId;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  text: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  command: string;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  message?: string;
}

export interface HarnessEvent {
  type: "start" | "chunk" | "stdout" | "stderr" | "raw" | "exit" | "error";
  provider?: ProviderId;
  command?: string;
  args?: string[];
  data?: string;
  text?: string;
  raw?: unknown;
  exitCode?: number | null;
  error?: Error | NodeJS.ErrnoException;
  message?: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  name: string;
  command: string;
  detect(): Promise<ProviderStatus>;
  run(request: ResolvedHarnessRunRequest): Promise<HarnessRunResult>;
}

export interface ResolvedHarnessRunRequest extends HarnessRunRequest {
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  onEvent?: (event: HarnessEvent) => void;
}

export interface CommandRunnerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  error?: NodeJS.ErrnoException;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunnerOptions
) => Promise<CommandResult>;
