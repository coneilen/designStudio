import { isBuiltin, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Internal primitive. Production callers need an owned, verified installation lease. */
export function guardResolution(
  filenames: readonly string[],
  scopes: readonly { scope: string; modules: string }[] = [],
): { close(): void } {
  if (process.version !== "v24.21.0")
    throw new Error("Installation resolver requires reviewed Node 24.21.0.");
  const files = new Set(
    filenames.map((filename) => path.resolve(filename).toLowerCase()),
  );
  let closed = false;
  const check = (url: string) => {
    if (closed) throw new Error("Installation resolver is closed.");
    if (isBuiltin(url)) return;
    const parsed = new URL(url);
    if (
      parsed.protocol !== "file:" ||
      parsed.search ||
      parsed.hash ||
      parsed.host ||
      !files.has(path.resolve(fileURLToPath(parsed)).toLowerCase())
    )
      throw new Error(
        "Module resolution outside the verified installation is forbidden.",
      );
  };
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      check(result.url);
      if (
        scopes.length &&
        !isBuiltin(specifier) &&
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(specifier)
      ) {
        const parent = context.parentURL?.startsWith("file:")
          ? fileURLToPath(context.parentURL).toLowerCase()
          : "";
        const scope = scopes.find((item) =>
          parent.startsWith(`${item.scope.toLowerCase()}${path.sep}`),
        );
        const segments = specifier.split("/");
        const name = specifier.startsWith("@")
          ? segments.slice(0, 2)
          : segments.slice(0, 1);
        const packageRoot = scope
          ? path.join(scope.modules, ...name).toLowerCase()
          : "";
        if (
          !packageRoot ||
          !fileURLToPath(result.url)
            .toLowerCase()
            .startsWith(`${packageRoot}${path.sep}`)
        )
          throw new Error(
            "Global/ancestor package resolution fallback is forbidden.",
          );
      }
      return result;
    },
    load(url, context, nextLoad) {
      check(url);
      return nextLoad(url, context);
    },
  });
  return Object.freeze({
    close() {
      if (!closed) {
        hook.deregister();
        closed = true;
      }
    },
  });
}
