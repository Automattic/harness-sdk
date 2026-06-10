import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHarnessApp } from "../src/index.js";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const tscBin = resolve(repoRoot, "node_modules/typescript/bin/tsc");
const harnessAppSdkSource = resolve(repoRoot, "packages/harness-app-sdk/src/index.ts");
const nodeTypeRoots = resolve(repoRoot, "node_modules/@types");

describe("createHarnessApp", () => {
  it("creates a TypeScript CLI demo", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-cli-"));
    const directory = join(root, "demo-cli");

    const result = await createHarnessApp({
      appName: "Demo CLI",
      directory,
      template: "cli"
    });

    expect(result.template).toBe("cli");
    expect(result.appName).toBe("demo-cli");
    expect(result.files).toContain("src/index.ts");

    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies["harness-app-sdk"]).toBe("^0.1.6");
    await expect(stat(join(directory, "tsconfig.json"))).resolves.toBeTruthy();

    const cli = await readFile(join(directory, "src/index.ts"), "utf8");

    expect(cli).toContain("createStreamingBubbleWriter");
    expect(cli).toContain("--provider");
    expect(cli).toContain("stream: true");
  });

  it("creates a web demo with a local Node server", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-web-"));
    const directory = join(root, "demo-web");

    await createHarnessApp({
      appName: "demo-web",
      directory,
      template: "web"
    });

    const server = await readFile(join(directory, "src/server.ts"), "utf8");

    expect(server).toContain("createServer");
    expect(server).toContain("createHarnessClient");
    expect(server).toContain("response.write(event.text)");
    expect(server).toContain("SDK-backed providers");
    expect(server).toContain('role="log"');
    expect(server).toContain("class=\"bubble\"");
    expect(server).toContain("provider");
    expect(server).toContain("streamIntoBubble");
  });

  it("generates templates that typecheck against the SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-template-build-"));

    for (const template of ["cli", "web"] as const) {
      const directory = join(root, template);

      await createHarnessApp({
        appName: `demo-${template}`,
        directory,
        template
      });

      await patchTsconfigForLocalSdk(directory);
      await execFileAsync(process.execPath, [tscBin, "-p", "tsconfig.json", "--noEmit"], {
        cwd: directory,
        timeout: 20_000
      });
    }
  });

  it("refuses to write into non-empty directories unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-existing-"));
    const directory = join(root, "demo");

    await createHarnessApp({
      appName: "demo",
      directory,
      template: "cli"
    });

    await expect(
      createHarnessApp({
        appName: "demo",
        directory,
        template: "web"
      })
    ).rejects.toThrow("is not empty");

    await expect(
      createHarnessApp({
        appName: "demo",
        directory,
        template: "web",
        force: true
      })
    ).resolves.toMatchObject({ template: "web" });
  });
});

async function patchTsconfigForLocalSdk(directory: string): Promise<void> {
  const tsconfigPath = join(directory, "tsconfig.json");
  const tsconfig = JSON.parse(await readFile(tsconfigPath, "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };

  tsconfig.compilerOptions.baseUrl = ".";
  tsconfig.compilerOptions.paths = {
    "harness-app-sdk": [harnessAppSdkSource]
  };
  tsconfig.compilerOptions.typeRoots = [nodeTypeRoots];

  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
}
