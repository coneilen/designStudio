import type { Writable } from "node:stream";
import { HostBoundaryError } from "@design-studio/host";

export const Kind = {
  joined: 1,
  start: 2,
  ready: 3,
  request: 4,
  result: 5,
  cancel: 6,
  close: 7,
  closed: 8,
  error: 9,
} as const;
export interface Frame {
  kind: number;
  sequence: number;
  bytes: Buffer;
}
export const OVERHEAD = 41;
export function encode(
  nonce: string,
  kind: number,
  sequence: number,
  bytes = Buffer.alloc(0),
): Buffer {
  const frame = Buffer.alloc(OVERHEAD + bytes.length);
  frame.writeUInt32BE(frame.length - 4, 0);
  Buffer.from(nonce, "hex").copy(frame, 4);
  frame[36] = kind;
  frame.writeUInt32BE(sequence, 37);
  bytes.copy(frame, OVERHEAD);
  return frame;
}
export function send(stream: Writable, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => {
      if (error)
        reject(
          new HostBoundaryError(
            "PROCESS_FAILED",
            "Worker transport write failed.",
            false,
            { cause: error },
          ),
        );
      else resolve();
    });
  });
}
/** Allocates a body only after the fixed header passes its bound. Never queues frames. */
export class FrameReader {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private stopped = false;
  constructor(
    private readonly nonce: string,
    private readonly maxBytes: number,
    private readonly frame: (frame: Frame) => void,
  ) {}
  stop(): void {
    this.stopped = true;
    this.body = undefined;
  }
  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.stopped) {
      if (!this.body) {
        const count = Math.min(4 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 4) continue;
        const length = this.header.readUInt32BE(0);
        if (length < OVERHEAD - 4 || length > this.maxBytes + OVERHEAD - 4)
          throw new HostBoundaryError(
            "OUTPUT_LIMIT",
            "Worker frame length is outside its bound.",
          );
        this.body = Buffer.alloc(length);
        this.bodyBytes = 0;
      }
      const count = Math.min(
        this.body.length - this.bodyBytes,
        chunk.length - offset,
      );
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count;
      offset += count;
      if (this.bodyBytes === this.body.length) {
        const body = this.body;
        this.body = undefined;
        this.headerBytes = 0;
        if (body.subarray(0, 32).toString("hex") !== this.nonce)
          throw new HostBoundaryError(
            "FORBIDDEN",
            "Worker transport nonce mismatch.",
          );
        this.frame({
          kind: body[32] ?? 0,
          sequence: body.readUInt32BE(33),
          bytes: body.subarray(37),
        });
      }
    }
  }
}
