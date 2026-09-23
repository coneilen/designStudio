import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { withOwnedProbe } from "./owned-probe.js";

const probe = fileURLToPath(
  new URL(
    "./installation-fixtures/browser-inventory-probe.mjs",
    import.meta.url,
  ),
);
function cases() {
  const files = Array.from({ length: 299 }, (_, index) => ({
    path: `browser/file-${index}`,
    byteLength: 0,
    sha256: "1".repeat(64),
  }));
  const good = { playwright: "1.63.0", files };
  const padding = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(good));
  return [
    { name: "valid 299 files", value: good, padding: 0, accepted: true },
    { name: "exact 8 MiB", value: good, padding, accepted: true },
    {
      name: "8 MiB plus one",
      value: good,
      padding: padding + 1,
      accepted: false,
      bounds: true,
    },
    ...[
      { name: "null inventory", value: null },
      { name: "array inventory", value: [] },
      {
        name: "non-array files",
        value: { playwright: "1.63.0", files: { length: 299 } },
      },
      { name: "missing file", value: { ...good, files: files.slice(1) } },
      {
        name: "extra duplicate file",
        value: { ...good, files: [...files, files[0]] },
      },
      {
        name: "path traversal",
        value: {
          ...good,
          files: files.map((file, i) =>
            i ? file : { ...file, path: "../escape" },
          ),
        },
      },
      {
        name: "case collision",
        value: {
          ...good,
          files: files.map((file, i) =>
            i ? file : { ...file, path: "browser/FILE-1" },
          ),
        },
      },
      {
        name: "negative file size",
        value: {
          ...good,
          files: files.map((file, i) =>
            i ? file : { ...file, byteLength: -1 },
          ),
        },
      },
      {
        name: "oversized file",
        value: {
          ...good,
          files: files.map((file, i) =>
            i ? file : { ...file, byteLength: 512 * 1024 * 1024 + 1 },
          ),
        },
      },
      {
        name: "aggregate overflow",
        value: {
          ...good,
          files: files.map((file) => ({
            ...file,
            byteLength: 512 * 1024 * 1024,
          })),
        },
      },
      {
        name: "invalid hash",
        value: {
          ...good,
          files: files.map((file, i) =>
            i ? file : { ...file, sha256: "bad" },
          ),
        },
      },
      {
        name: "null file",
        value: { ...good, files: files.map((file, i) => (i ? file : null)) },
      },
    ].map((entry) => ({ ...entry, padding: 0, accepted: false })),
  ];
}
test.for(cases())(
  "validates browser inventory $name before path traversal or copying",
  async (scenario, { signal }) => {
    await withOwnedProbe(signal, async (root, run) => {
      const filename = path.join(root, "browser.json");
      await writeFile(
        filename,
        JSON.stringify(scenario.value) + " ".repeat(scenario.padding),
      );
      const result = JSON.parse((await run([probe, filename])).stdout);
      if (scenario.accepted)
        expect(result).toEqual({ status: "accepted", files: 299 });
      else
        expect(result).toMatchObject({
          status: "rejected",
          ...("bounds" in scenario && scenario.bounds
            ? { message: expect.stringMatching(/bounds/) }
            : {}),
        });
    });
  },
);
