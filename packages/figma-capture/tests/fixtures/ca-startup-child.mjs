import dns from "node:dns/promises";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";
import { syntheticContext } from "@design-studio/contracts/testing";

// Isolated synthetic process only. No runtime trust modification reaches the parent.
async function probe() {
  const [mode, suppliedPort] = process.argv.slice(2);
  const port = Number(suppliedPort);
  if (
    process.version !== "v24.21.0" ||
    !["cleared-extra", "replaced-default"].includes(mode) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("invalid probe");
  const extra = tls.getCACertificates("extra");
  const startupExtraLoaded = extra.length === 1;
  delete process.env.NODE_EXTRA_CA_CERTS;
  if (mode === "replaced-default") tls.setDefaultCACertificates(extra);
  const originalConnect = tls.connect;
  const control = originalConnect({
    host: "127.0.0.1",
    port,
    servername: "api.figma.com",
    rejectUnauthorized: true,
  });
  await once(control, "secureConnect");
  const defaultTrusted = control.authorized;
  const closed = once(control, "close");
  control.destroy();
  await closed;
  let dnsQueries = 0;
  let connections = 0;
  let pinnedBundled = false;
  dns.lookup = async (host, options) => {
    if (host !== "api.figma.com" || options?.all !== true)
      throw new Error("foreign synthetic DNS");
    dnsQueries++;
    return [{ address: "93.184.216.34", family: 4 }];
  };
  tls.connect = (options) => {
    if (
      options.host !== "93.184.216.34" ||
      options.port !== 443 ||
      options.servername !== "api.figma.com" ||
      options.rejectUnauthorized !== true
    )
      throw new Error("foreign synthetic socket");
    connections++;
    pinnedBundled =
      Array.isArray(options.ca) &&
      options.ca.length === tls.rootCertificates.length &&
      options.ca.every((cert, index) => cert === tls.rootCertificates[index]);
    // Keep production CA/SNI/verification options; redirect only the test endpoint.
    const socket = originalConnect({ ...options, host: "127.0.0.1", port });
    Object.defineProperty(socket, "remoteAddress", { value: "93.184.216.34" });
    return socket;
  };
  syncBuiltinESMExports();
  const { CaptureBudget, CAPTURE_LIMITS, ownPolicy } = await import(
    "../../dist/boundary.js"
  );
  const { FigmaHttpsTransport } = await import("../../dist/transport.js");
  const policy = ownPolicy({
    id: "synthetic_ca_policy",
    projectId: "project_synthetic",
    sourceId: "synthetic_source",
    artifactRootId: "artifact_root",
    fileKey: "SyntheticFile",
    nodeId: "1:2",
    imageOrigins: [],
    credential: {
      id: "synthetic_credential",
      providerId: "figma_rest",
      store: "test-fake",
    },
  });
  const context = syntheticContext({ budget: { ...CAPTURE_LIMITS } });
  context.authorization.egress = "explicit-grant-required";
  context.authorization.grants.push(
    {
      resourceKind: "source",
      resourceId: policy.sourceId,
      operations: ["capture"],
    },
    {
      resourceKind: "provider",
      resourceId: "figma_rest",
      operations: ["read"],
    },
    {
      resourceKind: "artifact",
      resourceId: policy.artifactRootId,
      operations: ["write"],
    },
  );
  const budget = new CaptureBudget(context, policy, () => true);
  let code = "SUCCESS";
  const secret = Buffer.from("synthetic-ca-probe");
  try {
    budget.call();
    const result = await new FigmaHttpsTransport().api(
      "metadata",
      undefined,
      secret,
      budget,
    );
    result.bytes.fill(0);
  } catch {
    code = "REJECTED";
  } finally {
    secret.fill(0);
    await budget.close();
  }
  process.stdout.write(
    JSON.stringify({
      startupExtraLoaded,
      defaultTrusted,
      pinnedBundled,
      dnsQueries,
      connections,
      code,
    }),
  );
}
void probe().catch(() => {
  process.stdout.write('{"code":"PROBE_FAILED"}');
  process.exitCode = 1;
});
