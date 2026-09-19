import type { Duplex } from "node:stream";
import { HostBoundaryError } from "./guards.js";

export const PatKind = Object.freeze({
  init: 1,
  joined: 2,
  start: 3,
  ready: 4,
  accepted: 5,
  cancel: 6,
  closed: 7,
  error: 8,
});
export interface PatFrame {
  kind: number;
  sequence: number;
  bytes: Buffer;
}
const HEADER = 38;
function valid(kind: number, sequence: number, size: number): boolean {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1) return false;
  if (kind === PatKind.init) return sequence === 0 && size === 36;
  if (kind === PatKind.start) return sequence === 0 && size === 4;
  if (
    kind === PatKind.joined ||
    kind === PatKind.ready ||
    kind === PatKind.cancel
  )
    return sequence === 0 && size === 0;
  if (kind === PatKind.accepted)
    return sequence === 1 && size > 0 && size <= 4096;
  if (kind === PatKind.closed) return sequence === 1 && size === 1;
  if (kind === PatKind.error) return size === 1;
  return false;
}
const failure = () =>
  new HostBoundaryError(
    "TRANSPORT_UNAVAILABLE",
    "Owned PAT channel failed; sensitive details withheld.",
  );

/** Single-session binary transport; all received buffers transfer to the trusted owner. */
export class PatChannel {
  readonly #header = Buffer.alloc(HEADER);
  #headerSize = 0;
  #body: Buffer | undefined;
  #bodySize = 0;
  #nonce: Buffer | undefined;
  #kind = 0;
  #sequence = 0;
  #frames: PatFrame[] = [];
  #received = 0;
  #sent = 0;
  #stopped = false;
  #ended = false;
  #peerEof = false;
  #disposed = false;
  #receiveFailed = false;
  #terminal = false;
  #finalized = false;
  #terminalWaiter: { resolve(): void; reject(error: Error): void } | undefined;
  #waiter:
    | { resolve(frame: PatFrame): void; reject(error: Error): void }
    | undefined;
  readonly #writes = new Set<Promise<void>>();
  readonly #closed: Promise<void>;
  constructor(
    private readonly pipe: Duplex,
    nonce?: Uint8Array,
  ) {
    if (pipe.destroyed || !pipe.readable || !pipe.writable) throw failure();
    if (
      nonce !== undefined &&
      (nonce.length !== 32 || nonce.buffer instanceof SharedArrayBuffer)
    )
      throw new HostBoundaryError(
        "INVALID_INPUT",
        "Invalid private channel nonce.",
      );
    this.#nonce = nonce === undefined ? undefined : Buffer.from(nonce);
    this.#closed = new Promise<void>((resolve) => {
      pipe.once("close", () => {
        if (!this.#peerEof && !this.#disposed) this.stop(true);
        this.#ended = true;
        resolve();
      });
    });
    pipe.on("data", this.receive);
    pipe.on("error", () => {
      if (!this.#disposed) this.stop(true);
    });
    pipe.on("end", () => this.end());
  }
  private end() {
    this.#ended = true;
    this.#peerEof = true;
    if (this.#disposed || this.#headerSize || this.#body) this.stop(true);
    else if (this.#terminal) this.finishReceive();
    if (!this.#frames.length) {
      this.#waiter?.reject(failure());
      this.#waiter = undefined;
    }
  }
  private stop(invalid = true) {
    if (invalid) this.#receiveFailed = true;
    else this.#disposed = true;
    this.#terminalWaiter?.reject(failure());
    this.#terminalWaiter = undefined;
    if (this.#stopped) return;
    this.#stopped = true;
    this.#header.fill(0);
    this.#body?.fill(0);
    this.#body = undefined;
    this.#nonce?.fill(0);
    for (const frame of this.#frames) frame.bytes.fill(0);
    this.#frames = [];
    this.#waiter?.reject(failure());
    this.#waiter = undefined;
    this.pipe.destroy();
  }
  private readonly receive = (chunk: unknown) => {
    if (!(chunk instanceof Uint8Array)) {
      this.stop();
      return;
    }
    try {
      if (chunk.length && (this.#terminal || this.#peerEof)) throw failure();
      let offset = 0;
      while (offset < chunk.length && !this.#stopped) {
        if (!this.#body) {
          const count = Math.min(
            HEADER - this.#headerSize,
            chunk.length - offset,
          );
          this.#header.set(
            chunk.subarray(offset, offset + count),
            this.#headerSize,
          );
          this.#headerSize += count;
          offset += count;
          if (this.#headerSize !== HEADER) continue;
          const size = this.#header.readUInt32BE(0);
          this.#kind = this.#header[36] ?? 0;
          this.#sequence = this.#header[37] ?? 0;
          if (!valid(this.#kind, this.#sequence, size) || ++this.#received > 8)
            throw failure();
          if (!this.#nonce) {
            if (this.#kind !== PatKind.init) throw failure();
            this.#nonce = Buffer.from(this.#header.subarray(4, 36));
          } else if (!this.#nonce.equals(this.#header.subarray(4, 36)))
            throw failure();
          this.#header.fill(0);
          this.#body = Buffer.alloc(size);
          this.#bodySize = 0;
        }
        const count = Math.min(
          this.#body.length - this.#bodySize,
          chunk.length - offset,
        );
        this.#body.set(chunk.subarray(offset, offset + count), this.#bodySize);
        this.#bodySize += count;
        offset += count;
        if (this.#bodySize === this.#body.length) {
          const frame = {
            kind: this.#kind,
            sequence: this.#sequence,
            bytes: this.#body,
          };
          this.#body = undefined;
          this.#headerSize = 0;
          if (this.#waiter) {
            const waiter = this.#waiter;
            this.#waiter = undefined;
            waiter.resolve(frame);
          } else if (this.#frames.length < 2) this.#frames.push(frame);
          else {
            frame.bytes.fill(0);
            throw failure();
          }
        }
      }
    } catch {
      this.stop();
    } finally {
      chunk.fill(0);
    }
  };
  get receiveFinalized(): boolean {
    return this.#finalized && this.#peerEof && !this.#receiveFailed;
  }
  private finishReceive(): void {
    if (
      this.#receiveFailed ||
      this.#disposed ||
      this.#frames.length ||
      this.#headerSize ||
      this.#body
    ) {
      this.stop(true);
      return;
    }
    if (this.#peerEof) {
      this.#finalized = true;
      this.#terminalWaiter?.resolve();
      this.#terminalWaiter = undefined;
    }
  }
  /** A terminal frame is not EOF. Disposal cannot manufacture or erase transcript evidence. */
  async finalizeReceive(timeoutMs: number): Promise<void> {
    if (this.receiveFinalized) return;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000 ||
      this.#waiter ||
      this.#terminalWaiter
    )
      throw failure();
    this.#terminal = true;
    this.finishReceive();
    if (this.#receiveFailed || this.#disposed) throw failure();
    if (this.receiveFinalized) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.#terminalWaiter = { resolve, reject };
        timer = setTimeout(() => this.stop(true), timeoutMs);
      });
      if (!this.receiveFinalized) throw failure();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async read(timeoutMs: number): Promise<PatFrame> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000 ||
      this.#waiter
    )
      throw failure();
    const frame = this.#frames.shift();
    if (frame) return frame;
    if (this.#stopped || this.#ended) throw failure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<PatFrame>((resolve, reject) => {
        this.#waiter = { resolve, reject };
        timer = setTimeout(() => this.stop(), timeoutMs);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async send(
    kind: number,
    sequence: number,
    bytes: Uint8Array = Buffer.alloc(0),
  ): Promise<void> {
    if (
      this.#stopped ||
      !this.#nonce ||
      !valid(kind, sequence, bytes.byteLength) ||
      bytes.buffer instanceof SharedArrayBuffer ||
      ++this.#sent > 8
    )
      throw failure();
    const frame = Buffer.alloc(HEADER + bytes.length);
    frame.writeUInt32BE(bytes.length, 0);
    this.#nonce.copy(frame, 4);
    frame[36] = kind;
    frame[37] = sequence;
    frame.set(bytes, HEADER);
    const work = new Promise<void>((resolve, reject) => {
      try {
        this.pipe.write(frame, (error) =>
          error ? reject(failure()) : resolve(),
        );
      } catch {
        reject(failure());
      }
    });
    this.#writes.add(work);
    try {
      await work;
    } finally {
      frame.fill(0);
      this.#writes.delete(work);
    }
  }
  async close(): Promise<void> {
    this.stop(false);
    await Promise.allSettled([...this.#writes]);
    await this.#closed;
    this.pipe.removeListener("data", this.receive);
  }
}
