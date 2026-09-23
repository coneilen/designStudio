import { expect, it } from "vitest";
import { assertUnitPartition } from "../../../tests/unit-partition.js";

const native = "packages/synthetic/tests/native.test.ts";
const portable = "packages/synthetic/tests/pure.test.ts";
it("keeps new unit files portable and partitions all original coverage exactly once", () => {
  const added = "packages/new/tests/addition.test.ts";
  expect(
    assertUnitPartition(
      [native, portable, added],
      [portable, added],
      [native],
      [native],
    ),
  ).toEqual({ original: 3, portable: 2, native: 1 });
});
it.each([
  [[native, portable], [portable], [], [native]],
  [[native, portable], [native, portable], [native], [native]],
  [[native, portable], [], [native], [native]],
  [[native, portable], [portable], [native, native], [native]],
  [[native, portable], [portable], [native], [native, native]],
  [[portable], [portable], [native], [native]],
  [[native, portable], [portable], [native], ["packages/**/*.test.ts"]],
  [
    ["packages/a/tests/package.smoke.test.ts"],
    [],
    ["packages/a/tests/package.smoke.test.ts"],
    ["packages/a/tests/package.smoke.test.ts"],
  ],
])(
  "rejects absent, duplicate, overlapping, wildcard or smoke membership %#",
  (all, unit, hardware, list) => {
    expect(() => assertUnitPartition(all, unit, hardware, list)).toThrow();
  },
);
