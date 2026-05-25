import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner, CommandRunnerOptions } from "./types.js";

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b([A-Za-z0-9_]*API_KEY[A-Za-z0-9_]*=)[^\s]+/gi,
  /\b([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix) => {
      return typeof prefix === "string" && prefix.endsWith("=") ? `${prefix}[redacted]` : "[redacted]";
    }),
    value
  );
}

export const runCommand: CommandRunner = async (
  command: string,
  args: string[],
  options: CommandRunnerOptions
): Promise<CommandResult> => {
  const startedAt = Date.now();

  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const finish = (result: Partial<CommandResult>) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      if (onAbort) {
        options.signal?.removeEventListener("abort", onAbort);
      }

      resolve({
        command,
        args,
        cwd: options.cwd,
        exitCode: result.exitCode ?? null,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        error: result.error
      });
    };

    onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = redactSecrets(chunk.toString());
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = redactSecrets(chunk.toString());
      stderr += text;
      options.onStderr?.(text);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, error });
    });

    child.once("close", (exitCode) => {
      finish({ exitCode });
    });
  });
};

export function commandText(result: Pick<CommandResult, "stdout" | "stderr">): string {
  return result.stdout.trim() || result.stderr.trim();
}
