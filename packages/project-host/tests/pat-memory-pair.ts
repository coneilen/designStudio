import { Duplex, type TransformCallback } from "node:stream";

/** Memory transport with socket-like ordered bytes and peer EOF, never native/UI I/O. */
export class PatMemoryPipe extends Duplex {
  peer?: PatMemoryPipe;
  endPeerOnDestroy = true;
  override _read() {}
  override _write(
    bytes: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("Synthetic peer closed"));
      return;
    }
    this.peer.push(Buffer.from(bytes));
    callback();
  }
  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void,
  ) {
    if (this.endPeerOnDestroy) this.peer?.push(null);
    callback(error);
  }
}
export function patMemoryPair() {
  const parent = new PatMemoryPipe();
  const child = new PatMemoryPipe();
  parent.peer = child;
  child.peer = parent;
  return { parent, child };
}
