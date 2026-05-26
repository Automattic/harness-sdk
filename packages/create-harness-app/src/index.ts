import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type HarnessTemplate = "cli" | "web";

export interface CreateHarnessAppOptions {
  appName: string;
  directory?: string;
  template?: HarnessTemplate;
  force?: boolean;
}

export interface CreateHarnessAppResult {
  appName: string;
  directory: string;
  template: HarnessTemplate;
  files: string[];
}

const HARNESS_APP_SDK_VERSION = "^0.1.6";

export async function createHarnessApp(
  options: CreateHarnessAppOptions
): Promise<CreateHarnessAppResult> {
  const template = options.template ?? "cli";
  const directory = resolve(options.directory ?? options.appName);
  const appName = normalizePackageName(options.appName || basename(directory));

  if (template !== "cli" && template !== "web") {
    throw new Error(`Unknown template "${template}". Use "cli" or "web".`);
  }

  await mkdir(directory, { recursive: true });

  const existing = await readdir(directory);

  if (existing.length > 0 && !options.force) {
    throw new Error(
      `${directory} is not empty. Choose another directory or pass --force to write into it.`
    );
  }

  const files = template === "cli" ? cliTemplate(appName) : webTemplate(appName);
  const written: string[] = [];

  for (const file of files) {
    const destination = join(directory, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents);
    written.push(file.path);
  }

  return {
    appName,
    directory,
    template,
    files: written
  };
}

interface TemplateFile {
  path: string;
  contents: string;
}

function cliTemplate(appName: string): TemplateFile[] {
  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name: appName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx src/index.ts",
            build: "tsc -p tsconfig.json",
            start: "node dist/index.js"
          },
          dependencies: {
            "harness-app-sdk": HARNESS_APP_SDK_VERSION
          },
          devDependencies: {
            "@types/node": "^22.10.2",
            tsx: "^4.19.2",
            typescript: "^5.7.2"
          },
          engines: {
            node: ">=20"
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: "tsconfig.json",
      contents: tsconfig()
    },
    {
      path: "README.md",
      contents: `# ${appName}\n\nA chat-style Harness App SDK CLI demo that streams from local AI accounts. No API keys.\n\n## Run\n\n\`\`\`sh\nnpm install\nnpm run dev -- \"Explain how this app uses Harness.\"\nnpm run dev -- --provider codex \"Summarize this folder.\"\n\`\`\`\n\nProviders can be \`auto\`, \`claude\`, \`codex\`, \`copilot\`, \`gemini\`, or \`wp-studio\`. The template prints a small chat transcript and streams assistant chunks as they arrive.\n`
    },
    {
      path: "src/index.ts",
      contents: `import {
  createHarnessClient,
  HarnessSdkError,
  type ProviderSelector
} from "harness-app-sdk";

interface CliOptions {
  prompt: string;
  provider: ProviderSelector;
}

const providers = new Set<ProviderSelector>(["auto", "claude", "codex", "copilot", "gemini", "wp-studio"]);
const options = parseArgs(process.argv.slice(2));
const harness = createHarnessClient({ defaultProvider: options.provider });
const startedAt = Date.now();
let streamed = false;
const assistantBubble = createStreamingBubbleWriter("assistant");

printHeader(options.provider);
printBubble("you", options.prompt);
assistantBubble.start();

try {
  const result = await harness.run({
    prompt: options.prompt,
    stream: true,
    onEvent(event) {
      if (event.type === "chunk" && event.text) {
        streamed = true;
        assistantBubble.write(event.text);
      }
    }
  });

  if (!streamed && result.text) {
    assistantBubble.write(result.text);
  }

  assistantBubble.end();
  printMeta("provider: " + result.provider + " | duration: " + formatMs(Date.now() - startedAt));
} catch (error) {
  assistantBubble.end();

  if (error instanceof HarnessSdkError) {
    printMeta(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

function parseArgs(argv: string[]): CliOptions {
  let provider: ProviderSelector = "auto";
  const promptParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--provider" || value === "-p") {
      const next = argv[index + 1];

      if (!next || !providers.has(next as ProviderSelector)) {
        throw new Error("Use --provider with auto, claude, codex, copilot, gemini, or wp-studio.");
      }

      provider = next as ProviderSelector;
      index += 1;
      continue;
    }

    promptParts.push(value);
  }

  return {
    provider,
    prompt: promptParts.join(" ").trim() || "Explain how this project can extend Harness."
  };
}

function printHeader(provider: ProviderSelector): void {
  console.log("");
  console.log("Harness Chat CLI");
  console.log("Local AI accounts | No API keys | provider: " + provider);
}

function printBubble(label: string, text: string): void {
  console.log("");
  console.log(label);

  for (const line of wrapText(text, 78)) {
    console.log("  " + line);
  }
}

function createStreamingBubbleWriter(label: string): {
  start(): void;
  write(chunk: string): void;
  end(): void;
} {
  let atLineStart = true;
  let wrote = false;

  return {
    start() {
      console.log("");
      console.log(label);
    },
    write(chunk) {
      for (const character of chunk) {
        if (atLineStart) {
          process.stdout.write("  ");
          atLineStart = false;
        }

        process.stdout.write(character);
        wrote = true;

        if (character === "\\n") {
          atLineStart = true;
        }
      }
    },
    end() {
      if (!wrote) {
        process.stdout.write("  (no text returned)");
      }

      if (!atLineStart) {
        process.stdout.write("\\n");
      }
    }
  };
}

function printMeta(text: string): void {
  console.log("");
  console.log("status");
  console.log("  " + text);
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if ((current + " " + word).trim().length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function formatMs(value: number): string {
  if (value < 1000) {
    return String(value) + "ms";
  }

  return (value / 1000).toFixed(1) + "s";
}
`
    }
  ];
}

function webTemplate(appName: string): TemplateFile[] {
  return [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          name: appName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            dev: "tsx src/server.ts",
            build: "tsc -p tsconfig.json",
            start: "node dist/server.js"
          },
          dependencies: {
            "harness-app-sdk": HARNESS_APP_SDK_VERSION
          },
          devDependencies: {
            "@types/node": "^22.10.2",
            tsx: "^4.19.2",
            typescript: "^5.7.2"
          },
          engines: {
            node: ">=20"
          }
        },
        null,
        2
      )}\n`
    },
    {
      path: "tsconfig.json",
      contents: tsconfig()
    },
    {
      path: "README.md",
      contents: `# ${appName}\n\nA chat-style Harness App SDK web demo that streams from local AI accounts. No API keys.\n\n## Run\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\nOpen http://localhost:3000. Pick a local provider, send a prompt, and watch the assistant bubble fill as chunks arrive.\n`
    },
    {
      path: "src/server.ts",
      contents: `import { createServer, type IncomingMessage } from "node:http";
import {
  createHarnessClient,
  HarnessSdkError,
  type ProviderSelector
} from "harness-app-sdk";

const harness = createHarnessClient();
const port = Number(process.env.PORT || 3000);
const providers = new Set<ProviderSelector>(["auto", "claude", "codex", "copilot", "gemini", "wp-studio"]);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page());
    return;
  }

  if (request.method === "POST" && request.url === "/api/run") {
    let payload: unknown;

    try {
      payload = JSON.parse((await readBody(request)) || "{}");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Request body must be valid JSON.");
      return;
    }

    const prompt = readPrompt(payload);
    const provider = readProvider(payload);

    if (!prompt) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Prompt is required.");
      return;
    }

    let wroteChunk = false;

    try {
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/plain; charset=utf-8",
        "x-accel-buffering": "no"
      });

      const result = await harness.run({
        provider,
        prompt,
        stream: true,
        onEvent(event) {
          if (event.type === "chunk" && event.text) {
            wroteChunk = true;
            response.write(event.text);
          }
        }
      });

      if (!wroteChunk) {
        response.write(result.text);
      }

      response.end();
    } catch (error) {
      const message = error instanceof HarnessSdkError ? error.message : "Unexpected Harness error.";

      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }

      response.end(message);
    }

    return;
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(port, () => {
  console.log(\`Harness chat demo running at http://localhost:\${port}\`);
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");

      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function readPrompt(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("prompt" in payload)) {
    return "";
  }

  const value = (payload as { prompt?: unknown }).prompt;
  return typeof value === "string" ? value.trim() : "";
}

function readProvider(payload: unknown): ProviderSelector {
  if (!payload || typeof payload !== "object" || !("provider" in payload)) {
    return "auto";
  }

  const value = (payload as { provider?: unknown }).provider;
  return typeof value === "string" && providers.has(value as ProviderSelector)
    ? (value as ProviderSelector)
    : "auto";
}

function page(): string {
  return \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Harness Chat</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #161a17;
      --muted: #68736c;
      --line: #d8ded5;
      --paper: #fbfcf8;
      --panel: #eef4ee;
      --brand: #123c35;
      --brand-2: #e95537;
      --bubble: #ffffff;
      --bubble-user: #123c35;
      --focus: #f3b23c;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--paper);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button,
    textarea {
      font: inherit;
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
    }

    .sidebar {
      background: var(--brand);
      color: white;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 28px;
    }

    .mark {
      display: grid;
      gap: 10px;
    }

    .eyebrow {
      color: rgba(255, 255, 255, 0.7);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: clamp(34px, 5vw, 54px);
      line-height: 0.95;
      letter-spacing: 0;
    }

    .sidebar p {
      margin: 18px 0 0;
      color: rgba(255, 255, 255, 0.76);
      line-height: 1.5;
      overflow-wrap: anywhere;
    }

    .provider-list {
      display: grid;
      gap: 8px;
    }

    .provider-list label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 8px;
      padding: 9px 10px;
      cursor: pointer;
      color: rgba(255, 255, 255, 0.82);
    }

    .provider-list input {
      accent-color: var(--focus);
    }

    .provider-list span {
      font-size: 13px;
    }

    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-height: 100vh;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(251, 252, 248, 0.88);
      backdrop-filter: blur(12px);
    }

    .topbar strong {
      display: block;
      font-size: 15px;
    }

    .status {
      min-width: 120px;
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }

    .messages {
      overflow-y: auto;
      padding: 26px min(6vw, 56px);
      display: grid;
      align-content: start;
      gap: 18px;
    }

    .message {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      max-width: 880px;
    }

    .message.user {
      margin-left: auto;
      flex-direction: row-reverse;
    }

    .avatar {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--panel);
      color: var(--brand);
      font-size: 12px;
      font-weight: 800;
    }

    .user .avatar {
      background: #f9d06a;
      color: #2a2107;
    }

    .bubble {
      max-width: min(680px, 72vw);
      border: 1px solid var(--line);
      border-radius: 16px 16px 16px 6px;
      background: var(--bubble);
      padding: 14px 16px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      box-shadow: 0 16px 40px rgba(18, 60, 53, 0.08);
    }

    .user .bubble {
      border-color: var(--bubble-user);
      border-radius: 16px 16px 6px 16px;
      background: var(--bubble-user);
      color: white;
      box-shadow: none;
    }

    .assistant.streaming .bubble::after {
      content: "";
      display: inline-block;
      width: 7px;
      height: 1em;
      margin-left: 3px;
      transform: translateY(2px);
      background: var(--brand-2);
      animation: blink 1s steps(2, start) infinite;
    }

    .assistant.error .bubble {
      border-color: #ef8b72;
      background: #fff3ef;
    }

    .composer {
      border-top: 1px solid var(--line);
      background: white;
      padding: 18px 24px 22px;
    }

    form {
      max-width: 980px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: end;
    }

    textarea {
      min-height: 64px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid #cbd6ce;
      border-radius: 8px;
      padding: 13px 14px;
      color: var(--ink);
      background: #fbfcf8;
      line-height: 1.45;
      outline: none;
    }

    textarea:focus {
      border-color: var(--focus);
      box-shadow: 0 0 0 3px rgba(243, 178, 60, 0.18);
    }

    button {
      min-height: 48px;
      border: 0;
      border-radius: 8px;
      padding: 0 18px;
      background: var(--brand-2);
      color: white;
      cursor: pointer;
      font-weight: 800;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    @keyframes blink {
      50% {
        opacity: 0;
      }
    }

    @media (max-width: 760px) {
      .app {
        grid-template-columns: 1fr;
      }

      .sidebar {
        min-height: auto;
        gap: 20px;
        padding: 22px;
      }

      .sidebar p,
      .provider-list {
        max-width: 330px;
      }

      .provider-list {
        grid-template-columns: 1fr;
      }

      .topbar {
        align-items: flex-start;
        flex-direction: column;
        gap: 6px;
        padding: 14px 16px;
      }

      .status {
        min-width: 0;
        text-align: left;
      }

      .messages {
        padding: 20px 14px;
      }

      .bubble {
        max-width: 58vw;
      }

      form {
        grid-template-columns: 1fr;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="mark">
        <div class="eyebrow">Harness App SDK</div>
        <h1>Local AI chat</h1>
        <p>Extend Harness with local AI accounts. No API keys.</p>
      </div>
      <div class="provider-list" aria-label="Provider">
        <label><span>Auto</span><input type="radio" name="provider" value="auto" form="chat-form" checked></label>
        <label><span>Claude</span><input type="radio" name="provider" value="claude" form="chat-form"></label>
        <label><span>Codex</span><input type="radio" name="provider" value="codex" form="chat-form"></label>
        <label><span>Copilot</span><input type="radio" name="provider" value="copilot" form="chat-form"></label>
        <label><span>Gemini</span><input type="radio" name="provider" value="gemini" form="chat-form"></label>
        <label><span>WP Studio</span><input type="radio" name="provider" value="wp-studio" form="chat-form"></label>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <strong>Streaming harness</strong>
          <span>Claude, Codex, Copilot, Gemini, or WP Studio</span>
        </div>
        <div class="status" id="status">Ready</div>
      </header>

      <section class="messages" id="messages" role="log" aria-live="polite" aria-label="Chat transcript">
        <div class="message assistant">
          <div class="avatar">HK</div>
          <div class="bubble">Ask about this project, draft an action plan, or route a task through one of your local AI CLIs.</div>
        </div>
      </section>

      <div class="composer">
        <form id="chat-form">
          <textarea id="prompt" name="prompt" spellcheck="true">Explain how this app extends Harness without API keys.</textarea>
          <button id="send" type="submit">Send</button>
        </form>
      </div>
    </main>
  </div>

  <script>
    const form = document.querySelector("#chat-form");
    const prompt = document.querySelector("#prompt");
    const messages = document.querySelector("#messages");
    const status = document.querySelector("#status");
    const send = document.querySelector("#send");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const text = prompt.value.trim();

      if (!text) {
        prompt.focus();
        return;
      }

      const provider = new FormData(form).get("provider") || "auto";
      addMessage("user", "You", text);
      prompt.value = "";
      send.disabled = true;
      status.textContent = "Streaming";

      const assistant = addMessage("assistant streaming", "HK", "");

      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: text, provider })
        });

        await streamIntoBubble(response, assistant.bubble);

        if (!response.ok) {
          assistant.message.classList.add("error");
        }

        assistant.message.classList.remove("streaming");
        status.textContent = response.ok ? "Ready" : "Needs attention";
      } catch (error) {
        assistant.message.classList.remove("streaming");
        assistant.message.classList.add("error");
        assistant.bubble.textContent = error instanceof Error ? error.message : "Request failed.";
        status.textContent = "Needs attention";
      } finally {
        send.disabled = false;
        prompt.focus();
      }
    });

    async function streamIntoBubble(response, bubble) {
      if (!response.body) {
        bubble.textContent = await response.text();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const result = await reader.read();

        if (result.done) {
          break;
        }

        bubble.textContent += decoder.decode(result.value, { stream: true });
        messages.scrollTop = messages.scrollHeight;
      }
    }

    function addMessage(role, initials, text) {
      const message = document.createElement("div");
      message.className = "message " + role;

      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials;

      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;

      message.append(avatar, bubble);
      messages.append(message);
      messages.scrollTop = messages.scrollHeight;

      return { message, bubble };
    }
  </script>
</body>
</html>\`;
}
`
    }
  ];
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist"
      },
      include: ["src/**/*.ts"]
    },
    null,
    2
  )}\n`;
}

function normalizePackageName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
