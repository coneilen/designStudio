import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalStore } from "../src/index.js";

const signals = new AsyncLocalStorage<AbortSignal>();
export function inStorageTest<T>(signal: AbortSignal, run: () => T): T {
  return signals.run(signal, run);
}
export function storageTestSignal(): AbortSignal {
  return signals.getStore() ?? new AbortController().signal;
}
export async function closeSettledStores(stores: LocalStore[]): Promise<void> {
  for (const store of stores) {
    // Observe the actual serialized work, not a sleep or a forced SQLite close.
    for (;;) {
      const queue: unknown = Reflect.get(store, "queue");
      if (!(queue instanceof Promise))
        throw new Error(
          "Synthetic storage fixture lacks its owned work queue.",
        );
      await queue;
      await Promise.resolve();
      if (Reflect.get(store, "queue") === queue) break;
    }
    store.close();
  }
  stores.length = 0;
}
