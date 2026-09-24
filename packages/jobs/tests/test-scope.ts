import { AsyncLocalStorage } from "node:async_hooks";
import type { TestAPI } from "vitest";
import { AsyncTestScope } from "./async-scope.js";

const scopes = new AsyncLocalStorage<AsyncTestScope>();

export function inTestScope<T>(scope: AsyncTestScope, run: () => T): T {
  return scopes.run(scope, run);
}

export function testScope(): AsyncTestScope {
  const scope = scopes.getStore();
  if (!scope) throw new Error("Fixture requires its original test scope.");
  return scope;
}

export function ownTestWork<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  scope = testScope(),
): (...args: Args) => Promise<Result> {
  return (...args) => {
    if (scope.signal.aborted) return Promise.reject(scope.signal.reason);
    return scope.track(
      inTestScope(scope, () =>
        Promise.resolve().then(() => {
          scope.signal.throwIfAborted();
          return operation(...args);
        }),
      ),
    );
  };
}

/** Capture the original body promise, not the runner's timeout wrapper. */
export function ownTests(test: TestAPI): TestAPI {
  const handler: ProxyHandler<TestAPI> = {
    apply(target, receiver, args: unknown[]) {
      const index = args.findIndex((value) => typeof value === "function");
      const body = args[index];
      if (index < 0 || typeof body !== "function")
        return Reflect.apply(target, receiver, args);
      const owned = [...args];
      owned[index] = (...values: unknown[]) =>
        ownTestWork(async () => Reflect.apply(body, undefined, values))();
      return Reflect.apply(target, receiver, owned);
    },
    get(target, key, receiver) {
      if (key === "each")
        return (...cases: unknown[]) =>
          new Proxy(Reflect.apply(target.each, target, cases), handler);
      return Reflect.get(target, key, receiver);
    },
  };
  return new Proxy(test, handler);
}

export { AsyncTestScope };
