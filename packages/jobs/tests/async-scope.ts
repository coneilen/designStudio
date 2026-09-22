/** Test-owned async work must quiesce before its spies/filesystem are released. */
export class AsyncTestScope {
  private readonly controller = new AbortController();
  private readonly releases = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly aborted = () => this.cancel();
  constructor(private readonly original: AbortSignal) {
    original.addEventListener("abort", this.aborted, { once: true });
    if (original.aborted) this.cancel();
  }
  get signal() {
    return this.controller.signal;
  }
  releaseOnEnd(release: () => void) {
    if (this.signal.aborted) release();
    else this.releases.add(release);
  }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  notify() {
    for (const listener of [...this.listeners]) listener();
  }
  until<T>(read: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.listeners.delete(check);
        this.signal.removeEventListener("abort", check);
      };
      const check = () => {
        if (this.signal.aborted) {
          stop();
          reject(this.signal.reason);
          return;
        }
        try {
          const value = read();
          if (value !== undefined) {
            stop();
            resolve(value);
          }
        } catch (error) {
          stop();
          reject(error);
        }
      };
      this.listeners.add(check);
      this.signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
  wait<T>(promise: Promise<T>): Promise<T> {
    let result: { value: T } | { error: unknown } | undefined;
    void promise.then(
      (value) => {
        result = { value };
        this.notify();
      },
      (error: unknown) => {
        result = { error };
        this.notify();
      },
    );
    return this.until(() => result).then((outcome) => {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    });
  }
  cancel() {
    if (this.signal.aborted) return;
    this.controller.abort(new Error("Owned synthetic test work cancelled"));
    for (const release of this.releases) release();
    this.releases.clear();
  }
  async join() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  async close() {
    this.cancel();
    await this.join();
    this.original.removeEventListener("abort", this.aborted);
  }
}
