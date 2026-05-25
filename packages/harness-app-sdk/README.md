# harness-app-sdk

Extend Harness with local AI accounts. No API keys.

```sh
npm install harness-app-sdk
```

```ts
import { createHarnessClient } from "harness-app-sdk";

const harness = createHarnessClient();
const result = await harness.run({
  prompt: "Explain the current project."
});

console.log(result.text);
```
