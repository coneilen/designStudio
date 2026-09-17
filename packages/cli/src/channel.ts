import type { Duplex } from "node:stream";
import { ApplicationError } from "@design-studio/application";
import { type JsonValue, parseContract } from "@design-studio/contracts";

export class PrivateChannel {
  private bytes = Buffer.alloc(0);
  private values: JsonValue[] = [];
  private failure: ApplicationError | undefined;
  private waiter:
    | { resolve(value: JsonValue): void; reject(error: Error): void }
    | undefined;
  constructor(private readonly pipe: Duplex) {
    pipe.on("data", (input: Buffer) => {
      if (this.failure) return;
      if (input.length + this.bytes.length > 65540) {
        this.fail();
        return;
      }
      this.bytes = Buffer.concat([this.bytes, input]);
      while (this.bytes.length >= 4) {
        const size = this.bytes.readUInt32BE();
        if (size === 0 || size > 65536) {
          this.fail();
          return;
        }
        if (this.bytes.length < 4 + size) return;
        let value: JsonValue;
        try {
          value = parseContract(
            "JsonValue",
            this.bytes.subarray(4, 4 + size).toString("utf8"),
            "json",
          );
        } catch {
          this.fail();
          return;
        }
        this.bytes.fill(0, 0, 4 + size);
        this.bytes = this.bytes.subarray(4 + size);
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter.resolve(value);
        } else if (this.values.length < 4) this.values.push(value);
        else {
          this.fail();
          return;
        }
      }
    });
    pipe.on("error", () => this.fail());
    pipe.on("end", () => this.fail());
    pipe.on("close", () => this.fail());
  }
  private fail() {
    this.failure ??= new ApplicationError("TRANSPORT_UNAVAILABLE", 503);
    this.bytes.fill(0);
    this.bytes = Buffer.alloc(0);
    this.values = [];
    this.waiter?.reject(this.failure);
    this.waiter = undefined;
    this.pipe.destroy();
  }
  async read(timeoutMs: number): Promise<JsonValue> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000)
      throw new ApplicationError("INVALID_INPUT");
    if (this.failure) throw this.failure;
    if (this.waiter) throw new ApplicationError("CONFLICT");
    const value = this.values.shift();
    if (value !== undefined) return value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<JsonValue>((resolve, reject) => {
        this.waiter = { resolve, reject };
        timer = setTimeout(() => this.fail(), timeoutMs);
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async write(value: JsonValue): Promise<void> {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > 65536) throw new ApplicationError("INPUT_LIMIT");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);
    body.fill(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          this.fail();
          reject(new ApplicationError("DEADLINE_EXCEEDED", 504));
        }, 5000);
        this.pipe.write(frame, (error) => {
          clearTimeout(timer);
          if (error) reject(new ApplicationError("TRANSPORT_UNAVAILABLE"));
          else resolve();
        });
      });
    } finally {
      if (timer) clearTimeout(timer);
      frame.fill(0);
    }
  }
  close() {
    this.fail();
  }
}
