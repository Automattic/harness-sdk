<div align="center">

<img src="./assets/harness-sdk-icon.svg" width="96" height="96" alt="Harness SDK icon">

# Harness App SDK

**Extend Harness with SDK-backed AI providers.**

Build apps and tools that talk to the AI coding agents developers already use:
Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI, and WP Studio.

[![npm: harness-app-sdk](https://img.shields.io/npm/v/harness-app-sdk?label=harness-app-sdk)](https://www.npmjs.com/package/harness-app-sdk)
[![npm: create-harness-app](https://img.shields.io/npm/v/create-harness-app?label=create-harness-app)](https://www.npmjs.com/package/create-harness-app)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

## Why Harness App SDK?

Harness App SDK takes a provider-auth-friendly path: it uses official SDKs where
agent SDKs exist, and falls back to local CLIs where a provider only publishes a
CLI surface.

That means your app can:

- run through Claude, Codex, Copilot, Cursor, Gemini, or WP Studio
- avoid provider API keys for local-account providers; Cursor uses `CURSOR_API_KEY`
- detect which providers are installed or configured
- stream model output as it arrives
- keep provider-specific SDK and CLI quirks behind one small TypeScript API

## Packages

| Package | Purpose |
| --- | --- |
| [`harness-app-sdk`](https://www.npmjs.com/package/harness-app-sdk) | TypeScript SDK for detecting and running AI providers. |
| [`create-harness-app`](https://www.npmjs.com/package/create-harness-app) | Scaffolder for chat-style CLI and web demos powered by streamed SDK output. |
| `harness-debug-ui` | Private local workbench for SDK adapter development. |

## Quick Start

Create a demo app:

```sh
npx -y create-harness-app my-app
cd my-app
npm install
npm run dev
```

Choose a template:

```sh
npx -y create-harness-app my-cli --template cli
npx -y create-harness-app my-web --template web
```

The CLI template prints a streaming terminal transcript. The web template runs a
local Node server with a provider picker and live assistant bubbles.

Or install the SDK directly:

```sh
npm install harness-app-sdk
```

## Debug UI

Work on provider adapters with the local debugging workbench:

```sh
npm run debug:ui
```

Open http://localhost:4211 to run providers with custom cwd, model, args, env,
timeouts, streaming, edit mode, detection, aborts, raw events, stdout/stderr,
and final result inspection.

## Basic Usage

```ts
import { createHarnessClient } from "harness-app-sdk";

const harness = createHarnessClient();

const statuses = await harness.detect();
console.log(statuses);

const result = await harness.run({
  prompt: "Summarize this repository in one paragraph."
});

console.log(result.text);
```

## Streaming Output

Harness App SDK keeps `run()` as the main entrypoint. Pass `stream: true` and an
`onEvent` callback to receive output while the provider is still running. The
final promise still resolves with the buffered result.

```ts
import { createHarnessClient } from "harness-app-sdk";

const harness = createHarnessClient();

const result = await harness.run({
  prompt: "Explain the project structure.",
  stream: true,
  onEvent(event) {
    if (event.type === "chunk" && event.text) {
      process.stdout.write(event.text);
    }
  }
});

console.log("\n\nProvider:", result.provider);
```

Callbacks can also be configured once at the client level:

```ts
const harness = createHarnessClient({
  onEvent(event) {
    if (event.type === "stderr" && event.data) {
      process.stderr.write(event.data);
    }
  }
});
```

Request-level callbacks and client-level callbacks are both called when both are
provided.

## Providers

| Provider | Default integration | Notes |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Falls back to `claude` when you pass a custom command, runner, or raw CLI `args`. |
| Codex | `@openai/codex-sdk` | Falls back to `codex exec --json` for custom command, runner, or raw CLI `args`. |
| GitHub Copilot | `@github/copilot-sdk` | Uses SDK auth detection and falls back to `copilot` for custom command, runner, or raw CLI `args`. |
| Cursor | `@cursor/sdk` | Requires `CURSOR_API_KEY`; defaults to `composer-2` when no model is passed. |
| Gemini CLI | `gemini` | No official Gemini CLI agent SDK found; uses `gemini -p ... --output-format stream-json`. |
| WP Studio | `npx -y wp-studio@latest` | WordPress documents Studio as a CLI package; no separate SDK surface found. |

Harness App SDK does not authenticate providers for users. It returns clear
status messages when a provider is missing, logged out, or missing required
configuration.

## Provider Selection

By default, `provider: "auto"` chooses the first available provider that is not
known to be unauthenticated.

```ts
await harness.run({
  provider: "claude",
  prompt: "Write release notes for the latest commits.",
  args: ["--model", "sonnet"]
});
```

Supported provider IDs:

```ts
type ProviderId = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "wp-studio";
```

## API Overview

### `createHarnessClient(options?)`

Creates a client for detecting and running providers.

```ts
const harness = createHarnessClient({
  cwd: process.cwd(),
  defaultProvider: "auto",
  timeoutMs: 120_000,
  onEvent(event) {
    // Optional global event handler.
  }
});
```

### `harness.detect()`

Returns provider status objects:

```ts
type ProviderStatus = {
  id: "claude" | "codex" | "copilot" | "cursor" | "gemini" | "wp-studio";
  name: string;
  command: string;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  message?: string;
};
```

### `harness.run(request)`

Runs a prompt through a provider.

```ts
type HarnessRunRequest = {
  prompt: string;
  provider?: "auto" | "claude" | "codex" | "copilot" | "cursor" | "gemini" | "wp-studio";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  args?: string[];
  timeoutMs?: number;
  allowEdits?: boolean;
  stream?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
};
```

The result includes command metadata, buffered stdout/stderr, normalized text,
duration, timeout state, and abort state.

Use `args` for provider-specific CLI flags that Harness App SDK does not model
directly. SDK-backed providers fall back to their legacy CLI path when raw
`args` are supplied. CLI execution uses `spawn` with `shell: false`, so each flag
and value must be a separate array item:

```ts
await harness.run({
  provider: "gemini",
  prompt: "Review this folder.",
  args: ["--sandbox"]
});
```

### `HarnessEvent`

Streaming and lifecycle callbacks receive normalized events:

```ts
type HarnessEvent =
  | { type: "start"; provider?: ProviderId; command?: string; args?: string[] }
  | { type: "chunk"; provider?: ProviderId; text?: string; data?: string; raw?: unknown }
  | { type: "stdout"; provider?: ProviderId; data?: string }
  | { type: "stderr"; provider?: ProviderId; data?: string }
  | { type: "raw"; provider?: ProviderId; data?: string; raw?: unknown }
  | { type: "exit"; provider?: ProviderId; exitCode?: number | null }
  | { type: "error"; provider?: ProviderId; message?: string; error?: Error };
```

## Safety Defaults

Harness App SDK is designed for local developer tools and conservative defaults.

- CLI fallbacks use `spawn` with `shell: false`.
- It redacts common API key and token patterns from process output.
- It supports timeouts and `AbortSignal`.
- It defaults to read-only or planning modes where providers expose them.
- Elevated edit/tool behavior is opt-in with `allowEdits: true`.

Providers can still perform powerful local actions when users enable them. Apps
embedding this SDK should explain what they are asking the provider to do and
should choose the narrowest permissions that fit the workflow.

## Repository Layout

```text
.
├── packages/
│   ├── harness-app-sdk/      # SDK package
│   └── create-harness-app/   # demo app scaffolder
├── package.json              # npm workspace root
└── vitest.config.ts          # test configuration
```

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run pack:dry-run
```

Live provider smoke tests are opt-in because they require installed CLIs and
authenticated local accounts:

```sh
npm run test:live
```

## Publishing

The repo uses npm workspaces. Publish packages independently:

```sh
npm publish --workspace harness-app-sdk --access public
npm publish --workspace create-harness-app --access public
```

Before publishing, run:

```sh
npm run clean
npm run typecheck
npm test
npm run build
npm run pack:dry-run
```

## Contributing

Issues and pull requests are welcome. Good contributions include:

- new provider adapters
- better stream parsers for provider-specific JSON events
- template improvements
- documentation fixes
- cross-platform smoke-test coverage

Please keep changes small, tested, and aligned with the core promise: local
accounts, no provider API keys.

## License

MIT © Fatih Kadir Akin
