import { request } from "node:http";
import { connect } from "node:net";
import { LocalSessionAuthenticator, SystemClock } from "@design-studio/host";
import { afterEach, expect, it } from "vitest";
import { listenHttp } from "../src/http.js";
import { success } from "../src/response.js";

const running: Awaited<ReturnType<typeof listenHttp>>[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
async function fixture() {
  let calls = 0;
  const server = await listenHttp(
    {
      async invoke(invocation) {
        calls++;
        return {
          kind: "json",
          envelope: success(invocation.requestId, {
            kind: "service",
            projectId: "project_synthetic",
            state: "stopped",
            warnings: [],
          }),
        };
      },
    },
    (host) =>
      new LocalSessionAuthenticator({
        clock: new SystemClock(),
        hosts: [host],
        origins: [`http://${host}`],
      }),
  );
  running.push(server);
  const authorization = {
    schemaVersion: "1.0" as const,
    projectId: "project_synthetic",
    actorId: "fixture_actor",
    sessionId: "owned_session",
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    grants: [],
    egress: "deny" as const,
  };
  const cli = server.authenticator.createSession(authorization, "cli");
  const browser = server.authenticator.createSession(authorization, "browser");
  return { server, cli, browser, calls: () => calls };
}
function get(
  port: number,
  headers: Record<string, string> = {},
  path = "/v1/projects/project_synthetic/doctor",
  method = "GET",
  body?: string,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8").on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
it("uses real owned loopback authentication before facade effects", async () => {
  const f = await fixture();
  expect((await get(f.server.port)).status).toBe(401);
  expect(f.calls()).toBe(0);
  expect(
    (await get(f.server.port, { Authorization: `Bearer ${f.cli.credential}` }))
      .status,
  ).toBe(200);
  expect(f.calls()).toBe(1);
});
it("rejects foreign Host, browser-origin bearer, and all Fetch-Metadata", async () => {
  const f = await fixture();
  for (const extra of [
    { Host: "evil.invalid" },
    { Origin: "https://evil.invalid" },
    { "Sec-Fetch-Mode": "navigate" },
  ]) {
    expect(
      (
        await get(f.server.port, {
          Authorization: `Bearer ${f.cli.credential}`,
          ...extra,
        })
      ).status,
    ).toBe(403);
  }
  expect(f.calls()).toBe(0);
});
it("preissued browser cookies need Origin even on navigation and CSRF on unsafe requests", async () => {
  const f = await fixture();
  const cookie = { Cookie: `design_session=${f.browser.credential}` };
  expect((await get(f.server.port, cookie)).status).toBe(403);
  const origin = {
    ...cookie,
    Origin: `http://127.0.0.1:${f.server.port}`,
    "Sec-Fetch-Site": "same-origin",
  };
  expect((await get(f.server.port, origin)).status).toBe(200);
  expect(
    (
      await get(
        f.server.port,
        origin,
        "/v1/projects/project_synthetic/jobs/job_1/cancel",
        "POST",
        "{}",
      )
    ).status,
  ).toBe(403);
  expect(f.calls()).toBe(1);
});
it("rejects duplicate Host from a real socket without invoking the application", async () => {
  const f = await fixture();
  const received = await new Promise<string>((resolve, reject) => {
    let data = "";
    const socket = connect(f.server.port, "127.0.0.1", () =>
      socket.end(
        `GET /v1/projects/project_synthetic/doctor HTTP/1.1\r\nHost: 127.0.0.1:${f.server.port}\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.setEncoding("utf8").on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  expect(received).toContain("400");
  expect(f.calls()).toBe(0);
});
it("rejects missing mutation preconditions, encoded paths and oversized bodies before effects", async () => {
  const f = await fixture();
  const headers = {
    Authorization: `Bearer ${f.cli.credential}`,
    "Content-Type": "application/json",
  };
  expect(
    (
      await get(
        f.server.port,
        headers,
        "/v1/projects/project_synthetic/jobs/job_1/cancel",
        "POST",
        "{}",
      )
    ).status,
  ).toBe(428);
  expect(
    (await get(f.server.port, headers, "/v1/projects/project_synthetic/%2e%2e"))
      .status,
  ).toBe(400);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "Content-Length": "65537" },
        "/v1/projects/project_synthetic/designs/design_1/revisions",
        "POST",
        "x",
      )
    ).status,
  ).toBe(413);
  expect(f.calls()).toBe(0);
});
it("rejects duplicate JSON keys, compression, weak ETags and changed-target job conditions", async () => {
  const f = await fixture();
  const headers = {
    Authorization: `Bearer ${f.cli.credential}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "control_1",
    "If-Match": '"job:job_1:1"',
  };
  const target = "/v1/projects/project_synthetic/jobs/job_1/cancel";
  expect(
    (await get(f.server.port, headers, target, "POST", '{"x":1,"x":2}')).status,
  ).toBe(400);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "Content-Encoding": "gzip" },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(415);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "If-Match": 'W/"job:job_1:1"' },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "If-Match": '"job:other:1"' },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "If-Match": '"job:job_1:9007199254740992"' },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(400);
  expect(f.calls()).toBe(0);
});
it("allows seeded browser mutation only with independently correct CSRF, never mixed credentials", async () => {
  const f = await fixture();
  const headers = {
    Cookie: `design_session=${f.browser.credential}`,
    Origin: `http://127.0.0.1:${f.server.port}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "control_1",
    "If-Match": '"job:job_1:1"',
    "X-CSRF-Token": f.browser.csrf,
  };
  const target = "/v1/projects/project_synthetic/jobs/job_1/cancel";
  expect((await get(f.server.port, headers, target, "POST", "{}")).status).toBe(
    200,
  );
  expect(
    (
      await get(
        f.server.port,
        { ...headers, Authorization: `Bearer ${f.cli.credential}` },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await get(
        f.server.port,
        { ...headers, "X-CSRF-Token": "wrong" },
        target,
        "POST",
        "{}",
      )
    ).status,
  ).toBe(403);
  expect(f.calls()).toBe(1);
});
