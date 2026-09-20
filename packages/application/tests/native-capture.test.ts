import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { parseContract, validateContract } from "@design-studio/contracts";
import { syntheticContext } from "@design-studio/contracts/testing";
import { hashBytes, resolveDesign } from "@design-studio/design-ir";
import {
  acquireCaptureWork,
  openCaptureCredentials,
  openCaptureProject,
} from "@design-studio/project-host";
import { LocalStore } from "@design-studio/storage";
import { expect, it, vi } from "vitest";
import { runCaptureCommand } from "../../cli/src/capture-main.js";
import { png } from "../../figma-capture/tests/support.js";
import { syntheticCertificate } from "../../figma-capture/tests/tls-fixture.js";
import { OwnedFigmaCredentialAdapter } from "../../host/dist/credential-admin-vault.js";
import { loadNative } from "../../project-host/src/native.js";
import { withCaptureInstallation } from "../../project-host/tests/capture-support.js";
import { openNativeCapture } from "../src/capture-runtime.js";

const seam = vi.hoisted(() => ({
  root: "",
  port: 0,
  ca: "",
  origins: [] as string[],
}));
vi.mock("@design-studio/project-host", async () => {
  const actual = await import("../../project-host/src/index.js");
  const installation = await import("../../project-host/src/installation.js");
  return {
    ...actual,
    verifyCaptureInstallation: () =>
      installation.verifyCaptureInstalledRoot(seam.root),
  };
});
vi.mock("../../project-host/src/capture-profile.js", async (original) => {
  const actual =
    await original<
      typeof import("../../project-host/src/capture-profile.js")
    >();
  return {
    ...actual,
    CAPTURE_POLICY: {
      ...actual.CAPTURE_POLICY,
      get imageOrigins() {
        return Object.freeze([...seam.origins]);
      },
    },
  };
});
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
}));
vi.mock("@design-studio/assets", async (original) => {
  const actual = await original<typeof import("@design-studio/assets")>();
  return {
    ...actual,
    publicAddress: (address: string) =>
      address === "127.0.0.1" || actual.publicAddress(address),
  };
});
vi.mock("node:tls", async (original) => {
  const actual = await original<typeof import("node:tls")>();
  const connect = (options: tls.ConnectionOptions) => {
    if (
      options.host !== "127.0.0.1" ||
      options.port !== 443 ||
      options.rejectUnauthorized !== true ||
      !["api.figma.com", "images.capture.invalid"].includes(
        options.servername ?? "",
      )
    )
      throw new Error(
        "Synthetic TLS seam rejects nonlocal or weakened requests",
      );
    return actual.connect({ ...options, port: seam.port, ca: seam.ca });
  };
  return { ...actual, default: { ...actual, connect }, connect };
});
const URL = "https://www.figma.com/design/SyntheticFile/selection?node-id=1-2";
const PAT = Buffer.from("synthetic-native-capture-pat-only");
const frame = {
  id: "1:2",
  type: "FRAME",
  name: "Synthetic selection",
  absoluteBoundingBox: { x: 0, y: 0, width: 2, height: 2 },
  children: [],
};
const original = Buffer.from(
  JSON.stringify({
    version: "synthetic_v1",
    nodes: {
      "1:2": { document: frame },
      "7:8": {
        document: { id: "7:8", type: "FRAME", name: "Never converted sibling" },
      },
    },
  }),
);

it.skipIf(process.platform !== "win32")(
  "runs the native dispatcher, owned private project, vault-byte adapter, jobs, TLS capture, reopen and authenticated conversion",
  async () => {
    let stored: Buffer | undefined;
    // Windows maps an addon until process exit; use the identical approved test copy
    // rather than leave a mapped DLL inside the disposable, fully attested installation.
    const open = LocalStore.open.bind(LocalStore);
    const database = vi
      .spyOn(LocalStore, "open")
      .mockImplementation((options) =>
        open({
          ...options,
          nativeBinding: path.resolve(
            ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
          ),
        }),
      );
    const returned: Buffer[] = [];
    const read = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "read")
      .mockImplementation(async () => {
        if (!stored) return undefined;
        const copy = Buffer.from(stored);
        returned.push(copy);
        return copy;
      });
    const write = vi
      .spyOn(OwnedFigmaCredentialAdapter.prototype, "write")
      .mockImplementation(async (bytes) => {
        stored?.fill(0);
        stored = Buffer.from(bytes);
      });
    const certificate = syntheticCertificate();
    const peers = new Set<tls.TLSSocket>();
    const calls: { path: string; token: boolean }[] = [];
    let status = 200;
    let dropNodes = false;
    const server = tls.createServer(certificate, (socket) => {
      peers.add(socket);
      socket.on("close", () => peers.delete(socket));
      socket.on("error", () => {});
      socket.once("data", (bytes) => {
        const header = bytes.toString("ascii");
        const target = header.split(" ")[1] ?? "";
        calls.push({
          path: target,
          token: header.includes(`X-Figma-Token: ${PAT.toString("ascii")}`),
        });
        if (dropNodes && target.includes("/nodes?")) {
          socket.destroy();
          return;
        }
        let body = Buffer.from('{"file":{"version":"synthetic_v1"}}');
        let type = "application/json";
        if (target.includes("/nodes?")) body = original;
        else if (target.includes("/v1/images/"))
          body = Buffer.from(
            '{"images":{"1:2":"https://images.capture.invalid/reference.png?signed=private"}}',
          );
        else if (target.startsWith("/reference.png")) {
          body = png(true, 2, 2);
          type = "image/png";
        }
        if (status !== 200)
          body = Buffer.from('{"private":"discard error body"}');
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 ${status} Synthetic\r\nContent-Length: ${body.length}\r\nContent-Type: ${type}\r\n${status === 429 ? "Retry-After: 60\r\n" : ""}Connection: close\r\n\r\n`,
            ),
            body,
          ]),
        );
      });
    });
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Synthetic listener missing");
    seam.port = address.port;
    seam.ca = certificate.cert;
    seam.origins = [];
    try {
      const sqlite = await readFile(
        path.resolve(
          ".tools\\sqlite-prebuild\\build\\Release\\better_sqlite3.node",
        ),
      );
      expect(hashBytes(sqlite)).toBe(
        "194c049b8781c3ca39f7e12b4f4a47c79027502b366151404ae8847fe6e2a9a1",
      );
      await withCaptureInstallation(
        async (installation) => {
          seam.root = path.dirname(
            path.dirname(installation.paths.bootstrapEntry),
          );
          const project = await openCaptureProject(installation);
          const projectId = project.projectId;
          const outputs = project.paths.outputs;
          const artifactsRoot = project.paths.artifacts;
          try {
            await expect(openNativeCapture({ ...project })).rejects.toThrow();
            const admin = await openCaptureCredentials(project);
            try {
              expect(
                await admin.execute(
                  "setup",
                  project.reference.id,
                  new AbortController().signal,
                  Buffer.from(PAT),
                ),
              ).toMatchObject({ status: "complete" });
            } finally {
              admin.close();
            }
            const runtime = await openNativeCapture(project);
            try {
              await expect(
                { ...runtime }.execute(
                  { operation: "inspect", requestId: "unknown" },
                  new AbortController().signal,
                ),
              ).rejects.toThrow();
              await expect(openCaptureCredentials(project)).rejects.toThrow();
            } finally {
              await runtime.close();
            }
          } finally {
            await project.close();
          }
          const command = async (
            operation: string,
            id: string,
            flags: string[] = [],
          ) => {
            const result = await runCaptureCommand([
              "figma",
              operation,
              "--project",
              projectId,
              "--request-id",
              id,
              ...flags,
            ]);
            const checked = validateContract("NativeCaptureEnvelope", result);
            expect(checked.success).toBe(true);
            if (!checked.success) throw new Error("Invalid native envelope");
            expect(JSON.stringify(result)).not.toContain(PAT.toString("ascii"));
            expect(JSON.stringify(result)).not.toContain("signed=private");
            return checked.value;
          };
          const partial = await command("capture", "first", ["--url", URL]);
          expect(partial, JSON.stringify(partial)).toMatchObject({
            status: "partial",
            value: {
              capture: {
                completeness: "partial",
                referenceStatus: "unavailable",
              },
              jobStatus: "completed",
            },
          });
          expect(calls).toHaveLength(3);
          expect(calls.every((call) => call.token)).toBe(true);
          expect(calls[1]?.path).toContain("version=synthetic_v1");
          expect(calls[2]?.path).toContain("version=synthetic_v1");
          expect(
            returned.every((bytes) => bytes.every((byte) => byte === 0)),
          ).toBe(true);
          const vaultReads = read.mock.calls.length;
          expect(await command("capture", "first", ["--url", URL])).toEqual(
            partial,
          );
          expect(await command("inspect", "first")).toMatchObject({
            status: "partial",
          });
          expect(read.mock.calls).toHaveLength(vaultReads);
          expect(calls).toHaveLength(3);
          const conversion = await command("convert", "first");
          expect(conversion, JSON.stringify(conversion)).toMatchObject({
            status: "partial",
            value: { readiness: "needs-review" },
          });
          expect(
            conversion.value?.artifacts.some((item) => item.role === "design"),
          ).toBe(true);
          expect(
            await command("artifact", "first", [
              "--role",
              "nodes",
              "--output",
              "original.json",
            ]),
          ).toMatchObject({ status: "partial" });
          expect(await readFile(path.join(outputs, "original.json"))).toEqual(
            original,
          );
          expect(
            await command("artifact", "first", [
              "--role",
              "source-map",
              "--output",
              "map.json",
            ]),
          ).toMatchObject({ status: "partial" });
          const map = JSON.parse(
            await readFile(path.join(outputs, "map.json"), "utf8"),
          );
          expect(
            map.entries.map(
              (entry: { sourceNodeId: string }) => entry.sourceNodeId,
            ),
          ).toEqual(["1:2"]);
          expect(map.snapshot).toEqual(conversion.value?.capture?.source);
          await command("artifact", "first", [
            "--role",
            "design",
            "--output",
            "draft.json",
          ]);
          await command("artifact", "first", [
            "--role",
            "resources",
            "--output",
            "resources.json",
          ]);
          const design = parseContract(
            "DesignIR",
            await readFile(path.join(outputs, "draft.json"), "utf8"),
            "json",
          );
          const resourceBytes = await readFile(
            path.join(outputs, "resources.json"),
          );
          const resources = parseContract(
            "ResourceSnapshot",
            resourceBytes.toString("utf8"),
            "json",
          );
          expect(design.resources.snapshotId).toBe(resources.id);
          expect(() =>
            resolveDesign(design, resources, { resourceBytes }),
          ).not.toThrow();
          expect(
            await command("capture", "first", [
              "--url",
              URL.replace("1-2", "1-3"),
            ]),
          ).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
          expect(calls).toHaveLength(3);
          seam.origins = ["https://images.capture.invalid"];
          const complete = await command("capture", "four", ["--url", URL]);
          expect(complete, JSON.stringify(complete)).toMatchObject({
            status: "complete",
            value: {
              capture: {
                completeness: "complete",
                referenceStatus: "complete",
              },
              readiness: "not-evaluated",
            },
          });
          expect(calls).toHaveLength(7);
          expect(calls[6]?.token).toBe(false);
          status = 429;
          expect(
            await command("capture", "quota", ["--url", URL]),
          ).toMatchObject({
            status: "partial",
            value: { capture: { errorCode: "RATE_LIMITED" } },
          });
          const count = calls.length;
          expect(
            await command("capture", "blocked", ["--url", URL]),
          ).toMatchObject({
            status: "failed",
            error: { code: "RATE_LIMITED" },
          });
          expect(calls).toHaveLength(count);
          expect(await command("inspect", "quota")).toMatchObject({
            status: "partial",
          });
          status = 200;
          const reopened = await openCaptureProject(installation, projectId);
          try {
            const work = acquireCaptureWork(reopened);
            try {
              const fake = syntheticContext();
              fake.projectId = projectId;
              fake.authorization.projectId = projectId;
              fake.authorization.actorId = reopened.principal.actorId;
              fake.authorization.grants.push({
                resourceKind: "credential",
                resourceId: reopened.reference.id,
                operations: ["credential-use"],
              });
              const reads = read.mock.calls.length;
              expect(
                await work
                  .credentials()
                  .use(reopened.reference, fake, async () => "must-not-run"),
              ).toMatchObject({ status: "failed" });
              expect(read).toHaveBeenCalledTimes(reads);
              const context = await work.policy.issue({
                jobId: "native_probe",
                requestId: "native_probe",
                signal: new AbortController().signal,
                network: {
                  projectId,
                  sourceId: "native_probe_source",
                  credential: reopened.reference,
                },
              });
              expect(work.policy.verify(context.authorization)).toBe(true);
              expect(work.policy.verify({ ...context.authorization })).toBe(
                false,
              );
              expect(
                await work
                  .credentials()
                  .use(
                    { ...reopened.reference, id: "foreign_reference" },
                    context,
                    async () => "must-not-run",
                  ),
              ).toMatchObject({ status: "failed" });
              expect(read).toHaveBeenCalledTimes(reads);
              const native = await loadNative();
              const principal = vi
                .spyOn(native, "principal")
                .mockReturnValue("S-1-5-21-1-2-3-1234");
              try {
                expect(work.policy.verify(context.authorization)).toBe(false);
              } finally {
                principal.mockRestore();
              }
              expect(work.policy.verify(context.authorization)).toBe(true);
              work.policy.close();
              expect(work.policy.verify(context.authorization)).toBe(false);
              expect(
                await work
                  .credentials()
                  .use(reopened.reference, context, async () => "must-not-run"),
              ).toMatchObject({ status: "failed" });
              expect(read).toHaveBeenCalledTimes(reads);
            } finally {
              work.close();
            }
            const runtime = await openNativeCapture(reopened);
            try {
              const abort = new AbortController();
              let notify = () => {};
              let finish: (value: Buffer) => void = () => {};
              const entered = new Promise<void>((resolve) => {
                notify = resolve;
              });
              const late = new Promise<Buffer>((resolve) => {
                finish = resolve;
              });
              read.mockImplementationOnce(async () => {
                notify();
                return late;
              });
              const pending = runtime.execute(
                {
                  operation: "capture",
                  requestId: "cancel-read",
                  url: URL.replace("SyntheticFile", "CancelReadSynthetic"),
                },
                abort.signal,
              );
              await entered;
              abort.abort();
              await expect(runtime.close()).rejects.toMatchObject({
                code: "INTERRUPTED",
              });
              const bytes = Buffer.from(PAT);
              finish(bytes);
              expect(await pending).toMatchObject({ status: "cancelled" });
              await runtime.close();
              expect(bytes.every((byte) => byte === 0)).toBe(true);
              expect(calls).toHaveLength(count);
            } finally {
              await runtime.close();
            }
          } finally {
            await reopened.close();
          }
          stored?.fill(0);
          stored = undefined;
          const denied = await command("capture", "revoked", [
            "--url",
            URL.replace("SyntheticFile", "RevokedSynthetic"),
          ]);
          expect(denied).toMatchObject({
            status: "unavailable",
            error: { code: "AUTH_REQUIRED" },
          });
          expect(calls).toHaveLength(count);
          expect(
            await command("capture", "revoked", [
              "--url",
              URL.replace("SyntheticFile", "RevokedSynthetic"),
            ]),
          ).toMatchObject({ status: "unavailable" });
          expect(calls).toHaveLength(count);
          const foreign = await openCaptureProject(installation);
          try {
            const runtime = await openNativeCapture(foreign);
            try {
              expect(
                await runtime.execute(
                  { operation: "convert", requestId: "first" },
                  new AbortController().signal,
                ),
              ).toMatchObject({
                status: "failed",
                error: { code: "NOT_FOUND" },
              });
              await expect(
                Reflect.apply(runtime.execute, runtime, [
                  {
                    operation: "convert",
                    requestId: "first",
                    artifact: partial.value?.capture?.source,
                  },
                  new AbortController().signal,
                ]),
              ).rejects.toMatchObject({ code: "INVALID_INPUT" });
            } finally {
              await runtime.close();
            }
          } finally {
            await foreign.close();
          }
          stored = Buffer.from(PAT);
          dropNodes = true;
          const unknownUrl = URL.replace("SyntheticFile", "UnknownSynthetic");
          expect(
            await command("capture", "unknown", ["--url", unknownUrl]),
          ).toMatchObject({ status: "interrupted" });
          const spent = calls.length;
          expect(
            await command("capture", "unknown", ["--url", unknownUrl]),
          ).toMatchObject({ status: "interrupted" });
          expect(
            await command("capture", "unknown-next", ["--url", unknownUrl]),
          ).toMatchObject({
            status: "failed",
            error: { code: "ACTION_REQUIRED" },
          });
          expect(calls).toHaveLength(spent);
          const staged = await readdir(artifactsRoot, {
            recursive: true,
            withFileTypes: true,
          });
          const rawStages = [];
          for (const entry of staged)
            if (
              entry.isFile() &&
              path
                .relative(artifactsRoot, entry.parentPath)
                .startsWith(".host-")
            )
              rawStages.push(
                await readFile(path.join(entry.parentPath, entry.name)),
              );
          expect(
            rawStages.some((bytes) =>
              bytes.equals(Buffer.from('{"file":{"version":"synthetic_v1"}}')),
            ),
          ).toBe(true);
        },
        { sqlite },
      );
    } finally {
      database.mockRestore();
      read.mockRestore();
      write.mockRestore();
      stored?.fill(0);
      seam.origins = [];
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  120_000,
);
