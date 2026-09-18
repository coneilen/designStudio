import { expect, test } from "vitest";
import { decodeBackup } from "../src/backup-codec.js";

function encoded(base64: string): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      format: "design-studio-local-backup-1",
      metadata: {
        storageVersion: 2,
        projectId: "project1",
        artifacts: [],
        revisions: [],
        heads: [],
        reviews: [],
        receipts: [],
        pins: [],
      },
      sha256: "a".repeat(64),
      blobs: [{ sha256: "a".repeat(64), base64 }],
    }),
  );
}

test.each(["", "AA==", "AAA=", "AAAA", "/w==", "//8=", "////"])(
  "accepts canonical base64 %j without recursive matching",
  (text) => {
    const result = decodeBackup(encoded(text), 1048576);
    expect(result.blobs[0]?.bytes).toEqual(
      new Uint8Array(Buffer.from(text, "base64")),
    );
  },
);

test.each([
  "A",
  "AA",
  "AAA",
  "AA=A",
  "A===",
  "====",
  "AA==\n",
  "AA== ",
  "A-==",
  "AB==",
  "AAB=",
])("rejects malformed or noncanonical base64 %j", (text) => {
  expect(() => decodeBackup(encoded(text), 1048576)).toThrow();
});
