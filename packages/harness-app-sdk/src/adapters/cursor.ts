import { Agent, Cursor, type Run, type SDKMessage } from "@cursor/sdk";
import type { ProviderAdapter, ProviderStatus, ResolvedHarnessRunRequest } from "../types.js";
import { createSdkRunRecorder } from "./sdk-shared.js";

interface CursorSdk {
  Agent: typeof Agent;
  Cursor: typeof Cursor;
}

type CursorAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  sdk?: CursorSdk;
};

const DEFAULT_CURSOR_MODEL = "composer-2";

export function createCursorAdapter(options: CursorAdapterOptions = {}): ProviderAdapter {
  const env = options.env ?? {};
  const sdk = options.sdk ?? { Agent, Cursor };

  return {
    id: "cursor",
    name: "Cursor",
    command: "@cursor/sdk",
    async detect(): Promise<ProviderStatus> {
      const apiKey = cursorApiKey(env);

      if (!apiKey) {
        return {
          id: "cursor",
          name: "Cursor",
          command: "@cursor/sdk",
          available: true,
          authenticated: false,
          message: "Cursor SDK requires CURSOR_API_KEY."
        };
      }

      try {
        const user = await sdk.Cursor.me({ apiKey });

        return {
          id: "cursor",
          name: "Cursor",
          command: "@cursor/sdk",
          available: true,
          authenticated: true,
          message: user.userEmail ? `Authenticated as ${user.userEmail}.` : undefined
        };
      } catch (error) {
        return {
          id: "cursor",
          name: "Cursor",
          command: "@cursor/sdk",
          available: true,
          authenticated: false,
          message: error instanceof Error ? error.message : "Cursor SDK authentication failed."
        };
      }
    },
    async run(request: ResolvedHarnessRunRequest) {
      return await runCursorSdk(sdk, request, env);
    }
  };
}

async function runCursorSdk(
  sdk: CursorSdk,
  request: ResolvedHarnessRunRequest,
  adapterEnv: NodeJS.ProcessEnv
) {
  const model = request.model ?? DEFAULT_CURSOR_MODEL;
  const command = "@cursor/sdk";
  const args = ["send", "--model", model, "--mode", request.allowEdits ? "agent" : "plan"];
  const recorder = createSdkRunRecorder("cursor", command, args, request);
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let run: Run | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    const apiKey = cursorApiKey({ ...adapterEnv, ...request.env });

    if (!apiKey) {
      throw new Error("Cursor SDK requires CURSOR_API_KEY.");
    }

    agent = await sdk.Agent.create({
      apiKey,
      local: { cwd: request.cwd },
      mode: request.allowEdits ? "agent" : "plan",
      model: { id: model }
    });

    const abort = () => {
      void run?.cancel().catch(() => undefined);
    };

    recorder.signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => recorder.signal.removeEventListener("abort", abort);

    run = await agent.send(request.prompt, {
      mode: request.allowEdits ? "agent" : "plan",
      model: { id: model }
    });

    if (request.stream && run.supports("stream")) {
      for await (const message of run.stream() as AsyncGenerator<SDKMessage>) {
        recorder.emitRaw(message);
      }
    }

    const result = await run.wait();

    if (result.result) {
      recorder.recordText(result.result);
    }

    return recorder.result(result.status === "finished" ? 0 : 1);
  } catch (error) {
    recorder.fail(error);
    return recorder.result(recorder.aborted || recorder.timedOut ? null : 1);
  } finally {
    removeAbortListener?.();
    try {
      agent?.close();
    } catch {
      // Best-effort cleanup only.
    }
    recorder.close();
  }
}

function cursorApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
}
