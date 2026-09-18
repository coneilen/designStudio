export const PROJECT_ID = "project_synthetic";
export const ARTIFACT_ROOT = "foundation_artifacts";
export const PERMISSION_SCOPE = "foundation_fixture_owner_v1";
export const COMMANDS = [
  "doctor",
  "fixtures init",
  "fixtures accept",
  "designs get",
  "revisions get",
  "render",
  "jobs get",
  "jobs wait",
  "jobs cancel",
  "artifacts get",
  "preview",
  "openapi",
  "help",
  "version",
  "serve",
  "with-session",
] as const;
export type Command = (typeof COMMANDS)[number];
export const USAGE: Record<Command, string> = {
  doctor: "designctl doctor [--json] [--project project_synthetic]",
  "fixtures init":
    "designctl fixtures init --project project_synthetic [--json] (explicit approved installation required)",
  "fixtures accept":
    "designctl fixtures accept <fixture-id> --branch <branch> (--new | --expected-base <revision> --if-match <quoted-sha256>) --request-id <key> [--json]",
  "designs get": "designctl designs get <design-id> [--branch main] [--json]",
  "revisions get": "designctl revisions get <revision-id> [--json]",
  render:
    "designctl render <design-id> --request-id <key> [--branch main] [--render-mode strict|inspection] [--async] [--json]",
  "jobs get": "designctl jobs get <job-id> [--json]",
  "jobs wait": "designctl jobs wait <job-id> [--timeout-ms 1..30000] [--json]",
  "jobs cancel":
    "designctl jobs cancel <job-id> --if-match <quoted-job-etag> --request-id <control-key> [--json]",
  "artifacts get":
    "designctl artifacts get <artifact-id> --sha256 <hash> [--output-root foundation_outputs --output-relative <relative-path>] [--json]",
  preview:
    "designctl preview <job-id> [--json] (verified unapproved PNG metadata; never opens a browser)",
  openapi: "designctl openapi [--json]",
  help: "designctl [command] --help [--json]",
  version: "designctl --version [--json]",
  serve:
    "Internal owned launcher: designctl serve --project project_synthetic --port <port> --control-fd 3 [--json]",
  "with-session":
    "designctl with-session --project project_synthetic -- <command> [arguments] [--json]",
};
export function commandHelp(name: string) {
  const command = COMMANDS.find((candidate) => candidate === name);
  return command
    ? USAGE[command]
    : `${COMMANDS.map((candidate) => USAGE[candidate]).join("\n")}\nGlobal: --json (noninteractive), --timeout-ms 1..30000, --mode local|api. API mode uses only owned inherited session pipes.`;
}
export const ROUTES = [
  {
    method: "GET",
    path: "/doctor",
    operation: "doctor",
    response: "ResponseEnvelope",
  },
  {
    method: "POST",
    path: "/designs/{designId}/revisions",
    operation: "acceptFixture",
    request: "FoundationAcceptFixtureRequest",
    response: "ResponseEnvelope",
  },
  {
    method: "GET",
    path: "/designs/{designId}",
    operation: "getDesign",
    response: "ResponseEnvelope",
  },
  {
    method: "GET",
    path: "/revisions/{revisionId}",
    operation: "getRevision",
    response: "ResponseEnvelope",
  },
  {
    method: "POST",
    path: "/designs/{designId}/render",
    operation: "submitRender",
    request: "FoundationRenderSubmissionRequest",
    response: "ResponseEnvelope",
  },
  {
    method: "GET",
    path: "/jobs/{jobId}",
    operation: "getJob",
    response: "FoundationVersionedJobResponse",
  },
  {
    method: "GET",
    path: "/jobs/{jobId}/wait",
    operation: "waitJob",
    response: "FoundationVersionedJobResponse",
  },
  {
    method: "POST",
    path: "/jobs/{jobId}/cancel",
    operation: "cancelJob",
    request: "FoundationCancelJobRequest",
    response: "FoundationVersionedJobResponse",
  },
  {
    method: "GET",
    path: "/artifacts/{artifactId}",
    operation: "getArtifact",
    response: "ResponseEnvelope",
  },
  {
    method: "GET",
    path: "/artifacts/{artifactId}/content",
    operation: "readArtifact",
    response: "binary",
  },
  {
    method: "GET",
    path: "/jobs/{jobId}/preview",
    operation: "getPreview",
    response: "binary",
  },
] as const;
export function jobEtag(id: string, version: number): string {
  return `"job:${id}:${version}"`;
}
