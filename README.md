# Harness App SDK

Extend Harness with local AI accounts. No API keys.

Harness App SDK is a TypeScript SDK for apps that want to call installed coding
agents such as Claude Code, Codex CLI, and GitHub Copilot CLI through the
accounts developers already use on their machines.

## Packages

- `harness-app-sdk`: SDK for detecting and running local AI providers.
- `create-harness-app`: scaffolder for demo apps powered by `harness-app-sdk`.

## Create a Demo

```sh
npx create-harness-app my-app
npx create-harness-app my-app --template cli
npx create-harness-app my-app --template web
```

## SDK Usage

```ts
import { createHarnessClient } from "harness-app-sdk";

const harness = createHarnessClient();
const status = await harness.detect();

console.log(status);

await harness.run({
  prompt: "Summarize this project in one paragraph.",
  stream: true,
  onEvent(event) {
    if (event.type === "chunk" && event.text) {
      process.stdout.write(event.text);
    }
  }
});
```

## Local Accounts, Not API Keys

Harness App SDK shells out to local CLIs with conservative defaults. It does not
ask users to paste provider API keys, and it does not store secrets. If a
provider is missing or logged out, Harness App SDK returns a provider-specific
message that points the user back to the local CLI login flow.

The SDK currently supports Claude Code, Codex CLI, GitHub Copilot CLI, and
Gemini CLI.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run pack:dry-run
```
