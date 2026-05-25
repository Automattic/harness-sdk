#!/usr/bin/env node
import { createHarnessApp, type HarnessTemplate } from "./index.js";

interface ParsedArgs {
  appName?: string;
  template?: HarnessTemplate;
  force: boolean;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.appName) {
    printHelp();
    process.exitCode = args.appName ? 0 : 1;
    return;
  }

  const result = await createHarnessApp({
    appName: args.appName,
    directory: args.appName,
    template: args.template,
    force: args.force
  });

  console.log(`Created ${result.template} Harness app in ${result.directory}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${args.appName}`);
  console.log("  npm install");
  console.log("  npm run dev");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    force: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--force") {
      parsed.force = true;
      continue;
    }

    if (arg === "--template" || arg === "-t") {
      const template = argv[index + 1];

      if (template !== "cli" && template !== "web") {
        throw new Error("Expected --template to be either cli or web.");
      }

      parsed.template = template;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--template=")) {
      const template = arg.slice("--template=".length);

      if (template !== "cli" && template !== "web") {
        throw new Error("Expected --template to be either cli or web.");
      }

      parsed.template = template;
      continue;
    }

    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    parsed.appName = arg;
  }

  return parsed;
}

function printHelp(): void {
  console.log(`create-harness-app

Create a Harness App SDK demo app that uses local AI accounts. No API keys.

Usage:
  npx create-harness-app <app-name>
  npx create-harness-app <app-name> --template cli
  npx create-harness-app <app-name> --template web

Options:
  -t, --template <cli|web>  Choose the generated demo template.
  --force                  Write into a non-empty directory.
  -h, --help               Show help.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
