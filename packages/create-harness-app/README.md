# create-harness-app

Scaffold a Harness App SDK demo app with streaming local-provider examples.

```sh
npx -y create-harness-app my-app
npx -y create-harness-app my-app --template cli
npx -y create-harness-app my-app --template web
```

Generated apps use Claude, Codex, Copilot, Cursor, Gemini, or WP Studio through
`harness-app-sdk`. Cursor uses `CURSOR_API_KEY`; the other providers use their
local account or tool authentication. CLI and web templates stream model output
as it arrives.

## Templates

- `cli`: a TypeScript terminal chat that accepts `--provider` and prints streamed
  assistant chunks as a transcript.
- `web`: a local Node server with a chat-style browser UI, provider picker, and
  live assistant bubbles backed by streamed HTTP responses.
