import type {
  AuthorizationContext,
  ResponseEnvelope,
} from "@design-studio/contracts";
import type { ROUTES } from "./routes.js";

export interface Invocation {
  operation: (typeof ROUTES)[number]["operation"] | "openapi";
  projectId: string;
  id?: string;
  requestId: string;
  parameters: Readonly<Record<string, string>>;
  body?: unknown;
  ifMatch?: string;
  ifNoneMatch?: string;
}
export type ApplicationResult =
  | { kind: "json"; envelope: ResponseEnvelope; status?: number; etag?: string }
  | {
      kind: "binary";
      bytes: Uint8Array;
      mediaType: "image/png" | "application/octet-stream" | "application/json";
      etag?: string;
      draft?: true;
    };
export interface ApplicationFacade {
  invoke(
    request: Invocation,
    authorization: AuthorizationContext,
    signal: AbortSignal,
  ): Promise<ApplicationResult>;
}
