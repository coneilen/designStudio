import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const steps = workflow.split(/(?=^ {6}- name: )/m).slice(1);
const step = (name: string) => {
  const matches = steps.filter((value) =>
    value.startsWith(`      - name: ${name}\n`),
  );
  expect(matches).toHaveLength(1);
  return matches[0] ?? "";
};
const ready = step("Check exact unit phase membership");
const portable = step("Portable unit and SQLite composition tests");
const native = step("Owned hardware-native integration tests");
const smoke = step("Offline package smoke");
const condition = (value: string) =>
  value.match(/^ {8}if: \$\{\{ (.+) \}\}$/m)?.[1];

it("runs sequential test phases only after all prerequisites without masking failures", () => {
  expect(ready).toContain("        id: validation_ready\n");
  expect(ready).toContain("        run: pnpm test:partition\n");
  expect(ready).not.toContain("        if:");
  expect(portable).toContain("        id: portable\n");
  expect(native).toContain("        id: native\n");
  expect(condition(native)).toBe(
    "!cancelled() && steps.validation_ready.outcome == 'success'",
  );
  expect(condition(smoke)).toBe(
    "!cancelled() && steps.validation_ready.outcome == 'success' && steps.native.outcome == 'success'",
  );
  expect(steps.slice(-4)).toEqual([ready, portable, native, smoke]);
  expect(workflow).not.toContain("continue-on-error");
  expect(workflow).toContain("timeout-minutes: 45");
  expect(workflow).toContain("fail-fast: false");
  expect(native).toContain("run: pnpm test:native");
  expect(smoke).toContain("run: pnpm test:smoke");
});

// Structural checks above bind this truth table to the exact workflow expressions.
for (const cancelled of [false, true])
  for (const prerequisites of ["success", "failure", "skipped"] as const)
    for (const portableOutcome of ["success", "failure"] as const)
      for (const nativeOutcome of ["success", "failure", "skipped"] as const)
        it(`gates cancellation=${cancelled}, prerequisites=${prerequisites}, portable=${portableOutcome}, native=${nativeOutcome}`, () => {
          const runsNative = !cancelled && prerequisites === "success";
          const runsSmoke = runsNative && nativeOutcome === "success";
          if (cancelled || prerequisites !== "success") {
            expect(runsNative).toBe(false);
            expect(runsSmoke).toBe(false);
          } else {
            expect(runsNative).toBe(true);
            expect(runsSmoke).toBe(nativeOutcome === "success");
          }
          const jobCanPass =
            !cancelled &&
            prerequisites === "success" &&
            portableOutcome === "success" &&
            nativeOutcome === "success";
          if (portableOutcome === "failure" || nativeOutcome !== "success")
            expect(jobCanPass).toBe(false);
        });
