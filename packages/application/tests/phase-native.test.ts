import { expect, it } from "vitest";
import { nativeTimings } from "./phase-native.mjs";

it("records nested checked operations without altering values or thrown identity", () => {
  let time = 0;
  const capture = nativeTimings(() => time++);
  const result = {};
  expect(
    capture.measure("pin", () => capture.measure("open", () => result)),
  ).toBe(result);
  const original = new Error("original checked native failure");
  expect(() =>
    capture.measure("acl", () => {
      throw original;
    }),
  ).toThrow(original);
  expect(capture.report()).toEqual({
    samplingErrors: 0,
    groups: [
      { kind: "open", calls: 1, totalMs: 1, maxMs: 1 },
      { kind: "pin", calls: 1, totalMs: 3, maxMs: 3 },
      { kind: "acl", calls: 1, totalMs: 1, maxMs: 1 },
    ],
  });
  const snapshot = capture.report();
  snapshot.groups.length = 0;
  expect(capture.report().groups).toHaveLength(3);
});

it("timing failures preserve success and primary failure and remain explicit", () => {
  for (const failingCall of [1, 2]) {
    let calls = 0;
    const capture = nativeTimings(() => {
      if (++calls === failingCall) throw new Error("clock failure");
      return 0;
    });
    const primary = new Error("original failure");
    expect(() =>
      capture.measure("open", () => {
        throw primary;
      }),
    ).toThrow(primary);
    expect(capture.report().samplingErrors).toBe(1);
  }
  const capture = nativeTimings(() => {
    throw new Error("clock failure");
  });
  expect(capture.measure("pin", () => 42)).toBe(42);
  expect(capture.report().samplingErrors).toBe(1);
});
