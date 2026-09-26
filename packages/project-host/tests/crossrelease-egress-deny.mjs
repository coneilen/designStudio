import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const marker = Symbol.for("design-studio.synthetic-crossrelease-egress");
if (!globalThis[marker]) {
  let control = true,
    attempts = 0;
  const deny = () => {
    if (!control) attempts++;
    throw new Error("CROSSRELEASE_SYNTHETIC_EGRESS_DENIED");
  };
  for (const object of [http, https]) {
    object.request = deny;
    object.get = deny;
  }
  net.connect = deny;
  net.createConnection = deny;
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  for (const object of [dns, dnsPromises]) {
    for (const name of Object.keys(object))
      if (
        name === "lookup" ||
        name === "lookupService" ||
        name.startsWith("resolve") ||
        name === "reverse"
      )
        object[name] = deny;
  }
  globalThis.fetch = deny;
  syncBuiltinESMExports();
  for (const action of [
    () => https.request(),
    () => net.connect(),
    () => tls.connect(),
    () => dns.lookup(),
    () => fetch(""),
  ])
    assert.throws(action, /CROSSRELEASE_SYNTHETIC_EGRESS_DENIED/);
  control = false;
  globalThis[marker] = { denialControlPassed: true };
  process.on("exit", () => {
    if (process.env.DESIGN_STUDIO_EGRESS_LEDGER)
      writeFileSync(
        `${process.env.DESIGN_STUDIO_EGRESS_LEDGER}.${process.pid}.json`,
        JSON.stringify({
          scope: "synthetic-crossrelease-egress",
          pid: process.pid,
          denialControlPassed: true,
          unmockedAttempts: attempts,
        }),
        { flag: "wx" },
      );
  });
}
