import { readBrowserInventory } from "../../scripts/package-candidate.mjs";

try {
  const inventory = await readBrowserInventory(process.argv[2]);
  process.stdout.write(
    JSON.stringify({ status: "accepted", files: inventory.files.length }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      status: "rejected",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}
