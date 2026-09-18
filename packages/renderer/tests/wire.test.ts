import { DEFAULT_BUDGETS } from "@design-studio/contracts";
import { expect, it } from "vitest";
import { prepareInputs } from "../src/resources.js";
import { decodePayload, encodeResourceWire, encodeWire } from "../src/wire.js";
import { fixtureInputs } from "./support.js";

it("transports large resource data losslessly with bounded compression", () => {
  const data = { version: 1, text: "a".repeat(100_000) };
  const wire = encodeWire(data);
  expect(wire.byteLength).toBeLessThan(100_000);
  expect(JSON.parse(decodePayload(wire))).toEqual(data);
});
it("rejects oversized advertised expansion and trailing compressed bytes", () => {
  const wire = Buffer.from(encodeWire({ value: 1 }));
  wire.writeUInt32BE(30_000_000, 4);
  expect(() => decodePayload(wire)).toThrow("limit");
  expect(() =>
    decodePayload(Buffer.concat([encodeWire({ value: 1 }), Buffer.from([0])])),
  ).toThrow();
});
it("packs verified resource bytes without base64 compression CPU or unused padding", () => {
  const value = {
    fonts: [{ id: "font", bytes: Buffer.from([0, 255, 7]).toString("base64") }],
    images: [],
  };
  const wire = encodeWire(value);
  expect(Buffer.from(wire).subarray(0, 4).toString("ascii")).toBe("DSB1");
  expect(JSON.parse(decodePayload(wire))).toEqual(value);
  expect(() =>
    decodePayload(Buffer.concat([wire, Buffer.from([0])])),
  ).toThrow();
});
it("optimized admitted-resource encoding preserves exact logical lengths and bytes", async () => {
  const fixture = await fixtureInputs();
  const prepared = prepareInputs(
    fixture.request,
    fixture.accepted,
    () => true,
    DEFAULT_BUDGETS,
  );
  const value = {
    version: 1 as const,
    design: prepared.expanded,
    fonts: prepared.fonts,
    images: prepared.images,
    profile: fixture.request.profile,
    mode: "strict" as const,
    budget: { ...DEFAULT_BUDGETS },
  };
  expect(encodeResourceWire(value)).toEqual(encodeWire(value));
  value.budget.maxInputBytes = 10;
  expect(() => encodeResourceWire(value)).toThrow("logical");
});
