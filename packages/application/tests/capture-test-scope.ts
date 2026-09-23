import { AsyncLocalStorage } from "node:async_hooks";
import type { TestAPI } from "vitest";
import { AsyncTestScope } from "../../jobs/tests/async-scope.js";

const scopes = new AsyncLocalStorage<AsyncTestScope>();

export function inCaptureTest<T>(scope: AsyncTestScope, run: () => T): T {
  return scopes.run(scope, run);
}

export function captureTestScope(): AsyncTestScope {
  const scope = scopes.getStore();
  if (!scope)
    throw new Error("Capture fixture requires its original test scope.");
  return scope;
}

export function ownCaptureWork<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  scope = captureTestScope(),
): (...args: Args) => Promise<Result> {
  return (...args) => {
    if (scope.signal.aborted) return Promise.reject(scope.signal.reason);
    return scope.track(
      inCaptureTest(scope, () =>
        Promise.resolve().then(() => {
          scope.signal.throwIfAborted();
          return operation(...args);
        }),
      ),
    );
  };
}

/** Capture the original body promise, not the runner's timeout wrapper. */
export function ownCaptureTests(test: TestAPI): TestAPI {
  const handler: ProxyHandler<TestAPI> = {
    apply(target, receiver, args: unknown[]) {
      const index = args.findIndex((value) => typeof value === "function");
      const body = args[index];
      if (index < 0 || typeof body !== "function")
        return Reflect.apply(target, receiver, args);
      const owned = [...args];
      owned[index] = (...values: unknown[]) =>
        ownCaptureWork(async () => Reflect.apply(body, undefined, values))();
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
