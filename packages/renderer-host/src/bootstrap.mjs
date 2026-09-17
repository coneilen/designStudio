import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { verifyFile } from "../dist/identity.js";
import { encode, FrameReader, Kind, send } from "../dist/protocol.js";
import { loadJobs } from "../dist/windows-job.js";

// This fixed pre-join path imports only trusted host bindings and cannot spawn.
if (process.version !== "v24.21.0")
  throw new Error("The renderer bootstrap requires pinned Node 24.21.0.");
const config = JSON.parse(process.argv[2]);
(await loadJobs()).joinCurrent(config.job);
// joinCurrent verifies membership and closes its temporary Job handle before returning.
const transport = new Socket({ fd: 3, readable: true, writable: true });
const abort = new AbortController();
let implementation;
let state = "joined";
let sequence = 0;
let closing = false;
const emit = (kind, seq = 0, bytes = Buffer.alloc(0)) =>
  send(transport, encode(config.nonce, kind, seq, bytes));
const fail = async (code = 1) => {
  if (closing) return;
  closing = true;
  abort.abort();
  try {
    await emit(Kind.error, sequence, Buffer.of(code));
  } finally {
    process.exit(1);
  }
};
transport.on("error", () => process.exit(1));
transport.on("close", () => process.exit(1));
const reader = new FrameReader(config.nonce, config.maxFrameBytes, (frame) => {
  if (
    frame.kind === Kind.close &&
    frame.sequence === 0 &&
    frame.bytes.length === 0
  ) {
    closing = true;
    abort.abort();
    Promise.resolve()
      .then(() => implementation?.close?.())
      .then(
        async () => {
          await emit(Kind.closed);
          process.exit(0);
        },
        () => process.exit(1),
      )
      .catch(() => process.exit(1));
    return;
  }
  if (closing) throw new Error("closed");
  if (
    state === "joined" &&
    frame.kind === Kind.start &&
    frame.sequence === 0 &&
    frame.bytes.length === 0
  ) {
    state = "loading";
    (async () => {
      await verifyFile(config.implementation);
      implementation = await import(
        pathToFileURL(config.implementation.path).href
      );
      if (
        typeof implementation.render !== "function" ||
        (implementation.close !== undefined &&
          typeof implementation.close !== "function")
      )
        throw new Error("Invalid renderer module");
      if (closing) return;
      state = "ready";
      await emit(Kind.ready);
    })().catch(() => fail());
    return;
  }
  if (
    state !== "ready" ||
    frame.kind !== Kind.request ||
    frame.sequence !== sequence + 1
  )
    throw new Error("Unexpected renderer protocol frame");
  sequence = frame.sequence;
  state = "rendering";
  Promise.resolve()
    .then(() =>
      implementation.render(Uint8Array.from(frame.bytes), {
        signal: abort.signal,
      }),
    )
    .then(
      async (bytes) => {
        if (closing) return;
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > config.maxFrameBytes
        ) {
          await fail(2);
          return;
        }
        state = "ready";
        await emit(Kind.result, sequence, Buffer.from(bytes));
      },
      () => fail(),
    )
    .catch(() => fail());
});
transport.on("data", (chunk) => {
  try {
    reader.push(chunk);
  } catch {
    void fail();
  }
});
await emit(Kind.joined);
