# create-harness-app

Scaffold a Harness App SDK demo app with streaming local-provider examples.

```sh
npx create-harness-app my-app
npx create-harness-app my-app --template cli
npx create-harness-app my-app --template web
```

Generated apps use local Claude, Codex, Copilot, Gemini, or WP Studio accounts
through `harness-app-sdk`. No provider API keys are required. CLI and web
templates stream model output as it arrives.

## Templates

- `cli`: a TypeScript terminal chat that accepts `--provider` and prints streamed
  assistant chunks as a transcript.
- `web`: a local Node server with a chat-style browser UI, provider picker, and
  live assistant bubbles backed by streamed HTTP responses.
