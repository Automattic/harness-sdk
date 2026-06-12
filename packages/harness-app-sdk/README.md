# harness-app-sdk

Extend Harness with SDK-backed AI providers.

Supports Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI, OpenCode, and
WP Studio behind one provider API.

OpenCode is called through `@opencode-ai/sdk`; that SDK starts the local
`opencode serve` runtime, so the `opencode` executable still needs to be
available on `PATH`.

```sh
npm install harness-app-sdk
```

```ts
import { createHarnessClient } from "harness-app-sdk";

const harness = createHarnessClient();
const result = await harness.run({
  prompt: "Explain the current project.",
  args: ["--debug"],
  stream: true,
  onEvent(event) {
    if (event.type === "chunk" && event.text) {
      process.stdout.write(event.text);
    }
  }
});

if (!result.text) {
  console.log("No response text received.");
}
```
