import {
  type Outcome,
  type StagedArtifact,
  validateContract,
} from "@design-studio/contracts";
import type { JobRepository, JobStageResult } from "@design-studio/storage";
import { expect, test } from "vitest";
import { detail } from "../src/boundary.js";
import type { JobExecution } from "../src/types.js";
import { fixture, makeService, output, value } from "./support.js";
import { observeSelectedTest } from "./test-observation.js";

for (const refresh of ["unavailable", "rejected"] as const) {
  test(`partial stage receipt survives ${refresh} journal refresh and cannot complete`, async ({
    signal,
    task,
  }) => {
    const observed = observeSelectedTest(task.name, signal);
    const settled = observed.pending();
    try {
      const f = await fixture({ observation: observed });
      let refreshPending = false;
      let original:
        | Extract<Outcome<JobStageResult>, { status: "partial" }>
        | undefined;
      const source = f.store.jobs;
      // Decorate an actual journaled SQLite stage with an admitted partial outcome.
      const repository = new Proxy(source, {
        get(target, property) {
          if (property === "stage") {
            const stage: JobRepository["stage"] = async (...args) => {
              const staged = value(await target.stage(...args));
              const partial: Extract<
                Outcome<JobStageResult>,
                { status: "partial" }
              > = {
                schemaVersion: "1.0",
                projectId: args[3].projectId,
                requestId: args[3].requestId,
                status: "partial",
                value: staged,
                missing: ["publication-confirmation"],
                error: {
                  ...detail("PROCESS_FAILED"),
                  message: "Original staging diagnosis.",
                },
                diagnosticIds: ["diagnostic-stage"],
              };
              original = partial;
              refreshPending = true;
              return partial;
            };
            return stage;
          }
          if (property === "get") {
            const get: JobRepository["get"] = async (...args) => {
              if (refreshPending && args[1].requestId === "work") {
                refreshPending = false;
                if (refresh === "rejected")
                  throw new Error("Synthetic refresh unavailable.");
                return {
                  schemaVersion: "1.0",
                  projectId: args[1].projectId,
                  requestId: args[1].requestId,
                  status: "unavailable",
                  error: detail("PROVIDER_UNAVAILABLE"),
                  diagnosticIds: [],
                };
              }
              return target.get(...args);
            };
            return get;
          }
          const member: unknown = Reflect.get(target, property);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      let received: Outcome<StagedArtifact> | undefined;
      let execution: JobExecution | undefined;
      const service = makeService(
        f,
        async (ex) => {
          execution = ex;
          received = await ex.stage(output);
          return {
            kind: "complete",
            completion: {
              outputs: received.status === "partial" ? [received.value] : [],
              outputState: "complete",
              diagnosticIds: [],
            },
          };
        },
        { repository },
      );
      observed.phase("submit");
      value(await service.submit(f.submission(), f.context()));
      observed.phase("run-once");
      value(await service.runOnce());
      observed.phase("attempt-wait");
      const final = value(
        await service.waitForAttempt("job-work", f.context()),
      );
      observed.phase("assertions");
      if (!original || !execution) throw new Error("Expected staged fixture.");
      const mapped = { ...original, value: original.value.staged };
      expect(validateContract("ProviderOutcome", original).success).toBe(true);
      expect(validateContract("ProviderOutcome", received).success).toBe(true);
      expect(received).toEqual(mapped);
      expect(
        "stageFailure" in execution ? execution.stageFailure : undefined,
      ).toEqual(mapped);
      expect(final.status).toBe("interrupted");
      expect(
        value(await f.store.jobs.getJobReceipt("job-work", f.context())),
      ).toBeNull();
      expect(
        value(await f.store.jobs.getStages("job-work", f.context()))[0]?.staged,
      ).toEqual(original.value.staged);
    } finally {
      settled();
    }
  });
}
