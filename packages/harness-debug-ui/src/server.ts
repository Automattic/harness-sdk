import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHarnessClient,
  HarnessSdkError,
  type HarnessEvent,
  type ProviderId,
  type HarnessRunResult,
  type ProviderSelector
} from "harness-app-sdk";

interface DetectPayload {
  envText?: unknown;
}

interface ModelsPayload {
  provider?: unknown;
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

interface ModelOption {
  value: string;
  label: string;
}

const require = createRequire(import.meta.url);
const sourceDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(sourceDir, "../../..");
const harnessIconUrl = "/assets/harness-sdk-icon.svg";
const harnessIconPath = resolve(workspaceRoot, "assets/harness-sdk-icon.svg");
const harnessMonoIconUrl = "/assets/harness-sdk-icon-mono.svg";
const harnessMonoIconPath = resolve(workspaceRoot, "assets/harness-sdk-icon-mono.svg");
const port = Number(process.env.PORT || 4211);
const defaultCwd = resolve(process.env.INIT_CWD || process.cwd());
const sdkVersion = readSdkVersion();
const providers = new Set<ProviderSelector>([
  "auto",
  "claude",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "opencode",
  "wp-studio"
]);
const defaultModelOption: ModelOption = { value: "", label: "Default model" };
const modelOptionsByProvider: Record<ProviderId, ModelOption[]> = {
  claude: [
    defaultModelOption,
    { value: "sonnet", label: "Claude Sonnet" },
    { value: "opus", label: "Claude Opus" },
    { value: "haiku", label: "Claude Haiku" },
    { value: "fable", label: "Claude Fable" }
  ],
  codex: [
    defaultModelOption,
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-codex", label: "GPT-5 Codex" }
  ],
  copilot: [
    defaultModelOption,
    { value: "gpt-5.1", label: "GPT-5.1" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" }
  ],
  cursor: [defaultModelOption, { value: "composer-2", label: "Composer 2" }],
  gemini: [
    defaultModelOption,
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" }
  ],
  opencode: [defaultModelOption],
  "wp-studio": [defaultModelOption]
};

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

  if (request.method === "GET" && (url.pathname === harnessIconUrl || url.pathname === harnessMonoIconUrl)) {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "image/svg+xml; charset=utf-8"
    });
    response.end(readFileSync(url.pathname === harnessMonoIconUrl ? harnessMonoIconPath : harnessIconPath));
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

  if (request.method === "POST" && url.pathname === "/api/models") {
    const payload = (await readJson(request)) as ModelsPayload;
    const env = parseEnvText(payload.envText);
    const provider = readProvider(payload.provider);
    const effectiveProvider = provider === "auto" ? await detectAutoProvider(env) : provider;
    sendJson(response, 200, {
      provider,
      effectiveProvider,
      models: modelOptionsForProvider(effectiveProvider),
      meta: meta()
    });
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

async function detectAutoProvider(env: NodeJS.ProcessEnv): Promise<ProviderSelector> {
  const client = createHarnessClient({ env });
  const statuses = await client.detect();
  return statuses.find((status) => status.available && status.authenticated !== false)?.id ?? "auto";
}

function modelOptionsForProvider(provider: ProviderSelector): ModelOption[] {
  if (provider === "auto") {
    return [defaultModelOption];
  }

  return modelOptionsByProvider[provider] ?? [defaultModelOption];
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
  <link rel="icon" type="image/svg+xml" href="${harnessMonoIconUrl}">
  <style>
    :root {
      color-scheme: dark;
      --bg: #111112;
      --canvas: #161617;
      --panel: #1c1c1e;
      --panel-2: #2c2c2e;
      --panel-3: #3a3a3c;
      --field: #1c1c1e;
      --line: #3a3a3c;
      --line-soft: #2c2c2e;
      --text: #f2f2f7;
      --muted: #aeaeb2;
      --faint: #7c7c80;
      --accent: #e5e5ea;
      --accent-strong: #f2f2f7;
      --green: #30d158;
      --amber: #ffd60a;
      --red: #ff453a;
      --blue: #64d2ff;
      --violet: #bf5af2;
      --black: #000000;
    }

    * {
      box-sizing: border-box;
    }

    html {
      height: 100%;
      overflow: hidden;
    }

    body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      font-size: 13px;
      letter-spacing: 0;
    }

    ::selection {
      background: rgba(242, 242, 247, 0.2);
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    .shell {
      height: 100dvh;
      display: grid;
      grid-template-rows: 52px minmax(0, 1fr);
      overflow: hidden;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-width: 0;
      padding: 0 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(17, 17, 18, 0.92);
      backdrop-filter: blur(16px);
    }

    .brand {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 10px;
    }

    .brand-mark {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      opacity: 0.92;
    }

    .brand-mark img {
      width: 22px;
      height: 22px;
      display: block;
    }

    h1 {
      margin: 0;
      color: var(--text);
      font-size: 14px;
      font-weight: 760;
      line-height: 1.1;
      letter-spacing: 0;
    }

    .subtitle {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.2;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
    }

    .pill {
      min-height: 26px;
      border: 1px solid var(--line);
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      padding: 0 8px;
      background: rgba(255, 255, 255, 0.024);
      white-space: nowrap;
    }

    .layout {
      min-height: 0;
      height: 100%;
      display: grid;
      grid-template-columns: 292px minmax(520px, 1fr) minmax(380px, 440px);
      overflow-x: auto;
      overflow-y: hidden;
    }

    aside,
    main,
    .inspector {
      min-height: 0;
      height: 100%;
      max-height: 100%;
      min-width: 0;
      overflow: hidden;
    }

    aside {
      border-right: 1px solid var(--line);
      background: rgba(28, 28, 30, 0.88);
      overflow-y: auto;
      padding: 16px 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    main {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      background: var(--canvas);
    }

    .inspector {
      border-left: 1px solid var(--line);
      background: rgba(17, 17, 18, 0.96);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) minmax(148px, 27%);
    }

    .section {
      min-width: 0;
    }

    .section + .section {
      border-top: 1px solid var(--line-soft);
      padding-top: 16px;
    }

    .section-title {
      margin: 0 0 8px;
      color: var(--faint);
      font-size: 10px;
      font-weight: 820;
      letter-spacing: 0.07em;
      line-height: 1.2;
      text-transform: uppercase;
    }

    .accounts-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .accounts-head .section-title {
      margin: 0;
    }

    .field,
    label {
      display: grid;
      gap: 6px;
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }

    .section > .field + .switches {
      margin-top: 10px;
    }

    input,
    select,
    textarea {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--field);
      color: var(--text);
      outline: none;
      padding: 8px 10px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
    }

    textarea {
      min-height: 84px;
      resize: vertical;
      line-height: 1.45;
    }

    input::placeholder,
    textarea::placeholder {
      color: var(--faint);
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: #5a5a5f;
      box-shadow: 0 0 0 3px rgba(242, 242, 247, 0.08);
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 9px;
    }

    .switches {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .switch {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.02);
    }

    .switch input {
      width: auto;
      min-height: 0;
      accent-color: var(--accent);
    }

    details {
      color: var(--muted);
    }

    summary {
      min-height: 30px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      cursor: pointer;
      list-style: none;
      color: var(--text);
      font-weight: 720;
    }

    summary::-webkit-details-marker {
      display: none;
    }

    summary::after {
      content: "+";
      color: var(--faint);
      font-weight: 760;
    }

    details[open] summary::after {
      content: "-";
    }

    .advanced-body {
      display: grid;
      gap: 10px;
      padding-top: 10px;
    }

    .accounts-body {
      display: grid;
      gap: 8px;
    }

    .actions {
      margin-top: auto;
      border-top: 1px solid var(--line-soft);
      padding-top: 14px;
      display: grid;
      gap: 8px;
    }

    button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      cursor: pointer;
      font-weight: 740;
      letter-spacing: 0;
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
    }

    button:hover:not(:disabled) {
      border-color: #3a4855;
      background: var(--panel-3);
    }

    button:active:not(:disabled) {
      transform: translateY(1px);
    }

    button.primary {
      border-color: var(--accent-strong);
      background: var(--accent);
      color: var(--black);
    }

    button.primary:hover:not(:disabled) {
      border-color: #ffffff;
      background: #ffffff;
    }

    button.danger {
      border-color: rgba(255, 116, 109, 0.62);
      color: var(--red);
      background: rgba(255, 116, 109, 0.07);
    }

    button.danger:hover:not(:disabled) {
      border-color: var(--red);
      background: rgba(255, 116, 109, 0.12);
    }

    button.quiet {
      min-height: 36px;
      padding: 0 10px;
      background: transparent;
    }

    button.icon-button {
      width: 28px;
      min-width: 28px;
      height: 28px;
      min-height: 28px;
      border: 0;
      border-radius: 7px;
      display: grid;
      place-items: center;
      padding: 0;
      background: transparent;
      color: var(--muted);
    }

    button.icon-button:hover:not(:disabled),
    button.icon-button:focus-visible {
      background: rgba(255, 255, 255, 0.075);
      color: var(--text);
    }

    button.icon-button svg {
      width: 15px;
      height: 15px;
      fill: currentColor;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }

    .statuses {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }

    .status-row {
      position: relative;
      min-width: 0;
      min-height: 0;
      aspect-ratio: 1;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      overflow: hidden;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      padding: 9px;
      background: rgba(255, 255, 255, 0.025);
      color: var(--text);
      text-align: left;
      font: inherit;
      cursor: pointer;
      box-shadow: none;
      transition:
        border-color 120ms ease,
        background 120ms ease,
        transform 120ms ease;
    }

    .status-row:hover:not(:disabled) {
      border-color: rgba(242, 242, 247, 0.22);
      background: rgba(255, 255, 255, 0.045);
    }

    .status-row:focus-visible {
      outline: none;
      border-color: rgba(242, 242, 247, 0.38);
      box-shadow: 0 0 0 3px rgba(242, 242, 247, 0.08);
    }

    .status-row.active {
      border-color: rgba(242, 242, 247, 0.5);
      background: rgba(242, 242, 247, 0.075);
    }

    .status-row.active::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 8px;
      box-shadow: inset 0 0 0 1px rgba(242, 242, 247, 0.16);
      pointer-events: none;
    }

    .status-row::after {
      content: "";
      position: absolute;
      inset: auto -28px -34px auto;
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.028);
      pointer-events: none;
    }

    .status-row.is-missing {
      color: var(--faint);
    }

    .status-head {
      position: relative;
      z-index: 1;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .provider-icon {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
    }

    .provider-icon img {
      width: 22px;
      height: 22px;
      object-fit: contain;
      filter: invert(1) brightness(0.92);
      opacity: 0.9;
    }

    .status-copy {
      position: relative;
      z-index: 1;
      min-width: 0;
      display: grid;
      gap: 4px;
    }

    .status-row strong {
      color: var(--text);
      font-size: 12px;
      font-weight: 760;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-row span {
      color: var(--muted);
      font-size: 10.5px;
      line-height: 1.35;
      overflow: hidden;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      line-clamp: 3;
    }

    .light {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      margin-top: 3px;
      background: var(--faint);
      box-shadow: 0 0 0 4px rgba(101, 113, 126, 0.1);
    }

    .light.ok {
      background: var(--green);
      box-shadow: 0 0 0 4px rgba(120, 217, 159, 0.13);
    }

    .light.warn {
      background: var(--amber);
      box-shadow: 0 0 0 4px rgba(242, 200, 102, 0.14);
    }

    .mode-tabs {
      min-width: 0;
      border-bottom: 1px solid var(--line);
      padding: 9px 16px;
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(22, 22, 23, 0.92);
    }

    .mode-tab {
      min-height: 30px;
      border: 0;
      border-radius: 8px;
      padding: 0 11px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }

    .mode-tab:hover:not(:disabled),
    .mode-tab:focus-visible {
      background: rgba(255, 255, 255, 0.055);
      color: var(--text);
    }

    .mode-tab.active {
      background: rgba(242, 242, 247, 0.1);
      color: var(--text);
      box-shadow: inset 0 0 0 1px rgba(242, 242, 247, 0.08);
    }

    .workbench-panel {
      min-width: 0;
      min-height: 0;
    }

    .workbench-panel[hidden] {
      display: none;
    }

    .transcript {
      min-height: 0;
      overflow-y: auto;
      padding: 22px 24px;
      display: grid;
      align-content: start;
      gap: 14px;
    }

    .transcript.is-empty {
      align-content: center;
      justify-items: center;
      padding-bottom: 82px;
    }

    .empty-state {
      max-width: 430px;
      display: grid;
      justify-items: center;
      gap: 12px;
      text-align: center;
    }

    .empty-state[hidden] {
      display: none;
    }

    .empty-icon {
      width: 58px;
      height: 58px;
      opacity: 0.9;
    }

    .empty-title {
      margin: 0;
      color: var(--text);
      font-size: 21px;
      font-weight: 760;
      line-height: 1.22;
      letter-spacing: 0;
    }

    .empty-copy {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }

    .message {
      display: grid;
      grid-template-columns: 32px minmax(0, 720px);
      gap: 10px;
      align-items: start;
    }

    .message.assistant {
      grid-template-columns: minmax(0, 760px);
      justify-content: start;
    }

    .message.user {
      grid-template-columns: minmax(0, 720px) 32px;
      justify-content: end;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border: 1px solid var(--line);
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--panel);
      color: var(--text);
      font-size: 11px;
      font-weight: 820;
    }

    .bubble {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 13px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text);
      font-size: 14px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .message.assistant .bubble {
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
      color: var(--text);
    }

    .bubble.pending {
      min-width: 0;
      min-height: 22px;
      width: max-content;
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    .typing-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--muted);
      opacity: 0.42;
      animation: typingPulse 1050ms ease-in-out infinite;
    }

    .typing-dot:nth-child(2) {
      animation-delay: 140ms;
    }

    .typing-dot:nth-child(3) {
      animation-delay: 280ms;
    }

    @keyframes typingPulse {
      0%,
      80%,
      100% {
        opacity: 0.38;
        transform: translateY(0);
      }

      40% {
        opacity: 0.94;
        transform: translateY(-3px);
      }
    }

    .user .bubble {
      border-color: rgba(242, 242, 247, 0.24);
      background: rgba(242, 242, 247, 0.08);
    }

    .message.error .bubble {
      color: #ffb4ae;
    }

    .message.user.error .bubble {
      border-color: rgba(255, 116, 109, 0.72);
      background: rgba(255, 116, 109, 0.1);
      color: var(--text);
    }

    .code-panel {
      padding: 14px 16px 16px;
      overflow: hidden;
    }

    .code-shell {
      height: 100%;
      min-height: 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      display: grid;
      grid-template-rows: 38px minmax(0, 1fr);
      overflow: hidden;
      background: #111112;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }

    .code-head {
      min-width: 0;
      border-bottom: 1px solid var(--line-soft);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 8px 0 13px;
      color: var(--faint);
      font-size: 11px;
      font-weight: 760;
    }

    .code-copy.copied {
      color: var(--green);
      background: rgba(48, 209, 88, 0.1);
    }

    .code-editor {
      min-height: 0;
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr);
      overflow: hidden;
    }

    .code-gutter {
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--line-soft);
      padding: 13px 10px 18px 0;
      background: rgba(255, 255, 255, 0.016);
      color: #626267;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.62;
      text-align: right;
      user-select: none;
      white-space: pre;
    }

    .code-preview {
      height: 100%;
      min-height: 0;
      border: 0;
      border-radius: 0;
      margin: 0;
      padding: 13px 15px 18px;
      background: transparent;
      color: #f2f2f7;
      box-shadow: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 12.5px;
      line-height: 1.62;
      tab-size: 2;
      white-space: pre;
      overflow: auto;
      outline: none;
      user-select: text;
    }

    .code-preview:focus-visible {
      box-shadow: inset 0 0 0 2px rgba(242, 242, 247, 0.08);
    }

    .syntax-keyword {
      color: #ffb86c;
    }

    .syntax-string {
      color: #a6e3a1;
    }

    .syntax-number {
      color: #d4bfff;
    }

    .syntax-boolean {
      color: #ff9f9f;
    }

    .syntax-function {
      color: #9cdcfe;
    }

    .syntax-property {
      color: #ffd866;
    }

    .syntax-comment {
      color: #7c7c80;
      font-style: italic;
    }

    .syntax-punctuation {
      color: #a8a8ad;
    }

    .composer {
      border-top: 1px solid var(--line);
      padding: 12px 16px 14px;
      background: rgba(17, 17, 18, 0.94);
    }

    .composer-box {
      position: relative;
      display: grid;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(28, 28, 30, 0.92);
      box-shadow:
        0 18px 36px rgba(0, 0, 0, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.045);
    }

    .composer-box:focus-within {
      border-color: #5a5a5f;
      box-shadow:
        0 18px 36px rgba(0, 0, 0, 0.22),
        0 0 0 3px rgba(242, 242, 247, 0.06),
        inset 0 1px 0 rgba(255, 255, 255, 0.055);
    }

    .composer-bottombar {
      position: absolute;
      left: 8px;
      right: 52px;
      bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      pointer-events: none;
    }

    .composer-select {
      width: auto;
      min-height: 28px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      min-width: 0;
      background: transparent;
      color: var(--muted);
      pointer-events: auto;
    }

    .composer-select:hover {
      background: rgba(255, 255, 255, 0.055);
      color: var(--text);
    }

    .composer-select:focus-within {
      background: rgba(255, 255, 255, 0.075);
    }

    .composer-select select {
      min-width: 0;
      min-height: 28px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      box-shadow: none;
      pointer-events: auto;
      font-size: 12px;
      font-weight: 700;
    }

    .composer-select select:focus {
      box-shadow: none;
      background: transparent;
    }

    .composer-provider-wrap {
      max-width: min(210px, 44%);
    }

    .composer-provider-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      margin-left: 8px;
      object-fit: contain;
      filter: invert(1) brightness(0.9);
      opacity: 0.86;
    }

    .composer-provider-icon[data-icon="harness"] {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      filter: none;
      opacity: 1;
    }

    .composer-provider-icon[hidden] {
      display: none;
    }

    .composer-provider {
      width: 100%;
      max-width: 178px;
      padding: 0 24px 0 6px;
    }

    .composer-separator {
      width: 1px;
      height: 18px;
      background: var(--line);
      flex: 0 0 auto;
    }

    .composer-model-wrap {
      max-width: min(270px, 50%);
    }

    .composer-model {
      width: 100%;
      min-width: 132px;
      padding: 0 24px 0 8px;
    }

    .composer textarea {
      min-height: 108px;
      border: 0;
      border-radius: 12px;
      background: transparent;
      box-shadow: none;
      padding: 14px 58px 54px 14px;
      color: var(--text);
      font-size: 14px;
      resize: vertical;
    }

    .composer textarea:focus {
      box-shadow: none;
    }

    .send-button {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 34px;
      min-width: 34px;
      height: 34px;
      min-height: 34px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      padding: 0;
    }

    .send-button svg {
      width: 17px;
      height: 17px;
      fill: currentColor;
    }

    .send-button .icon-stop {
      display: none;
    }

    .send-button.danger .icon-send {
      display: none;
    }

    .send-button.danger .icon-stop {
      display: block;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .inspector-head {
      min-width: 0;
      padding: 12px;
      border-bottom: 1px solid var(--line);
      display: grid;
      gap: 10px;
      background: rgba(28, 28, 30, 0.56);
    }

    .meters {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(255, 255, 255, 0.018);
    }

    .meter {
      min-width: 0;
      padding: 8px 9px;
      border-right: 1px solid var(--line-soft);
    }

    .meter:last-child {
      border-right: 0;
    }

    .meter b {
      display: block;
      color: var(--text);
      font-size: 17px;
      font-weight: 760;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    .meter span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 720;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .events {
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .events:empty::before {
      content: "No events yet";
      display: grid;
      min-height: 118px;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--faint);
    }

    .event {
      --event-accent: var(--faint);
      --event-bg: rgba(255, 255, 255, 0.024);
      flex: 0 0 auto;
      border: 1px solid var(--line-soft);
      border-radius: 8px;
      background: var(--event-bg);
      overflow: hidden;
    }

    .event.event-chunk {
      --event-accent: var(--green);
      --event-bg: rgba(48, 209, 88, 0.075);
    }

    .event.event-stdout,
    .event.event-raw {
      --event-accent: var(--blue);
      --event-bg: rgba(100, 210, 255, 0.07);
    }

    .event.event-stderr,
    .event.event-error {
      --event-accent: var(--red);
      --event-bg: rgba(255, 69, 58, 0.08);
    }

    .event.event-request,
    .event.event-start {
      --event-accent: var(--accent);
      --event-bg: rgba(242, 242, 247, 0.045);
    }

    .event.event-exit {
      --event-accent: var(--amber);
      --event-bg: rgba(255, 214, 10, 0.07);
    }

    .event.event-result {
      --event-accent: var(--violet);
      --event-bg: rgba(191, 90, 242, 0.08);
    }

    .event-head {
      width: 100%;
      min-height: 0;
      border: 0;
      border-radius: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      padding: 8px 9px;
      background: transparent;
      color: var(--text);
      text-align: left;
      font-family: inherit;
      font-size: 12px;
      font-weight: 720;
    }

    .event-head:hover {
      background: rgba(255, 255, 255, 0.035);
    }

    .event-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .event-type {
      flex: 0 0 auto;
      min-width: 56px;
      border: 1px solid color-mix(in srgb, var(--event-accent), transparent 58%);
      border-radius: 999px;
      padding: 2px 6px;
      color: var(--event-accent);
      font-size: 10px;
      line-height: 1.2;
      text-align: center;
      text-transform: uppercase;
    }

    .event-summary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
    }

    .event-meta {
      color: var(--faint);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .event-detail {
      display: none;
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: 9px;
      border-top: 1px solid var(--line-soft);
      background: rgba(0, 0, 0, 0.18);
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .event.open .event-detail {
      display: block;
    }

    .result {
      min-height: 0;
      border-top: 1px solid var(--line);
      overflow-y: auto;
      padding: 10px;
      background: rgba(17, 17, 18, 0.76);
    }

    .result pre {
      margin: 0;
      color: var(--muted);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
    }

    @media (max-width: 1180px) {
      .layout {
        grid-template-columns: 282px minmax(500px, 1fr) 380px;
      }
    }

    @media (max-width: 760px) {
      .shell {
        grid-template-rows: auto minmax(0, 1fr);
      }

      header {
        min-height: 58px;
        align-items: flex-start;
        flex-direction: column;
        justify-content: center;
        gap: 6px;
        padding: 8px 12px;
      }

      .meta {
        justify-content: flex-start;
      }

      .layout {
        grid-template-columns: 282px 500px 360px;
      }

      .row,
      .switches {
        grid-template-columns: 1fr;
      }

      .meters {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .mode-tabs {
        padding: 8px 12px;
      }

      .meter:nth-child(2) {
        border-right: 0;
      }

      .meter:nth-child(-n + 2) {
        border-bottom: 1px solid var(--line-soft);
      }

      .send-button {
        width: 34px;
      }

      .message,
      .message.user {
        grid-template-columns: 32px minmax(0, 1fr);
      }

      .message.assistant {
        grid-template-columns: minmax(0, 1fr);
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
      <div class="brand">
        <div class="brand-mark">
          <img src="${harnessMonoIconUrl}" alt="" aria-hidden="true">
        </div>
        <div>
          <h1>Harness</h1>
          <div class="subtitle">Debug console</div>
        </div>
      </div>
      <div class="meta">
        <span class="pill" id="sdk-version">sdk</span>
        <span class="pill" id="node-version">node</span>
        <span class="pill" id="pid">pid</span>
      </div>
    </header>

    <div class="layout">
      <aside>
        <div class="section accounts">
          <div class="accounts-head">
            <div class="section-title">Accounts</div>
            <button id="detect" class="icon-button refresh-button" aria-label="Refresh accounts" title="Refresh accounts">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M17.7 6.3A8 8 0 0 0 4.4 10H2.2A10 10 0 0 1 19 4.9V2h2v6.5h-6.5v-2h3.2ZM6.3 17.7A8 8 0 0 0 19.6 14h2.2A10 10 0 0 1 5 19.1V22H3v-6.5h6.5v2H6.3Z"></path>
              </svg>
            </button>
          </div>
          <div class="accounts-body">
            <div class="statuses" id="statuses"></div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Run Context</div>
          <label class="field">
            Workspace
            <input id="cwd" spellcheck="false">
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

        <details class="section">
          <summary>Advanced</summary>
          <div class="advanced-body">
            <label class="field">
              Timeout ms
              <input id="timeout" type="number" min="1000" step="1000" value="120000">
            </label>
            <label class="field">
              Extra args
              <input id="args" placeholder="--flag value --quoted 'two words'" spellcheck="false">
            </label>
            <label class="field">
              Env overrides
              <textarea id="env" spellcheck="false" placeholder="KEY=value"></textarea>
            </label>
          </div>
        </details>

        <div class="actions">
          <button id="clear">Clear</button>
        </div>
      </aside>

      <main>
        <div class="mode-tabs" role="tablist" aria-label="Workbench mode">
          <button id="chat-tab" class="mode-tab active" type="button" role="tab" aria-selected="true" aria-controls="chat-panel">Chat mode</button>
          <button id="code-tab" class="mode-tab" type="button" role="tab" aria-selected="false" aria-controls="code-panel">Code mode</button>
        </div>
        <section class="transcript workbench-panel is-empty" id="chat-panel" role="tabpanel" aria-labelledby="chat-tab" aria-live="polite">
          <div class="empty-state" id="empty-state">
            <img class="empty-icon" src="${harnessMonoIconUrl}" alt="" aria-hidden="true">
            <h2 class="empty-title">What should Harness run today?</h2>
            <p class="empty-copy">Use this workbench to test SDK-backed AI providers with the workspace, model, and runtime settings you choose.</p>
          </div>
        </section>
        <section class="code-panel workbench-panel" id="code-panel" role="tabpanel" aria-labelledby="code-tab" hidden>
          <div class="code-shell">
            <div class="code-head">
              <span>TypeScript</span>
              <button id="copy-code" class="icon-button code-copy" type="button" aria-label="Copy code" title="Copy code">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h7A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H16v1.5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-7A2.5 2.5 0 0 1 6.5 7H8Zm2 0h3.5A2.5 2.5 0 0 1 16 9.5V13h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V7Zm-3.5 2a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7Z"></path>
                </svg>
              </button>
            </div>
            <div class="code-editor">
              <div id="code-gutter" class="code-gutter" aria-hidden="true">1</div>
              <pre id="code-preview" class="code-preview" aria-label="Generated Harness SDK code" tabindex="0"></pre>
            </div>
          </div>
        </section>
        <div class="composer">
          <div class="composer-box">
            <textarea id="prompt" aria-label="Prompt" spellcheck="true">Reply with exactly HELLO.</textarea>
            <div class="composer-bottombar">
              <span class="composer-select composer-provider-wrap">
                <img id="provider-icon" class="composer-provider-icon" alt="" hidden>
                <select id="provider" class="composer-provider" aria-label="Provider">
                  <option value="auto">Auto</option>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="copilot">GitHub Copilot</option>
                  <option value="cursor">Cursor</option>
                  <option value="gemini">Gemini CLI</option>
                  <option value="opencode">OpenCode</option>
                  <option value="wp-studio">WP Studio</option>
                </select>
              </span>
              <span class="composer-separator" aria-hidden="true"></span>
              <span class="composer-select composer-model-wrap">
                <select id="model" class="composer-model" aria-label="Model">
                  <option value="">Default model</option>
                </select>
              </span>
            </div>
            <button id="run" class="primary send-button" aria-label="Run" title="Run">
              <svg class="icon-send" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.7 20.3 21 12 3.7 3.7 3 4.4l4.2 7.6L3 19.6l.7.7Zm4.7-7.3h7.8l-10 4.8L8.4 13Zm0-2L6.2 6.2l10 4.8H8.4Z"></path>
              </svg>
              <svg class="icon-stop" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 7h10v10H7V7Z"></path>
              </svg>
              <span class="visually-hidden">Run</span>
            </button>
          </div>
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
      chatTab: $("#chat-tab"),
      codeTab: $("#code-tab"),
      chatPanel: $("#chat-panel"),
      codePanel: $("#code-panel"),
      codePreview: $("#code-preview"),
      codeGutter: $("#code-gutter"),
      copyCode: $("#copy-code"),
      provider: $("#provider"),
      providerIcon: $("#provider-icon"),
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
      clear: $("#clear")
    };
    const transcript = controls.chatPanel;
    const emptyState = $("#empty-state");
    const statuses = $("#statuses");
    const events = $("#events");
    const resultPanel = $("#result");
    const counters = {
      events: $("#event-count"),
      chunks: $("#chunk-count"),
      stdout: $("#stdout-count"),
      stderr: $("#stderr-count")
    };
    const providerNames = {
      auto: "Auto",
      claude: "Claude Code",
      codex: "Codex",
      copilot: "GitHub Copilot",
      cursor: "Cursor",
      error: "Error",
      gemini: "Gemini CLI",
      opencode: "OpenCode",
      "wp-studio": "WP Studio"
    };
    const harnessIconUrl = ${JSON.stringify(harnessMonoIconUrl)};
    const providerIcons = {
      auto: harnessIconUrl,
      claude: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/claude.svg",
      codex: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
      copilot: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/githubcopilot.svg",
      cursor: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/cursor.svg",
      gemini: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/googlegemini.svg",
      opencode: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/opencode.svg",
      "wp-studio": "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/wordpress.svg"
    };
    let abortController;
    let activeBubble;
    let counts = { events: 0, chunks: 0, stdout: 0, stderr: 0 };
    let modelLoadId = 0;
    let copyResetTimer;
    let generatedCode = "";

    controls.chatTab.addEventListener("click", () => setMode("chat"));
    controls.codeTab.addEventListener("click", () => setMode("code"));
    controls.copyCode.addEventListener("click", copyGeneratedCode);
    controls.detect.addEventListener("click", detectProviders);
    controls.provider.addEventListener("change", () => {
      updateProviderIcon();
      updateActiveAccount();
      void loadModels();
    });
    controls.env.addEventListener("change", () => void loadModels());
    controls.run.addEventListener("click", submitOrAbort);
    controls.clear.addEventListener("click", clearWorkbench);
    controls.codePreview.addEventListener("scroll", syncCodeGutterScroll);

    for (const control of [
      controls.prompt,
      controls.provider,
      controls.cwd,
      controls.model,
      controls.timeout,
      controls.args,
      controls.env,
      controls.stream,
      controls.allowEdits
    ]) {
      control.addEventListener("input", updateCodePreview);
      control.addEventListener("change", updateCodePreview);
    }

    boot();

    async function boot() {
      const meta = await fetchJson("/api/meta");
      $("#sdk-version").textContent = "sdk " + meta.sdkVersion;
      $("#node-version").textContent = meta.node;
      $("#pid").textContent = "pid " + meta.pid;
      controls.cwd.value = meta.cwd;
      updateProviderIcon();
      updateCodePreview();
      if (window.location.hash === "#code") {
        setMode("code");
      }
      await detectProviders();
      await loadModels();
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
        updateActiveAccount();
      } catch (error) {
        statuses.append(statusRow({ id: "error", available: false, message: error.message }));
        updateActiveAccount();
      } finally {
        controls.detect.disabled = false;
      }
    }

    async function loadModels() {
      const loadId = ++modelLoadId;
      const requestedProvider = controls.provider.value;
      const previous = controls.model.value;
      controls.model.disabled = true;
      controls.model.innerHTML = "";
      controls.model.append(modelOption({ value: "", label: "Loading..." }));

      try {
        const data = await fetchJson("/api/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: requestedProvider,
            envText: controls.env.value
          })
        });

        if (!isCurrentModelLoad(loadId, requestedProvider)) {
          return;
        }

        controls.model.innerHTML = "";

        for (const option of data.models) {
          controls.model.append(modelOption(option));
        }

        const values = new Set(data.models.map((option) => option.value));
        controls.model.value = values.has(previous) ? previous : "";
        controls.model.title =
          data.provider === "auto" && data.effectiveProvider !== "auto"
            ? "Models for " + providerName(data.effectiveProvider)
            : "Models for " + providerName(data.provider);
        updateCodePreview();
      } catch (error) {
        if (!isCurrentModelLoad(loadId, requestedProvider)) {
          return;
        }

        controls.model.innerHTML = "";
        controls.model.append(modelOption({ value: "", label: "Default model" }));
        controls.model.title = error.message;
        updateCodePreview();
      } finally {
        if (isCurrentModelLoad(loadId, requestedProvider)) {
          controls.model.disabled = false;
        }
      }
    }

    function isCurrentModelLoad(loadId, provider) {
      return loadId === modelLoadId && controls.provider.value === provider;
    }

    function updateProviderIcon() {
      const provider = controls.provider.value;
      const iconUrl = providerIcons[provider];

      controls.provider.title = providerName(provider);

      if (!iconUrl) {
        controls.providerIcon.hidden = true;
        controls.providerIcon.removeAttribute("src");
        delete controls.providerIcon.dataset.icon;
        return;
      }

      controls.providerIcon.hidden = false;
      controls.providerIcon.src = iconUrl;
      controls.providerIcon.dataset.icon = provider === "auto" ? "harness" : "provider";
    }

    controls.providerIcon.addEventListener("error", () => {
      controls.providerIcon.hidden = true;
      controls.providerIcon.removeAttribute("src");
      delete controls.providerIcon.dataset.icon;
    });

    function providerName(provider, fallback) {
      return providerNames[provider] || fallback || provider || "Provider";
    }

    function providerOption(provider) {
      return [...controls.provider.options].some((option) => option.value === provider);
    }

    function selectProvider(provider) {
      if (controls.provider.disabled || !providerOption(provider)) {
        return;
      }

      controls.provider.value = provider;
      updateProviderIcon();
      updateActiveAccount();
      void loadModels();
    }

    function updateActiveAccount() {
      const provider = controls.provider.value;

      for (const row of statuses.querySelectorAll(".status-row")) {
        const active = row.dataset.provider === provider;
        row.classList.toggle("active", active);
        row.setAttribute("aria-pressed", String(active));
      }
    }

    function setMode(mode) {
      const isCode = mode === "code";
      controls.chatTab.classList.toggle("active", !isCode);
      controls.codeTab.classList.toggle("active", isCode);
      controls.chatTab.setAttribute("aria-selected", String(!isCode));
      controls.codeTab.setAttribute("aria-selected", String(isCode));
      controls.chatPanel.hidden = isCode;
      controls.codePanel.hidden = !isCode;

      if (isCode) {
        updateCodePreview();
        controls.codePreview.focus();
      } else {
        controls.prompt.focus();
      }
    }

    function copyGeneratedCode() {
      const code = generatedCode;

      if (!code) {
        return;
      }

      clearTimeout(copyResetTimer);
      navigator.clipboard.writeText(code).then(() => {
        controls.copyCode.classList.add("copied");
        controls.copyCode.title = "Copied";
        copyResetTimer = setTimeout(() => {
          controls.copyCode.classList.remove("copied");
          controls.copyCode.title = "Copy code";
        }, 1100);
      }).catch(() => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(controls.codePreview);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    }

    function updateCodePreview() {
      generatedCode = generateHarnessCode();
      controls.codePreview.innerHTML = highlightTypescript(generatedCode);
      controls.codeGutter.textContent = Array.from({ length: generatedCode.split("\\n").length }, (_, index) => index + 1).join("\\n");
      syncCodeGutterScroll();
    }

    function syncCodeGutterScroll() {
      controls.codeGutter.scrollTop = controls.codePreview.scrollTop;
    }

    function highlightTypescript(code) {
      const tokenPattern = /(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\b(?:import|from|const|let|var|await|async|function|return|if|else|for|of|new|true|false|null|undefined)\\b|\\b\\d+(?:\\.\\d+)?\\b|\\.[A-Za-z_$][\\w$]*|[A-Za-z_$][\\w$]*(?=\\s*[:(])|[{}()[\\],.;:])/g;
      let html = "";
      let lastIndex = 0;
      let match;

      while ((match = tokenPattern.exec(code)) !== null) {
        const token = match[0];
        html += escapeHtml(code.slice(lastIndex, match.index));
        html += '<span class="' + syntaxClass(token, code.slice(match.index + token.length)) + '">' + escapeHtml(token) + '</span>';
        lastIndex = tokenPattern.lastIndex;
      }

      html += escapeHtml(code.slice(lastIndex));
      return html;
    }

    function syntaxClass(token, afterToken) {
      if (token.startsWith("//") || token.startsWith("/*")) {
        return "syntax-comment";
      }

      if (token.startsWith('"') || token.startsWith("'")) {
        return "syntax-string";
      }

      if (/^(true|false|null|undefined)$/.test(token)) {
        return "syntax-boolean";
      }

      if (/^(import|from|const|let|var|await|async|function|return|if|else|for|of|new)$/.test(token)) {
        return "syntax-keyword";
      }

      if (/^\\d/.test(token)) {
        return "syntax-number";
      }

      if (token.startsWith(".") || /^\\s*:/.test(afterToken)) {
        return "syntax-property";
      }

      if (/^[A-Za-z_$]/.test(token)) {
        return "syntax-function";
      }

      return "syntax-punctuation";
    }

    function escapeHtml(value) {
      return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function generateHarnessCode() {
      const clientEntries = [];
      const cwd = controls.cwd.value.trim();
      const envEntries = parseEnvEntries(controls.env.value);

      if (cwd) {
        clientEntries.push(["cwd", cwd]);
      }

      if (envEntries.length > 0) {
        clientEntries.push(["env", envEntries]);
      }

      const requestLines = [
        "  provider: " + codeValue(controls.provider.value || "auto") + ",",
        "  prompt: " + codeValue(controls.prompt.value) + ","
      ];
      const model = controls.model.value;
      const timeoutMs = Number(controls.timeout.value);
      const parsedArgs = parsePreviewArgs(controls.args.value);

      if (model) {
        requestLines.push("  model: " + codeValue(model) + ",");
      }

      if (parsedArgs.length > 0) {
        requestLines.push("  args: " + codeValue(parsedArgs) + ",");
      }

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        requestLines.push("  timeoutMs: " + String(Math.round(timeoutMs)) + ",");
      }

      if (controls.allowEdits.checked) {
        requestLines.push("  allowEdits: true,");
      }

      if (controls.stream.checked) {
        requestLines.push("  stream: true,");
        requestLines.push("  onEvent(event) {");
        requestLines.push("    if (event.type === " + codeValue("chunk") + " && event.text) {");
        requestLines.push("      process.stdout.write(event.text);");
        requestLines.push("    }");
        requestLines.push("  }");
      } else if (requestLines.length > 0) {
        requestLines[requestLines.length - 1] = requestLines[requestLines.length - 1].replace(/,$/, "");
      }

      if (controls.stream.checked && requestLines.length > 0) {
        const last = requestLines.length - 1;
        requestLines[last] = requestLines[last].replace(/,$/, "");
      }

      const clientCode = clientEntries.length
        ? "const harness = createHarnessClient(" + objectFromEntries(clientEntries, 0) + ");"
        : "const harness = createHarnessClient();";

      return [
        "import { createHarnessClient } from " + codeValue("harness-app-sdk") + ";",
        "",
        clientCode,
        "",
        "const result = await harness.run({",
        ...requestLines,
        "});",
        "",
        controls.stream.checked ? "console.log(" + codeValue("\\n\\nDone:") + ", result.text);" : "console.log(result.text);"
      ].join("\\n");
    }

    function parseEnvEntries(text) {
      const entries = [];

      for (const rawLine of text.split(/\\r?\\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
          continue;
        }

        const equals = line.indexOf("=");

        if (equals <= 0) {
          continue;
        }

        entries.push([line.slice(0, equals).trim(), line.slice(equals + 1)]);
      }

      return entries;
    }

    function parsePreviewArgs(value) {
      const args = [];
      let current = "";
      let quote;
      let escaping = false;

      for (const character of value) {
        if (escaping) {
          current += character;
          escaping = false;
          continue;
        }

        if (character === "\\\\") {
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

        if (character === "'" || character === "\\\"") {
          quote = character;
          continue;
        }

        if (/\\s/.test(character)) {
          if (current) {
            args.push(current);
            current = "";
          }

          continue;
        }

        current += character;
      }

      if (escaping) {
        current += "\\\\";
      }

      if (quote) {
        return value.trim() ? [value.trim()] : [];
      }

      if (current) {
        args.push(current);
      }

      return args;
    }

    function objectFromEntries(entries, level) {
      if (entries.length === 0) {
        return "{}";
      }

      const lines = ["{"];

      for (const [key, value] of entries) {
        lines.push(indent(level + 1) + codeKey(key) + ": " + codeValue(value, level + 1) + ",");
      }

      lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, "");
      lines.push(indent(level) + "}");
      return lines.join("\\n");
    }

    function codeValue(value, level = 0) {
      if (Array.isArray(value)) {
        if (value.length > 0 && Array.isArray(value[0])) {
          return objectFromEntries(value, level);
        }

        return "[" + value.map((item) => codeValue(item, level)).join(", ") + "]";
      }

      if (typeof value === "string") {
        return JSON.stringify(value);
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }

      return JSON.stringify(value);
    }

    function codeKey(key) {
      return /^[A-Za-z_$][\\w$]*$/.test(key) ? key : JSON.stringify(key);
    }

    function indent(level) {
      return "  ".repeat(level);
    }

    async function runHarness() {
      const prompt = controls.prompt.value.trim();

      if (!prompt) {
        controls.prompt.focus();
        return;
      }

      if (controls.chatPanel.hidden) {
        setMode("chat");
      }

      abortController = new AbortController();
      setRunning(true);
      activeBubble = null;
      appendMessage("user", "You", prompt);
      const assistant = appendMessage("assistant", "H", "", { pending: true });
      activeBubble = assistant.bubble;
      resultPanel.textContent = "{}";

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
        if (error.name === "AbortError") {
          setBubbleText(activeBubble, "Aborted.");
        } else {
          assistant.message.classList.add("error");
          appendBubbleText(activeBubble, (bubbleHasText(activeBubble) ? "\\n" : "") + error.message);
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

    function submitOrAbort() {
      if (abortController) {
        abortRun();
        return;
      }

      void runHarness();
    }

    function clearWorkbench() {
      transcript.querySelectorAll(".message").forEach((message) => message.remove());
      setChatEmpty(true);
      events.innerHTML = "";
      resultPanel.textContent = "{}";
      counts = { events: 0, chunks: 0, stdout: 0, stderr: 0 };
      updateCounters();
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
          appendBubbleText(activeBubble, event.text);
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

        if (activeBubble && !bubbleHasText(activeBubble)) {
          setBubbleText(activeBubble, message.result.text || "Done.");
        }

        appendEvent("result", message.result);
        return;
      }

      if (message.kind === "error") {
        resultPanel.textContent = formatJson(message.error);

        if (activeBubble) {
          activeBubble.parentElement.classList.add("error");
          appendBubbleText(activeBubble, bubbleHasText(activeBubble)
            ? "\\n" + message.error.message
            : message.error.message);
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

    function appendMessage(role, initials, text, options = {}) {
      setChatEmpty(false);
      const message = document.createElement("div");
      message.className = role === "user" ? "message user" : "message assistant";

      const bubble = document.createElement("div");
      bubble.className = "bubble";

      if (options.pending) {
        showPendingBubble(bubble);
      } else {
        bubble.textContent = text;
      }

      if (role === "user") {
        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.textContent = initials;
        message.append(bubble, avatar);
      } else {
        message.append(bubble);
      }

      transcript.append(message);
      transcript.scrollTop = transcript.scrollHeight;
      return { message, bubble };
    }

    function setChatEmpty(empty) {
      transcript.classList.toggle("is-empty", empty);
      emptyState.hidden = !empty;
    }

    function showPendingBubble(bubble) {
      bubble.classList.add("pending");
      bubble.setAttribute("aria-label", "Waiting for response");
      bubble.innerHTML = '<span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span><span class="typing-dot" aria-hidden="true"></span>';
    }

    function clearPendingBubble(bubble) {
      if (!bubble) {
        return;
      }

      if (!bubble.classList.contains("pending")) {
        return;
      }

      bubble.classList.remove("pending");
      bubble.removeAttribute("aria-label");
      bubble.textContent = "";
    }

    function bubbleHasText(bubble) {
      return Boolean(bubble && !bubble.classList.contains("pending") && bubble.textContent);
    }

    function appendBubbleText(bubble, text) {
      if (!bubble) {
        return;
      }

      clearPendingBubble(bubble);
      bubble.textContent += text;
    }

    function setBubbleText(bubble, text) {
      if (!bubble) {
        return;
      }

      clearPendingBubble(bubble);
      bubble.textContent = text;
    }

    function appendEvent(type, payload) {
      const eventType = String(type || "event");
      const typeClass = cssToken(eventType);
      const sequence = events.children.length + 1;
      const row = document.createElement("div");
      row.className = "event event-" + typeClass;

      const button = document.createElement("button");
      button.className = "event-head";
      button.type = "button";

      const main = document.createElement("span");
      const tag = document.createElement("span");
      const summary = document.createElement("span");
      const meta = document.createElement("span");
      const pre = document.createElement("pre");

      main.className = "event-main";
      tag.className = "event-type";
      summary.className = "event-summary";
      meta.className = "event-meta";
      pre.className = "event-detail";

      tag.textContent = eventType;
      summary.textContent = eventSummary(eventType, payload) || eventType;
      meta.textContent = "#" + String(sequence).padStart(3, "0");
      pre.textContent = formatJson(payload);

      main.append(tag, summary);
      button.append(main, meta);
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
      const row = document.createElement("button");
      const providerId = status.id || "provider";
      const iconUrl = providerIcons[providerId];
      const selectable = providerOption(providerId);
      row.type = "button";
      row.dataset.provider = providerId;
      row.className = "status-row" + (status.available ? "" : " is-missing");
      row.setAttribute("aria-pressed", "false");
      row.setAttribute("aria-label", providerName(providerId, status.name));

      if (selectable) {
        row.addEventListener("click", () => selectProvider(providerId));
      } else {
        row.disabled = true;
      }

      const head = document.createElement("div");
      head.className = "status-head";
      const iconBox = document.createElement("div");
      iconBox.className = "provider-icon";

      if (iconUrl) {
        const icon = document.createElement("img");
        icon.src = iconUrl;
        icon.alt = "";
        icon.loading = "lazy";
        icon.decoding = "async";
        icon.addEventListener("error", () => {
          icon.remove();
        });
        iconBox.append(icon);
      }

      const light = document.createElement("div");
      light.className = "light " + (status.available ? (status.authenticated === false ? "warn" : "ok") : "");
      head.append(iconBox, light);
      const body = document.createElement("div");
      body.className = "status-copy";
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      title.textContent = providerName(providerId, status.name);
      detail.textContent = status.message || status.version || (status.available ? "available" : "missing");
      body.append(title, detail);
      row.append(head, body);
      return row;
    }

    function modelOption(model) {
      const option = document.createElement("option");
      option.value = model.value || "";
      option.textContent = model.label || model.value || "Default model";
      option.title = model.value || model.label || "Default model";
      return option;
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
      controls.run.setAttribute("aria-label", value ? "Abort" : "Run");
      controls.run.setAttribute("title", value ? "Abort" : "Run");
      const label = controls.run.querySelector(".visually-hidden");
      if (label) {
        label.textContent = value ? "Abort" : "Run";
      }
      controls.run.classList.toggle("primary", !value);
      controls.run.classList.toggle("danger", value);
      controls.provider.disabled = value;
      controls.model.disabled = value;
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

    function cssToken(value) {
      return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "event";
    }
  </script>
</body>
</html>`;
}
