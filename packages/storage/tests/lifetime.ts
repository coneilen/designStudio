import { AsyncLocalStorage } from "node:async_hooks";
import type { LocalStore } from "../src/index.js";

type TestStore = Pick<LocalStore, "close">;

const signals = new AsyncLocalStorage<AbortSignal>();
export function inStorageTest<T>(signal: AbortSignal, run: () => T): T {
  return signals.run(signal, run);
}
export function storageTestSignal(): AbortSignal {
  return signals.getStore() ?? new AbortController().signal;
}
async function joinStore(store: TestStore): Promise<void> {
  // Observe the actual serialized work, not a sleep or a forced SQLite close.
  for (;;) {
    const queue: unknown = Reflect.get(store, "queue");
    if (!(queue instanceof Promise))
      throw new Error("Synthetic storage fixture lacks its owned work queue.");
    await queue;
    await Promise.resolve();
    if (Reflect.get(store, "queue") === queue) break;
  }
}
export async function joinSettledStores(
  stores: readonly TestStore[],
): Promise<void> {
  for (const store of stores) await joinStore(store);
}
export async function closeSettledStores(stores: TestStore[]): Promise<void> {
  for (const store of stores) {
    await joinStore(store);
    store.close();
  }
  stores.length = 0;
}
