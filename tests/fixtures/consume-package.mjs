import { readFileSync } from "node:fs";
import { fingerprintFixture } from "@design-studio/workspace-smoke";

process.stdout.write(fingerprintFixture(readFileSync(process.argv[2])));
