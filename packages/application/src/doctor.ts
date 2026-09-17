import { release } from "node:os";
import {
  DEFAULT_BUDGETS,
  type ProviderCapabilities,
} from "@design-studio/contracts";
import { ApplicationError } from "./response.js";
import { PROJECT_ID } from "./routes.js";
export function doctor(): ProviderCapabilities {
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new ApplicationError("UNSUPPORTED_HOST", 503);
  const windows = process.platform === "win32" && process.arch === "x64";
  return {
    schemaVersion: "1.0",
    providerId: "foundation_application",
    projectId: PROJECT_ID,
    implementation: "production",
    host: {
      os:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux",
      version: release(),
      architecture: process.arch,
      evidence: "observed",
    },
    operations: [
      {
        operation: "runtime",
        availability:
          windows && process.versions.node === "24.21.0"
            ? "available"
            : "unavailable",
        evidence: "observed",
        limitations: [
          `Node ${process.versions.node}; ABI ${process.versions.modules}; Windows x64 required.`,
        ],
      },
      {
        operation: "storage",
        availability: "unverified",
        evidence: "unverified",
        limitations: [
          "Requires registered private fixture root, exact SQLite prebuild and native publication. No write probe performed.",
        ],
      },
      {
        operation: "render",
        availability: "unverified",
        evidence: "unverified",
        limitations: [
          "Requires approved installed worker/browser closure. No browser launched.",
        ],
      },
      {
        operation: "fonts",
        availability: "unverified",
        evidence: "documented",
        limitations: [
          "Pinned bundled ABeeZee Regular only; no installed-font enumeration or actual-use check performed.",
        ],
      },
      ...[
        "figma",
        "device",
        "model",
        "browser-enrollment",
        "handoff",
        "migration-backup-durability",
      ].map((operation) => ({
        operation,
        availability: "unavailable" as const,
        evidence: "documented" as const,
        limitations: [
          "Not implemented by the fixture foundation; no adapter or user resource inspected.",
        ],
      })),
    ],
    cancellation: "cooperative",
    deadline: "required",
    limits: { ...DEFAULT_BUDGETS },
  };
}
