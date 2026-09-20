import { expect, it } from "vitest";
import {
  parseCaptureArguments,
  runCaptureCommand,
} from "../src/capture-main.js";

const id = "00000000-0000-4000-8000-000000000001";
const scope = [
  "--project",
  `capture_${id}`,
  "--confirm-reference",
  `figma_pat_${id}`,
];
it("keeps native metadata help side-effect free and rejects all token-bearing input routes", async () => {
  expect(await runCaptureCommand(["--help"])).toMatchObject({
    status: "complete",
    profile: "figma-capture-v1",
  });
  for (const args of [
    ["credential", "setup", ...scope],
    ["credential", "setup", ...scope, "--interactive", "--json"],
    ["credential", "status", ...scope, "--token", "synthetic"],
    ["credential", "setup", ...scope, "--interactive", "--file", "secret"],
    ["credential", "setup", ...scope, "--stdin"],
    ["credential", "remove", "--project", `capture_${id}`],
    ["project", "create"],
  ])
    expect(() => parseCaptureArguments(args)).toThrow();
});
it("accepts only explicit new-project and exactly confirmed native actions", () => {
  expect(parseCaptureArguments(["project", "create", "--new"])).toEqual({
    command: "project-create",
  });
  expect(
    parseCaptureArguments(["credential", "setup", ...scope, "--interactive"])
      .command,
  ).toBe("setup");
  expect(
    parseCaptureArguments(["credential", "remove", ...scope, "--json"]).command,
  ).toBe("remove");
});
it("does not accept the installed fixture/worktree as native capture authority", async () => {
  expect(
    await runCaptureCommand(["credential", "status", ...scope]),
  ).toMatchObject({
    status: "failed",
    error: { code: "ACTION_REQUIRED" },
  });
});
