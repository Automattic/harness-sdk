# harness-kit

Extend Harness with local AI accounts. No API keys.

```sh
npm install harness-kit
```

```ts
import { createHarnessClient } from "harness-kit";

const harness = createHarnessClient();
const result = await harness.run({
  prompt: "Explain the current project."
});

console.log(result.text);
```
