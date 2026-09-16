import { createHash } from "node:crypto";

/** RFC 8785 JSON Canonicalization Scheme over the bounded I-JSON profile. */
export function canonicalBytes(value: unknown): Uint8Array {
  const ancestors = new Set<object>();
  function string(value: string): string {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff))
          throw new TypeError("Unpaired UTF-16 surrogate");
      } else if (code >= 0xdc00 && code <= 0xdfff)
        throw new TypeError("Unpaired UTF-16 surrogate");
    }
    return JSON.stringify(value);
  }
  function encode(value: unknown, depth: number): string {
    if (depth > 128) throw new TypeError("Canonical JSON depth exceeds 128");
    if (value === null) return "null";
    if (typeof value === "string") return string(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new TypeError("Non-finite JSON number");
      return JSON.stringify(value);
    }
    if (typeof value !== "object") throw new TypeError("Non-JSON value");
    if (ancestors.has(value)) throw new TypeError("JSON cycle");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new TypeError("Non-JSON object prototype");
    if (array && prototype !== Array.prototype)
      throw new TypeError("Non-JSON array prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
      throw new TypeError("Symbol properties are not JSON");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor))
        throw new TypeError("JSON accessor forbidden");
      if (!descriptor.enumerable && !(array && key === "length"))
        throw new TypeError("Hidden JSON property forbidden");
    }
    ancestors.add(value);
    let encoded: string;
    if (array) {
      if (Object.keys(value).length !== value.length)
        throw new TypeError("Sparse or decorated array");
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) throw new TypeError("Sparse or decorated array");
        entries.push(encode(descriptor.value, depth + 1));
      }
      encoded = `[${entries.join(",")}]`;
    } else {
      encoded = `{${Object.keys(descriptors)
        .sort()
        .map(
          (key) =>
            `${string(key)}:${encode(descriptors[key]?.value, depth + 1)}`,
        )
        .join(",")}}`;
    }
    ancestors.delete(value);
    return encoded;
  }
  return new TextEncoder().encode(encode(value, 0));
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return hashBytes(canonicalBytes(value));
}

export interface ContentBytes {
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}

export function acceptedContent(envelope: {
  content: unknown;
  delivery?: {
    path?: string;
    deliveredAt?: string;
    temporaryUrl?: string;
    credentialReference?: string;
  };
}): ContentBytes {
  const bytes = canonicalBytes(envelope.content);
  return { bytes, sha256: hashBytes(bytes), byteLength: bytes.byteLength };
}
