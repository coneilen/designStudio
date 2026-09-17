import { expect, it } from "vitest";
import { parseArguments } from "../src/arguments.js";

it("parses a fixed command without shell execution or project relabeling", () => {
  expect(parseArguments(["doctor", "--json"]).command).toBe("doctor");
  expect(parseArguments(["jobs", "get", "job_1", "--json"]).id).toBe("job_1");
});
it("supports noninteractive subcommand help without echoing unrecognized operands", () => {
  expect(parseArguments(["render", "--help", "--json"]).command).toBe("help");
  expect(parseArguments(["jobs", "cancel", "--help", "--json"]).command).toBe(
    "help",
  );
  expect(() =>
    parseArguments(["SECRET_OPERAND", "--help", "--json"]),
  ).toThrow();
});
it.each([
  ["figma", "import", "https://example.invalid"],
  ["doctor", "--json", "--json"],
  ["doctor", "--project", "foreign"],
  ["jobs", "wait", "job_1", "--timeout-ms", "0"],
  ["jobs", "wait", "job_1", "--timeout-ms", "30001"],
  ["doctor", "--token", "secret"],
  ["doctor", "unexpected"],
])("rejects invalid arguments before effects: %j", (...argv) => {
  expect(() => parseArguments(argv)).toThrow();
});
it.each([
  ["render", "design_settings-screen"],
  ["fixtures", "accept", "settings-screen", "--request-id", "r"],
  [
    "fixtures",
    "accept",
    "settings-screen",
    "--new",
    "--expected-base",
    "rev",
    "--request-id",
    "r",
  ],
  ["jobs", "cancel", "job_1", "--request-id", "r"],
  [
    "jobs",
    "cancel",
    "job_1",
    "--request-id",
    "r",
    "--if-match",
    '"job:job_2:1"',
  ],
  ["artifacts", "get", "artifact_1"],
])(
  "rejects missing or conflicting mutation operands before installation work: %j",
  (...argv) => {
    expect(() => parseArguments(argv)).toThrow();
  },
);
