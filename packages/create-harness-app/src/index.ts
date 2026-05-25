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

const HARNESS_APP_SDK_VERSION = "^0.1.2";

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
      contents: `# ${appName}\n\nA Harness App SDK CLI demo that uses local AI accounts. No API keys.\n\n## Run\n\n\`\`\`sh\nnpm install\nnpm run dev -- \"Say hello from Harness\"\n\`\`\`\n`
    },
    {
      path: "src/index.ts",
      contents: `import { createHarnessClient, HarnessSdkError } from "harness-app-sdk";\n\nconst prompt = process.argv.slice(2).join(" ") || "Say hello from Harness.";\nconst harness = createHarnessClient();\nlet wroteChunk = false;\n\ntry {\n  const result = await harness.run({\n    prompt,\n    stream: true,\n    onEvent(event) {\n      if (event.type === "chunk" && event.text) {\n        wroteChunk = true;\n        process.stdout.write(event.text);\n      }\n    }\n  });\n\n  if (!wroteChunk) {\n    console.log(result.text);\n  } else if (!result.text.endsWith("\\n")) {\n    process.stdout.write("\\n");\n  }\n} catch (error) {\n  if (error instanceof HarnessSdkError) {\n    console.error(error.message);\n    process.exitCode = 1;\n  } else {\n    throw error;\n  }\n}\n`
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
      contents: `# ${appName}\n\nA Harness App SDK web demo that uses local AI accounts. No API keys.\n\n## Run\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\nOpen http://localhost:3000.\n`
    },
    {
      path: "src/server.ts",
      contents: `import { createServer, type IncomingMessage } from "node:http";\nimport { createHarnessClient, HarnessSdkError } from "harness-app-sdk";\n\nconst harness = createHarnessClient();\nconst port = Number(process.env.PORT || 3000);\n\nconst server = createServer(async (request, response) => {\n  if (request.method === "GET" && request.url === "/") {\n    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });\n    response.end(page());\n    return;\n  }\n\n  if (request.method === "POST" && request.url === "/api/run") {\n    const body = await readBody(request);\n    const prompt = String(JSON.parse(body || "{}").prompt || "").trim();\n\n    if (!prompt) {\n      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });\n      response.end("Prompt is required.");\n      return;\n    }\n\n    let wroteChunk = false;\n\n    try {\n      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });\n      const result = await harness.run({\n        prompt,\n        stream: true,\n        onEvent(event) {\n          if (event.type === "chunk" && event.text) {\n            wroteChunk = true;\n            response.write(event.text);\n          }\n        }\n      });\n\n      if (!wroteChunk) {\n        response.write(result.text);\n      }\n\n      response.end();\n    } catch (error) {\n      const message = error instanceof HarnessSdkError ? error.message : "Unexpected Harness error.";\n\n      if (!response.headersSent) {\n        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });\n      }\n\n      response.end(message);\n    }\n\n    return;\n  }\n\n  response.writeHead(404);\n  response.end("Not found");\n});\n\nserver.listen(port, () => {\n  console.log(\`Harness demo running at http://localhost:\${port}\`);\n});\n\nfunction readBody(request: IncomingMessage): Promise<string> {\n  return new Promise((resolve, reject) => {\n    let body = "";\n    request.on("data", (chunk) => {\n      body += chunk;\n    });\n    request.on("end", () => resolve(body));\n    request.on("error", reject);\n  });\n}\n\nfunction page(): string {\n  return \`<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Harness App SDK Demo</title>\n  <style>\n    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f2; color: #171717; }\n    main { max-width: 760px; margin: 0 auto; padding: 48px 20px; }\n    h1 { font-size: 36px; line-height: 1.1; margin: 0 0 12px; }\n    p { color: #4a4a44; }\n    form { display: grid; gap: 12px; margin-top: 28px; }\n    textarea { min-height: 140px; padding: 14px; border: 1px solid #c9c8bd; border-radius: 8px; font: inherit; resize: vertical; }\n    button { width: fit-content; padding: 10px 14px; border: 0; border-radius: 8px; background: #171717; color: white; font: inherit; cursor: pointer; }\n    pre { white-space: pre-wrap; background: #ffffff; border: 1px solid #dcdbd2; border-radius: 8px; padding: 16px; min-height: 120px; }\n  </style>\n</head>\n<body>\n  <main>\n    <h1>Harness App SDK Demo</h1>\n    <p>Extend Harness with local AI accounts. No API keys.</p>\n    <form id="form">\n      <textarea id="prompt">Say hello from Harness.</textarea>\n      <button>Run with local account</button>\n    </form>\n    <pre id="output"></pre>\n  </main>\n  <script>\n    const form = document.querySelector("#form");\n    const prompt = document.querySelector("#prompt");\n    const output = document.querySelector("#output");\n\n    form.addEventListener("submit", async (event) => {\n      event.preventDefault();\n      output.textContent = "";\n      const response = await fetch("/api/run", {\n        method: "POST",\n        headers: { "content-type": "application/json" },\n        body: JSON.stringify({ prompt: prompt.value })\n      });\n      const reader = response.body.getReader();\n      const decoder = new TextDecoder();\n\n      while (true) {\n        const { done, value } = await reader.read();\n\n        if (done) {\n          break;\n        }\n\n        output.textContent += decoder.decode(value, { stream: true });\n      }\n    });\n  </script>\n</body>\n</html>\`;\n}\n`
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
