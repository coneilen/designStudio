import { crc32 } from "node:zlib";
import type { Artifact, DesignNode } from "@design-studio/contracts";
import { canonicalBytes, hashBytes } from "@design-studio/design-ir";
import { fixtureInputs } from "../support.js";

function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.byteLength);
  b.writeUInt32BE(data.byteLength);
  b.write(type, 4, "ascii");
  b.set(data, 8);
  b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
  return b;
}
function storedPng(width: number, height: number, channels: 3 | 4): Buffer {
  const rows = Buffer.alloc((width * channels + 1) * height);
  let random = 0x12345678,
    a = 1,
    b = 0;
  for (let y = 0; y < height; y++) {
    const start = y * (width * channels + 1);
    for (let x = 1; x <= width * channels; x++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      rows[start + x] = channels === 4 && x % 4 === 0 ? 255 : random & 255;
    }
  }
  for (const byte of rows) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const blocks: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < rows.length; offset += 65535) {
    const size = Math.min(65535, rows.length - offset),
      header = Buffer.alloc(5);
    header[0] = offset + size === rows.length ? 1 : 0;
    header.writeUInt16LE(size, 1);
    header.writeUInt16LE(~size & 65535, 3);
    blocks.push(header, rows.subarray(offset, offset + size));
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(((b << 16) | a) >>> 0);
  blocks.push(checksum);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("sRGB", Uint8Array.of(0)),
    chunk("IDAT", Buffer.concat(blocks)),
    chunk("IEND", new Uint8Array()),
  ]);
}
export async function performanceFixture() {
  const { request, accepted } = await fixtureInputs();
  const license = request.resources.assets[0]?.license;
  const text = request.design.root;
  if (!license || !("children" in text) || text.children[0]?.type !== "text")
    throw new Error("Missing foundation declarations");
  const style = { ...text.children[0].typography, fontSize: 6, lineHeight: 8 };
  const authored = canonicalBytes({
    id: "performance_authorship",
    generator: "f06-stored-png-v1",
    provenance:
      "Original deterministic RGB/RGBA pixels, MIT synthetic fixture license. Every pixel belongs to a displayed image; no padding chunks.",
  });
  const descriptor = (
    id: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Artifact => ({
    id,
    path: `blobs/${hashBytes(bytes)}`,
    sha256: hashBytes(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  });
  const source = descriptor(
    "performance_authorship",
    authored,
    "application/json",
  );
  accepted.artifacts.push({ artifact: source, bytes: authored });
  const images = [
    {
      id: "performance_image",
      width: 1599,
      height: 2173,
      bytes: storedPng(1599, 2173, 3),
    },
    {
      id: "performance_strip",
      width: 3183,
      height: 1,
      bytes: storedPng(3183, 1, 4),
    },
  ];
  request.resources.assets = images.map((image) => {
    const artifact = descriptor(image.id, image.bytes, "image/png");
    accepted.artifacts.push({ artifact, bytes: image.bytes });
    return {
      id: image.id,
      artifact,
      width: image.width,
      height: image.height,
      colorSpace: "srgb",
      alpha: "opaque",
      license,
      source: { id: source.id, sha256: source.sha256 },
      usageNodeIds: [image.id],
      verification: "declared",
    };
  });
  const nodes: DesignNode[] = images.map((image, index) => ({
    id: image.id,
    type: "image",
    assetId: image.id,
    fit: "fill",
    layout: {
      width: 393,
      height: index === 0 ? 500 : 1,
      position: "absolute",
      offset: { x: 0, y: index === 0 ? 0 : 500 },
    },
  }));
  for (let i = 0; i < 497; i++) {
    const layout = {
      width: 10,
      height: 10,
      position: "absolute" as const,
      offset: { x: (i % 32) * 12, y: 520 + Math.floor(i / 32) * 16 },
    };
    nodes.push(
      i % 2 === 0
        ? {
            id: `text_${i}`,
            type: "text",
            layout,
            typography: style,
            content: String(i % 10),
            indexing: "utf-16",
          }
        : {
            id: `shape_${i}`,
            type: "shape",
            shape: "rectangle",
            layout,
            appearance: {
              fill: { space: "srgb", r: (i % 7) / 7, g: 0.3, b: 0.7, a: 1 },
            },
          },
    );
  }
  request.design.designId = "design_performance";
  request.design.screen.id = "screen_performance";
  request.design.root = {
    id: "performance_root",
    type: "stack",
    layout: { width: 393, height: 852 },
    children: nodes,
  };
  request.resources.id = "resources_performance";
  accepted.resourceBytes = canonicalBytes(request.resources);
  request.design.resources.snapshotId = request.resources.id;
  request.design.resources.sha256 = hashBytes(accepted.resourceBytes);
  accepted.designBytes = canonicalBytes(request.design);
  accepted.revision = {
    id: "revision_performance",
    sha256: hashBytes(accepted.designBytes),
  };
  request.revision = accepted.revision;
  request.profile.assetHashes = request.resources.assets.map((a) => ({
    id: a.artifact.id,
    sha256: a.artifact.sha256,
  }));
  const resourceBytes =
    images.reduce((sum, image) => sum + image.bytes.byteLength, 0) +
    request.resources.fonts.reduce(
      (sum, font) =>
        sum +
        (font.kind === "bundled"
          ? font.artifact.byteLength
          : font.expectedByteLength),
      0,
    );
  return { request, accepted, resourceBytes };
}
