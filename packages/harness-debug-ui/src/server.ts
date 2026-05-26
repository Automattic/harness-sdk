import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHarnessClient,
  HarnessSdkError,
  type HarnessEvent,
  type HarnessRunResult,
  type ProviderSelector
} from "harness-app-sdk";

interface DetectPayload {
  envText?: unknown;
}

interface RunPayload {
  provider?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  model?: unknown;
  argsText?: unknown;
  envText?: unknown;
  timeoutMs?: unknown;
  allowEdits?: unknown;
  stream?: unknown;
}

interface DebugMeta {
  cwd: string;
  node: string;
  pid: number;
  sdkVersion: string;
}

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT || 4211);
const defaultCwd = resolve(process.env.INIT_CWD || process.cwd());
const sdkVersion = readSdkVersion();
const providers = new Set<ProviderSelector>(["auto", "claude", "codex", "copilot", "gemini", "wp-studio"]);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, { error: serializeError(error) });
    } else {
      response.end();
    }
  }
});

server.listen(port, () => {
  console.log(`Harness Debug UI running at http://localhost:${port}`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/meta") {
    sendJson(response, 200, meta());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/detect") {
    const payload = (await readJson(request)) as DetectPayload;
    const client = createHarnessClient({ env: parseEnvText(payload.envText) });
    sendJson(response, 200, { statuses: await client.detect(), meta: meta() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/run") {
    const payload = (await readJson(request)) as RunPayload;
    await streamRun(payload, request, response);
    return;
  }

  sendJson(response, 404, { error: { message: "Not found" } });
}

async function streamRun(
  payload: RunPayload,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const controller = new AbortController();
  let completed = false;

  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-accel-buffering": "no"
  });

  response.on("close", () => {
    if (!completed) {
      controller.abort();
    }
  });

  request.on("aborted", () => {
    if (!completed) {
      controller.abort();
    }
  });

  const cwd = readString(payload.cwd, defaultCwd);
  const env = parseEnvText(payload.envText);
  const client = createHarnessClient({ cwd, env });

  try {
    const prompt = readString(payload.prompt, "").trim();

    if (!prompt) {
      throw new HarnessSdkError("INVALID_REQUEST", "Prompt is required.");
    }

    const args = parseArgsText(readString(payload.argsText, ""));
    const timeoutMs = readNumber(payload.timeoutMs, 120_000);
    const provider = readProvider(payload.provider);
    const model = readOptionalString(payload.model);
    const allowEdits = payload.allowEdits === true;
    const stream = payload.stream !== false;

    writeNdjson(response, {
      kind: "request",
      request: {
        provider,
        cwd,
        model,
        args,
        timeoutMs,
        allowEdits,
        stream
      },
      meta: meta()
    });

    const result = await client.run({
      provider,
      prompt,
      cwd,
      env,
      model,
      args,
      timeoutMs,
      allowEdits,
      stream,
      signal: controller.signal,
      onEvent(event) {
        writeNdjson(response, { kind: "event", event: serializeEvent(event) });
      }
    });

    completed = true;
    writeNdjson(response, { kind: "result", result: serializeResult(result) });
    response.end();
  } catch (error) {
    completed = true;
    writeNdjson(response, {
      kind: "error",
      error: serializeError(error)
    });
    response.end();
  }
}

function meta(): DebugMeta {
  return {
    cwd: defaultCwd,
    node: process.version,
    pid: process.pid,
    sdkVersion
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function writeNdjson(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body) as unknown;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");

      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function readProvider(value: unknown): ProviderSelector {
  return typeof value === "string" && providers.has(value as ProviderSelector)
    ? (value as ProviderSelector)
    : "auto";
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function parseEnvText(value: unknown): NodeJS.ProcessEnv {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  const env: NodeJS.ProcessEnv = {};

  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const equals = line.indexOf("=");

    if (equals <= 0) {
      continue;
    }

    env[line.slice(0, equals).trim()] = line.slice(equals + 1);
  }

  return env;
}

function parseArgsText(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;

  for (const character of value) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }

      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (quote) {
    throw new Error(`Unclosed ${quote} quote in extra args.`);
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function serializeEvent(event: HarnessEvent): Record<string, unknown> {
  return {
    ...event,
    error: event.error ? serializeError(event.error) : undefined
  };
}

function serializeResult(result: HarnessRunResult): Record<string, unknown> {
  return {
    ...result
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof HarnessSdkError) {
    return {
      name: error.name,
      code: error.code,
      provider: error.provider,
      message: error.message,
      statuses: error.statuses
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function readSdkVersion(): string {
  try {
    const entry = fileURLToPath(import.meta.resolve("harness-app-sdk"));
    const packageJsonPath = resolve(dirname(entry), "../package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    try {
      const entry = require.resolve("harness-app-sdk");
      const packageJsonPath = resolve(dirname(entry), "../package.json");
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
      return packageJson.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Harness Debug UI</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #15130f;
      --panel: #201d17;
      --panel-2: #2a261f;
      --line: #4b4234;
      --text: #f5eedf;
      --muted: #b9ad99;
      --dim: #7e725f;
      --green: #84d39b;
      --amber: #ffb84d;
      --orange: #f26d3d;
      --red: #ff6b64;
      --blue: #7bb7ff;
      --black: #090806;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(rgba(255, 255, 255, 0.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
        radial-gradient(circle at 20% 0%, rgba(242, 109, 61, 0.12), transparent 34%),
        var(--bg);
      background-size: 28px 28px, 28px 28px, auto, auto;
      color: var(--text);
      font-family: "Avenir Next", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: rgba(21, 19, 15, 0.92);
      backdrop-filter: blur(12px);
    }

    h1 {
      margin: 0;
      font-size: 24px;
      line-height: 1;
      letter-spacing: 0;
    }

    .subtitle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 5px;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      background: rgba(255, 255, 255, 0.03);
    }

    .layout {
      min-height: 0;
      display: grid;
      grid-template-columns: 360px minmax(0, 1fr) 420px;
    }

    aside,
    main,
    .inspector {
      min-height: 0;
      overflow: hidden;
    }

    aside {
      border-right: 1px solid var(--line);
      background: rgba(32, 29, 23, 0.92);
      overflow-y: auto;
      padding: 18px;
    }

    main {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      background: rgba(15, 14, 11, 0.4);
    }

    .inspector {
      border-left: 1px solid var(--line);
      background: rgba(32, 29, 23, 0.76);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) minmax(180px, 32vh);
    }

    .section {
      margin-bottom: 18px;
    }

    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 9px;
      color: var(--amber);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 10px;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #14120e;
      color: var(--text);
      outline: none;
      padding: 10px 11px;
    }

    textarea {
      min-height: 92px;
      resize: vertical;
      line-height: 1.45;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--amber);
      box-shadow: 0 0 0 3px rgba(255, 184, 77, 0.15);
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .switches {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.025);
    }

    .switch input {
      width: auto;
      accent-color: var(--amber);
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 9px;
      position: sticky;
      bottom: 0;
      padding-top: 10px;
      background: linear-gradient(transparent, rgba(32, 29, 23, 0.98) 20%);
    }

    button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      cursor: pointer;
      font-weight: 800;
    }

    button.primary {
      border-color: var(--orange);
      background: var(--orange);
      color: var(--black);
    }

    button.danger {
      border-color: var(--red);
      color: var(--red);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }

    .statuses {
      display: grid;
      gap: 8px;
    }

    .status-row {
      display: grid;
      grid-template-columns: 74px 1fr;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px;
      background: rgba(255, 255, 255, 0.025);
    }

    .status-row strong {
      color: var(--text);
      font-size: 13px;
    }

    .status-row span {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .light {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-top: 3px;
      background: var(--dim);
      box-shadow: 0 0 0 4px rgba(126, 114, 95, 0.12);
    }

    .light.ok {
      background: var(--green);
      box-shadow: 0 0 0 4px rgba(132, 211, 155, 0.14);
    }

    .light.warn {
      background: var(--amber);
      box-shadow: 0 0 0 4px rgba(255, 184, 77, 0.16);
    }

    .transcript {
      min-height: 0;
      overflow-y: auto;
      padding: 24px;
      display: grid;
      align-content: start;
      gap: 14px;
    }

    .message {
      display: grid;
      grid-template-columns: 42px minmax(0, 720px);
      gap: 10px;
      align-items: end;
    }

    .message.user {
      grid-template-columns: minmax(0, 720px) 42px;
      justify-content: end;
    }

    .avatar {
      width: 42px;
      height: 42px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--panel-2);
      color: var(--amber);
      font-size: 12px;
      font-weight: 900;
    }

    .bubble {
      border: 1px solid var(--line);
      border-radius: 12px 12px 12px 4px;
      padding: 13px 14px;
      background: rgba(245, 238, 223, 0.055);
      color: var(--text);
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .user .bubble {
      border-color: rgba(255, 184, 77, 0.42);
      border-radius: 12px 12px 4px 12px;
      background: rgba(255, 184, 77, 0.12);
    }

    .message.error .bubble {
      border-color: var(--red);
      background: rgba(255, 107, 100, 0.1);
    }

    .composer {
      border-top: 1px solid var(--line);
      padding: 14px;
      background: rgba(21, 19, 15, 0.95);
    }

    .composer textarea {
      min-height: 98px;
    }

    .inspector-head {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 10px;
    }

    .meters {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .meter {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.025);
    }

    .meter b {
      display: block;
      color: var(--text);
      font-size: 18px;
    }

    .meter span {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .events {
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      display: grid;
      align-content: start;
      gap: 8px;
      font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
      font-size: 12px;
    }

    .event {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.16);
      overflow: hidden;
    }

    .event button {
      width: 100%;
      min-height: 0;
      border: 0;
      border-radius: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px;
      background: transparent;
      color: var(--text);
      text-align: left;
      font-family: inherit;
      font-size: 12px;
    }

    .event pre {
      display: none;
      margin: 0;
      padding: 8px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .event.open pre {
      display: block;
    }

    .tag {
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 11px;
    }

    .tag.chunk {
      color: var(--green);
    }

    .tag.stderr,
    .tag.error {
      color: var(--red);
    }

    .tag.stdout,
    .tag.raw {
      color: var(--blue);
    }

    .result {
      min-height: 0;
      border-top: 1px solid var(--line);
      overflow-y: auto;
      padding: 10px;
    }

    .result pre {
      margin: 0;
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
      font-size: 12px;
    }

    @media (max-width: 1180px) {
      .layout {
        grid-template-columns: 330px minmax(0, 1fr);
      }

      .inspector {
        grid-column: 1 / -1;
        border-left: 0;
        border-top: 1px solid var(--line);
        min-height: 420px;
      }
    }

    @media (max-width: 760px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }

      .layout {
        grid-template-columns: 1fr;
      }

      aside {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .row,
      .switches,
      .actions,
      .meters {
        grid-template-columns: 1fr;
      }

      .message,
      .message.user {
        grid-template-columns: 36px minmax(0, 1fr);
      }

      .message.user {
        direction: rtl;
      }

      .message.user .bubble {
        direction: ltr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div>
        <h1>Harness Debug UI</h1>
        <div class="subtitle">Provider adapter bench for local accounts and streaming events</div>
      </div>
      <div class="meta">
        <span class="pill" id="sdk-version">sdk</span>
        <span class="pill" id="node-version">node</span>
        <span class="pill" id="pid">pid</span>
      </div>
    </header>

    <div class="layout">
      <aside>
        <div class="section">
          <div class="section-title">Provider</div>
          <label>
            Target
            <select id="provider">
              <option value="auto">auto</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="copilot">copilot</option>
              <option value="gemini">gemini</option>
              <option value="wp-studio">wp-studio</option>
            </select>
          </label>
          <div class="statuses" id="statuses"></div>
        </div>

        <div class="section">
          <div class="section-title">Run Controls</div>
          <label>
            Working directory
            <input id="cwd" spellcheck="false">
          </label>
          <div class="row">
            <label>
              Model
              <input id="model" placeholder="provider default" spellcheck="false">
            </label>
            <label>
              Timeout ms
              <input id="timeout" type="number" min="1000" step="1000" value="120000">
            </label>
          </div>
          <label>
            Extra args
            <input id="args" placeholder="--flag value --quoted 'two words'" spellcheck="false">
          </label>
          <label>
            Env overrides
            <textarea id="env" spellcheck="false" placeholder="KEY=value"></textarea>
          </label>
          <div class="switches">
            <label class="switch">
              <span>Stream</span>
              <input id="stream" type="checkbox" checked>
            </label>
            <label class="switch">
              <span>Allow edits</span>
              <input id="allow-edits" type="checkbox">
            </label>
          </div>
        </div>

        <div class="actions">
          <button id="detect">Detect</button>
          <button id="clear">Clear</button>
          <button id="run" class="primary">Run</button>
          <button id="abort" class="danger" disabled>Abort</button>
        </div>
      </aside>

      <main>
        <section class="transcript" id="transcript" aria-live="polite">
          <div class="message">
            <div class="avatar">HK</div>
            <div class="bubble">Ready. Pick a provider, tune the request, and inspect every SDK event as it streams.</div>
          </div>
        </section>
        <div class="composer">
          <label>
            Prompt
            <textarea id="prompt" spellcheck="true">Reply with exactly HELLO.</textarea>
          </label>
        </div>
      </main>

      <section class="inspector">
        <div class="inspector-head">
          <div class="section-title">Inspector</div>
          <div class="meters">
            <div class="meter"><b id="event-count">0</b><span>events</span></div>
            <div class="meter"><b id="chunk-count">0</b><span>chunks</span></div>
            <div class="meter"><b id="stdout-count">0</b><span>stdout</span></div>
            <div class="meter"><b id="stderr-count">0</b><span>stderr</span></div>
          </div>
        </div>
        <div class="events" id="events"></div>
        <div class="result">
          <div class="section-title">Final Result</div>
          <pre id="result">{}</pre>
        </div>
      </section>
    </div>
  </div>

  <script>
    const $ = (selector) => document.querySelector(selector);
    const controls = {
      provider: $("#provider"),
      cwd: $("#cwd"),
      model: $("#model"),
      timeout: $("#timeout"),
      args: $("#args"),
      env: $("#env"),
      stream: $("#stream"),
      allowEdits: $("#allow-edits"),
      prompt: $("#prompt"),
      detect: $("#detect"),
      run: $("#run"),
      abort: $("#abort"),
      clear: $("#clear")
    };
    const transcript = $("#transcript");
    const statuses = $("#statuses");
    const events = $("#events");
    const resultPanel = $("#result");
    const counters = {
      events: $("#event-count"),
      chunks: $("#chunk-count"),
      stdout: $("#stdout-count"),
      stderr: $("#stderr-count")
    };
    let abortController;
    let activeBubble;
    let counts = { events: 0, chunks: 0, stdout: 0, stderr: 0 };

    controls.detect.addEventListener("click", detectProviders);
    controls.run.addEventListener("click", runHarness);
    controls.abort.addEventListener("click", abortRun);
    controls.clear.addEventListener("click", clearWorkbench);

    boot();

    async function boot() {
      const meta = await fetchJson("/api/meta");
      $("#sdk-version").textContent = "sdk " + meta.sdkVersion;
      $("#node-version").textContent = meta.node;
      $("#pid").textContent = "pid " + meta.pid;
      controls.cwd.value = meta.cwd;
      await detectProviders();
    }

    async function detectProviders() {
      controls.detect.disabled = true;
      statuses.innerHTML = "";

      try {
        const data = await fetchJson("/api/detect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ envText: controls.env.value })
        });

        for (const status of data.statuses) {
          statuses.append(statusRow(status));
        }
      } catch (error) {
        statuses.append(statusRow({ id: "error", available: false, message: error.message }));
      } finally {
        controls.detect.disabled = false;
      }
    }

    async function runHarness() {
      const prompt = controls.prompt.value.trim();

      if (!prompt) {
        controls.prompt.focus();
        return;
      }

      setRunning(true);
      activeBubble = null;
      appendMessage("user", "You", prompt);
      const assistant = appendMessage("assistant", "HK", "");
      activeBubble = assistant.bubble;
      resultPanel.textContent = "{}";

      abortController = new AbortController();

      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: controls.provider.value,
            prompt,
            cwd: controls.cwd.value,
            model: controls.model.value,
            timeoutMs: controls.timeout.value,
            argsText: controls.args.value,
            envText: controls.env.value,
            stream: controls.stream.checked,
            allowEdits: controls.allowEdits.checked
          }),
          signal: abortController.signal
        });

        await readNdjson(response, handleStreamMessage);
      } catch (error) {
        if (error.name !== "AbortError") {
          assistant.message.classList.add("error");
          activeBubble.textContent += activeBubble.textContent ? "\\n" + error.message : error.message;
        }
      } finally {
        activeBubble = null;
        abortController = undefined;
        setRunning(false);
      }
    }

    function abortRun() {
      if (abortController) {
        abortController.abort();
      }
    }

    function clearWorkbench() {
      transcript.innerHTML = "";
      events.innerHTML = "";
      resultPanel.textContent = "{}";
      counts = { events: 0, chunks: 0, stdout: 0, stderr: 0 };
      updateCounters();
      appendMessage("assistant", "HK", "Cleared.");
    }

    function handleStreamMessage(message) {
      if (message.kind === "request") {
        appendEvent("request", message.request);
        return;
      }

      if (message.kind === "event") {
        const event = message.event;
        appendEvent(event.type, event);

        if (event.type === "chunk" && event.text && activeBubble) {
          activeBubble.textContent += event.text;
          counts.chunks += 1;
          transcript.scrollTop = transcript.scrollHeight;
        }

        if (event.type === "stdout") {
          counts.stdout += 1;
        }

        if (event.type === "stderr") {
          counts.stderr += 1;
        }

        counts.events += 1;
        updateCounters();
        return;
      }

      if (message.kind === "result") {
        resultPanel.textContent = formatJson(message.result);

        if (activeBubble && !activeBubble.textContent && message.result.text) {
          activeBubble.textContent = message.result.text;
        }

        appendEvent("result", message.result);
        return;
      }

      if (message.kind === "error") {
        resultPanel.textContent = formatJson(message.error);

        if (activeBubble) {
          activeBubble.parentElement.classList.add("error");
          activeBubble.textContent += activeBubble.textContent
            ? "\\n" + message.error.message
            : message.error.message;
        }

        appendEvent("error", message.error);
      }
    }

    async function readNdjson(response, onMessage) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const next = await reader.read();

        if (next.done) {
          break;
        }

        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split(/\\r?\\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            onMessage(JSON.parse(line));
          }
        }
      }

      if (buffer.trim()) {
        onMessage(JSON.parse(buffer));
      }
    }

    function appendMessage(role, initials, text) {
      const message = document.createElement("div");
      message.className = "message " + (role === "user" ? "user" : "");

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials;

      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;

      if (role === "user") {
        message.append(bubble, avatar);
      } else {
        message.append(avatar, bubble);
      }

      transcript.append(message);
      transcript.scrollTop = transcript.scrollHeight;
      return { message, bubble };
    }

    function appendEvent(type, payload) {
      const row = document.createElement("div");
      row.className = "event";

      const button = document.createElement("button");
      const label = document.createElement("span");
      const tag = document.createElement("span");
      const pre = document.createElement("pre");

      label.textContent = eventSummary(type, payload);
      tag.className = "tag " + type;
      tag.textContent = type;
      pre.textContent = formatJson(payload);
      button.append(label, tag);
      button.addEventListener("click", () => row.classList.toggle("open"));
      row.append(button, pre);
      events.prepend(row);

      while (events.children.length > 500) {
        events.lastElementChild.remove();
      }
    }

    function eventSummary(type, payload) {
      if (type === "chunk") {
        return clip(payload.text || payload.data || "", 84);
      }

      if (type === "stdout" || type === "stderr") {
        return clip(payload.data || "", 84);
      }

      if (type === "start") {
        return (payload.command || "") + " " + (payload.args || []).join(" ");
      }

      if (type === "exit") {
        return "exit " + payload.exitCode;
      }

      if (type === "error") {
        return payload.message || "error";
      }

      if (type === "result") {
        return "provider " + payload.provider + " in " + payload.durationMs + "ms";
      }

      return payload.provider || payload.kind || type;
    }

    function statusRow(status) {
      const row = document.createElement("div");
      row.className = "status-row";
      const light = document.createElement("div");
      light.className = "light " + (status.available ? (status.authenticated === false ? "warn" : "ok") : "");
      const body = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = status.id || status.name || "provider";
      detail.textContent = status.message || status.version || (status.available ? "available" : "missing");
      body.append(title, document.createElement("br"), detail);
      row.append(light, body);
      return row;
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error?.message || "Request failed");
      }

      return body;
    }

    function setRunning(value) {
      controls.run.disabled = value;
      controls.abort.disabled = !value;
      controls.detect.disabled = value;
    }

    function updateCounters() {
      counters.events.textContent = String(counts.events);
      counters.chunks.textContent = String(counts.chunks);
      counters.stdout.textContent = String(counts.stdout);
      counters.stderr.textContent = String(counts.stderr);
    }

    function formatJson(value) {
      return JSON.stringify(value, null, 2);
    }

    function clip(value, length) {
      const text = String(value).replace(/\\s+/g, " ").trim();
      return text.length > length ? text.slice(0, length - 1) + "..." : text;
    }
  </script>
</body>
</html>`;
}
