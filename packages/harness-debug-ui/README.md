# Harness Debug UI

Private local workbench for developing `harness-app-sdk` provider adapters.

```sh
npm run debug:ui
```

Open http://localhost:4211.

The UI uses the workspace SDK directly and exposes provider detection, streaming
events, stdout/stderr, final results, extra args, model, cwd, env overrides,
timeout, edit mode, and request aborts.
