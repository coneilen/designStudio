import { generateKeyPairSync, sign } from "node:crypto";
export function syntheticCertificate() {
  const der = (tag: number, value: Buffer | Buffer[]): Buffer => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.concat(value);
    let length = Buffer.from([bytes.length]);
    if (bytes.length >= 128) {
      const parts: number[] = [];
      for (let n = bytes.length; n; n >>>= 8) parts.unshift(n & 255);
      length = Buffer.from([128 | parts.length, ...parts]);
    }
    return Buffer.concat([Buffer.of(tag), length, bytes]);
  };
  const seq = (...parts: Buffer[]) => der(48, parts);
  const oid = (parts: number[]) => {
    const bytes = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
    for (const value of parts.slice(2)) {
      const encoded = [value & 127];
      for (let n = value >>> 7; n; n >>>= 7) encoded.unshift(128 | (n & 127));
      bytes.push(...encoded);
    }
    return der(6, Buffer.from(bytes));
  };
  const integer = (number: number) => der(2, Buffer.of(number));
  const name = seq(
    der(
      49,
      seq(
        oid([2, 5, 4, 3]),
        der(12, Buffer.from("Design Studio synthetic TLS")),
      ),
    ),
  );
  const algorithm = seq(
    oid([1, 2, 840, 113549, 1, 1, 11]),
    der(5, Buffer.alloc(0)),
  );
  const utc = (offset: number) =>
    der(
      23,
      Buffer.from(
        `${new Date(Date.now() + offset)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace("T", "")
          .slice(2, 14)}Z`,
      ),
    );
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const tbs = seq(
    der(160, integer(2)),
    integer(1),
    algorithm,
    name,
    seq(utc(-86400000), utc(86400000)),
    name,
    keys.publicKey.export({ type: "spki", format: "der" }),
    der(
      163,
      seq(
        seq(
          oid([2, 5, 29, 19]),
          der(1, Buffer.of(255)),
          der(4, seq(der(1, Buffer.of(255)))),
        ),
        seq(
          oid([2, 5, 29, 17]),
          der(
            4,
            seq(
              der(130, Buffer.from("api.figma.com")),
              der(130, Buffer.from("images.capture.invalid")),
              der(
                130,
                Buffer.from("figma-alpha-api.s3.us-west-2.amazonaws.com"),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const cert = seq(
    tbs,
    algorithm,
    der(3, Buffer.concat([Buffer.of(0), sign("sha256", tbs, keys.privateKey)])),
  );
  return {
    key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert
      .toString("base64")
      .match(/.{1,64}/g)
      ?.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}
