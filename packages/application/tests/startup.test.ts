import { expect, it } from "vitest";
import {
  StartupCleanupRequired,
  startOwnedApplication,
} from "../src/startup.js";

it("unwinds failed startup only when resource shutdown confirms quiescence", async () => {
  const failure = new Error("Owned startup failure.");
  let closes = 0;
  await expect(
    startOwnedApplication(
      async () => {
        throw failure;
      },
      async () => {
        closes++;
        return true;
      },
    ),
  ).rejects.toBe(failure);
  expect(closes).toBe(1);
});
it("preserves an explicit cleanup capability when startup leaves pending callbacks", async () => {
  let quiescent = false;
  let caught: unknown;
  try {
    await startOwnedApplication(
      async () => {
        throw new Error("Owned timeout.");
      },
      async () => quiescent,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(StartupCleanupRequired);
  if (!(caught instanceof StartupCleanupRequired))
    throw new Error("Missing retained resource ownership.");
  expect(await caught.close()).toBe(false);
  quiescent = true;
  expect(await caught.close()).toBe(true);
});
it("retains the primary failure and retry capability when cleanup itself fails", async () => {
  const failure = new Error("Primary.");
  let attempts = 0;
  let caught: unknown;
  try {
    await startOwnedApplication(
      async () => {
        throw failure;
      },
      async () => {
        if (!attempts++) throw new Error("Close failed.");
        return true;
      },
    );
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof StartupCleanupRequired))
    throw new Error("Missing retained resource ownership.");
  expect(caught.cause).toBe(failure);
  expect(await caught.close()).toBe(true);
});
