import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { withOwnedProbe } from "./owned-probe.js";

const probe = fileURLToPath(
  new URL("./installation-fixtures/admission-probe.mjs", import.meta.url),
);
async function manifest(directory: string, value: object): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(value));
}

test.for([
  "../../../escaped-package",
  "..\\escaped-package",
  "absolute-path",
  "/absolute",
  "@scope/../../escaped-package",
  "@scope\\escaped",
  "Uppercase",
  "@Scope/name",
  ".",
  "..",
  "@scope/name/extra",
  "con",
  "@scope/nul.txt",
  "trailing.",
  "percent%2fescape",
])(
  "rejects untrusted package name %s before any candidate allocation can escape",
  async (input, { signal }) => {
    await withOwnedProbe(signal, async (root, run) => {
      const name =
        input === "absolute-path" ? path.join(root, "absolute") : input;
      const workspace = path.join(root, "workspace");
      const destination = path.join(
        root,
        "candidate",
        "payload",
        "node_modules",
      );
      await mkdir(destination, { recursive: true });
      const sentinel = path.join(root, "sentinel.txt");
      await writeFile(sentinel, "untouched");
      await manifest(path.join(workspace, "packages", "root"), {
        name,
        version: "1.0.0",
      });
      const result = JSON.parse(
        (await run([probe, workspace, destination])).stdout,
      );
      expect(result).toMatchObject({
        status: "rejected",
        blocked: 0,
        message: expect.stringMatching(/package name/i),
      });
      expect(await readdir(destination)).toEqual([]);
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
    });
  },
);

const cases = [
  {
    name: "invalid dependency key",
    root: { dependencies: { "../../escape": "1" } },
    message: /package name/i,
  },
  {
    name: "invalid optional dependency key",
    root: { optionalDependencies: { "../linux-escape": "1" } },
    message: /package name/i,
  },
  {
    name: "resolved name mismatch",
    dependency: { name: "different" },
    message: /requested.*name/i,
  },
  ...[
    "../../dependency-escape",
    "@scope/../escape",
    "bad\\name",
    "UPPERCASE",
  ].map((name) => ({
    name: `invalid resolved name ${name}`,
    dependency: { name },
    message: /package name/i,
  })),
  {
    name: "invalid transitive dependency key",
    dependency: {
      name: "wanted",
      dependencies: { "@scope/../../escape": "1" },
    },
    message: /package name/i,
  },
  {
    name: "duplicate workspace name",
    other: "safe-root",
    message: /duplicate/i,
  },
  {
    name: "invalid other workspace name",
    other: "SAFE-ROOT",
    message: /package name/i,
  },
];
test.for(cases)(
  "rejects $name without allocating outside the empty destination",
  async (scenario, { signal }) => {
    await withOwnedProbe(signal, async (root, run) => {
      const workspace = path.join(root, "workspace");
      const packageRoot = path.join(workspace, "packages", "root");
      const destination = path.join(root, "candidate", "node_modules");
      const sentinel = path.join(root, "sentinel.txt");
      await mkdir(destination, { recursive: true });
      await writeFile(sentinel, "untouched");
      await manifest(packageRoot, {
        name: "safe-root",
        version: "1.0.0",
        ...("root" in scenario
          ? scenario.root
          : "dependency" in scenario
            ? { dependencies: { wanted: "1" } }
            : {}),
      });
      if ("dependency" in scenario)
        await manifest(path.join(packageRoot, "node_modules", "wanted"), {
          version: "1.0.0",
          ...scenario.dependency,
        });
      if ("other" in scenario)
        await manifest(path.join(workspace, "packages", "other"), {
          name: scenario.other,
          version: "1.0.0",
        });
      const result = JSON.parse(
        (await run([probe, workspace, destination])).stdout,
      );
      expect(result).toMatchObject({
        status: "rejected",
        blocked: 0,
        message: expect.stringMatching(scenario.message),
      });
      expect(await readdir(destination)).toEqual([]);
      expect(await readFile(sentinel, "utf8")).toBe("untouched");
    });
  },
);

test("canonical scoped dependencies materialize only inside the exact candidate node_modules", async ({
  signal,
}) => {
  await withOwnedProbe(signal, async (root, run) => {
    const workspace = path.join(root, "workspace");
    const packageRoot = path.join(workspace, "packages", "root");
    const destination = path.join(root, "candidate", "node_modules");
    await mkdir(destination, { recursive: true });
    await manifest(packageRoot, {
      name: "safe-root",
      version: "1.0.0",
      files: [],
      dependencies: { "@scope/safe.name": "1" },
    });
    await manifest(
      path.join(packageRoot, "node_modules", "@scope", "safe.name"),
      {
        name: "@scope/safe.name",
        version: "1.0.0",
      },
    );
    expect(
      JSON.parse((await run([probe, workspace, destination])).stdout),
    ).toEqual({ status: "copied", blocked: 0 });
    expect(
      JSON.parse(
        await readFile(
          path.join(destination, "@scope", "safe.name", "package.json"),
          "utf8",
        ),
      ).name,
    ).toBe("@scope/safe.name");
  });
});

test("capture and importer workspace dependencies have a physical runtime closure without source fallback", async ({
  signal,
}) => {
  await withOwnedProbe(signal, async (root, run) => {
    const workspace = path.join(root, "workspace");
    const destination = path.join(root, "candidate", "node_modules");
    await manifest(path.join(workspace, "packages", "root"), {
      name: "safe-root",
      version: "1.0.0",
      files: [],
      dependencies: { "@design-studio/figma-capture": "workspace:*" },
    });
    for (const name of ["figma-capture", "figma-import"]) {
      const directory = path.join(workspace, "packages", name);
      await manifest(directory, {
        name: `@design-studio/${name}`,
        version: "1.0.0",
        type: "module",
        files: ["dist"],
        exports: { ".": "./dist/index.js" },
        ...(name === "figma-capture"
          ? { dependencies: { "@design-studio/figma-import": "workspace:*" } }
          : {}),
      });
      await mkdir(path.join(directory, "dist"));
      await writeFile(
        path.join(directory, "dist", "index.js"),
        name === "figma-capture"
          ? 'export { marker } from "@design-studio/figma-import";'
          : 'export const marker = "synthetic-physical-closure";',
      );
    }
    expect(
      JSON.parse((await run([probe, workspace, destination])).stdout),
    ).toEqual({ status: "copied", blocked: 0 });
    const result = await run(
      [
        "--input-type=module",
        "-e",
        'const value = await import("@design-studio/figma-capture"); process.stdout.write(value.marker);',
      ],
      {
        cwd: path.dirname(destination),
        env: {},
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.stdout).toBe("synthetic-physical-closure");
    for (const name of ["figma-capture", "figma-import"])
      expect(
        await readdir(path.join(destination, "@design-studio", name)),
      ).toEqual(["dist", "package.json"]);
  });
});
