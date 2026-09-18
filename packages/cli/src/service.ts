import { Socket } from "node:net";
import {
  ApplicationError,
  createHttpSessions,
  listenHttp,
  PROJECT_ID,
  success,
} from "@design-studio/application";
import { openInstalledProject } from "@design-studio/application/installed";
import { PrivateChannel } from "./channel.js";
import { emitServiceQuiescence } from "./service-evidence.js";
import { stoppedFrame } from "./service-shutdown.js";

export class ServiceCleanupRequired extends ApplicationError {
  override readonly cause: unknown;
  constructor(
    cause: unknown,
    readonly cleanupFailures: readonly unknown[],
    readonly close: () => Promise<boolean>,
  ) {
    super("INTERRUPTED", 409);
    this.cause = cause;
  }
}
export async function serve(port: number, controlFd: string | undefined) {
  if (controlFd !== "3") throw new ApplicationError("ACTION_REQUIRED", 409);
  const control = new PrivateChannel(
    new Socket({ fd: 3, readable: true, writable: true }),
  );
  let project: Awaited<ReturnType<typeof openInstalledProject>> | undefined;
  let api: Awaited<ReturnType<typeof listenHttp>> | undefined;
  let apiClosed = false;
  let projectClosed = false;
  let channelClosed = false;
  let teardownEvidenceWritten = false;
  const recordErrorTeardown = async (failures: unknown[]) => {
    if (
      project &&
      projectClosed &&
      (!api || apiClosed) &&
      !teardownEvidenceWritten
    ) {
      try {
        await emitServiceQuiescence();
        teardownEvidenceWritten = true;
      } catch (error) {
        failures.push(error);
      }
    }
  };
  const closeOwned = async (): Promise<unknown[]> => {
    const failures: unknown[] = [];
    if (api && !apiClosed) {
      try {
        await api.close();
        apiClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (project && !projectClosed) {
      try {
        projectClosed = await project.close();
        if (!projectClosed)
          failures.push(new ApplicationError("INTERRUPTED", 409));
      } catch (error) {
        failures.push(error);
      }
    }
    if (!channelClosed) {
      try {
        control.close();
        channelClosed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };
  try {
    project = await openInstalledProject();
    const application = await project.application();
    api = await listenHttp(application.facade, createHttpSessions, port);
    const session = application.newClient(
      api.authenticator,
      `127.0.0.1:${api.port}`,
    );
    await control.write({
      kind: "ready",
      port: api.port,
      credential: session.credential,
    });
    for (;;) {
      const command = await control.read(180000);
      if (
        command &&
        typeof command === "object" &&
        !Array.isArray(command) &&
        command.kind === "keepalive"
      )
        continue;
      if (
        !command ||
        typeof command !== "object" ||
        Array.isArray(command) ||
        command.kind !== "stop"
      )
        throw new ApplicationError("INVALID_INPUT");
      await api.close();
      apiClosed = true;
      projectClosed = await project.close();
      if (!projectClosed) {
        await control.write({ kind: "interrupted" });
        continue;
      }
      await control.write(stoppedFrame());
      teardownEvidenceWritten = true;
      control.close();
      channelClosed = true;
      return success("service_stop", {
        kind: "service",
        projectId: PROJECT_ID,
        state: "stopped",
        warnings: [],
      });
    }
  } catch (error) {
    const failures = await closeOwned();
    await recordErrorTeardown(failures);
    if (failures.length)
      throw new ServiceCleanupRequired(error, failures, async () => {
        const retryFailures = await closeOwned();
        await recordErrorTeardown(retryFailures);
        return retryFailures.length === 0;
      });
    throw error;
  }
}
