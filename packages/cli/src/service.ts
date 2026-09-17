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

export async function serve(port: number, controlFd: string | undefined) {
  if (controlFd !== "3") throw new ApplicationError("ACTION_REQUIRED", 409);
  const control = new PrivateChannel(
    new Socket({ fd: 3, readable: true, writable: true }),
  );
  const project = await openInstalledProject();
  let api: Awaited<ReturnType<typeof listenHttp>> | undefined;
  try {
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
      if (!(await project.close())) {
        await control.write({ kind: "interrupted" });
        continue;
      }
      await control.write({ kind: "stopped" });
      control.close();
      return success("service_stop", {
        kind: "service",
        projectId: PROJECT_ID,
        state: "stopped",
        warnings: [],
      });
    }
  } catch (error) {
    if (api) await api.close();
    if (!(await project.close()))
      throw new ApplicationError("INTERRUPTED", 409);
    control.close();
    throw error;
  }
}
