import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { guardResolution } from "./resolver.mjs";

const require = createRequire(import.meta.url);
const guard = guardResolution(
  ["good.cjs", "good.mjs"].map((name) =>
    fileURLToPath(new URL(name, import.meta.url)),
  ),
);
try {
  const esm = (await import("./good.mjs")).default;
  const common = require("./good.cjs");
  const created = createRequire(new URL("good.mjs", import.meta.url))(
    "./good.cjs",
  );
  let denied = 0;
  for (const operation of [
    () => import("../outside.cjs"),
    () => require("../outside.cjs"),
    () => createRequire(import.meta.url)("../outside.cjs"),
  ]) {
    try {
      await operation();
    } catch (error) {
      if (!String(error).includes("outside the verified installation"))
        throw error;
      denied++;
    }
  }
  process.stdout.write(
    JSON.stringify({ esm, require: common, createRequire: created, denied }),
  );
} finally {
  guard.close();
}
