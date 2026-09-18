import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { digest, encodeInventory } from "../src/installation-manifest.js";
import { ownedTest } from "./support.js";

const run = promisify(execFile);
test.skipIf(process.platform !== "win32")(
  "builtin preflight rejects inner tamper/extras and hostile createRequire before any outside code runs",
  async () => {
    await ownedTest(async (root) => {
      const bootstrap = path.join(root, "bootstrap");
      const entry =
        "node_modules/@design-studio/project-host/dist/installation.js";
      const module = path.join(bootstrap, ...entry.split("/"));
      await mkdir(path.dirname(module), { recursive: true });
      const bad = Buffer.from(
        `import{createRequire}from'node:module';createRequire(import.meta.url)(${JSON.stringify(path.join(root, "outside.cjs"))});`,
      );
      await writeFile(module, bad);
      await writeFile(
        path.join(root, "outside.cjs"),
        "throw new Error('OUTSIDE_EXECUTED');",
      );
      const inventory = encodeInventory([
        {
          path: entry.slice("node_modules/".length),
          bytes: bad.length,
          sha256: digest(bad),
        },
      ]);
      await writeFile(
        path.join(bootstrap, "bootstrap-modules.json"),
        inventory,
      );
      const template = await readFile(
        new URL("../bootstrap/preflight.mjs", import.meta.url),
        "utf8",
      );
      await writeFile(
        path.join(bootstrap, "preflight.mjs"),
        template.replace(
          "__REVIEWED_BOOTSTRAP_MODULE_INVENTORY_SHA256__",
          digest(inventory),
        ),
      );
      const runner = path.join(bootstrap, "runner.mjs");
      await writeFile(
        runner,
        "import{preflight}from'./preflight.mjs';await preflight();",
      );
      const execute = async () => {
        try {
          await run(process.execPath, [runner], {
            timeout: 10000,
            maxBuffer: 16384,
            env: { SystemRoot: process.env.SystemRoot },
          });
        } catch (error) {
          if (error && typeof error === "object" && "stderr" in error)
            return String(error.stderr);
          throw error;
        }
        throw new Error("Unexpected successful hostile bootstrap.");
      };
      expect(await execute()).toContain("outside the selected closure");
      expect(await execute()).not.toContain("OUTSIDE_EXECUTED");
      await writeFile(module, "throw new Error('TAMPER_EXECUTED');");
      expect(await execute()).toContain("module identity mismatch");
      await writeFile(module, bad);
      await writeFile(
        path.join(bootstrap, "node_modules", "extra.js"),
        "extra",
      );
      expect(await execute()).toContain("Unexpected bootstrap module");
      await unlink(path.join(bootstrap, "node_modules", "extra.js"));
      await unlink(module);
      expect(await execute()).toContain("module file is missing");
      await writeFile(
        path.join(bootstrap, "bootstrap-modules.json"),
        Buffer.concat([inventory, Buffer.of(32)]),
      );
      expect(await execute()).toContain("inventory differs");
    });
  },
);
