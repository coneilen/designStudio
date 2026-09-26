import type { Artifact, CommitReceipt } from "@design-studio/contracts";

export interface ReferenceForkBinding {
  version: 1;
  operationId: string;
  projectId: string;
  artifactRootId: string;
  actorId: string;
  sourceProjectId: string;
  originSha256: string;
  resultSha256: string;
  policySha256: string;
}
export interface ReferenceForkReservation {
  binding: ReferenceForkBinding;
  hostId: string;
  stages: { stagingId: string; artifact: Artifact }[];
  staged: number;
  receipt?: CommitReceipt;
}
export const referenceForkSchema = `
  CREATE TABLE reference_fork (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL);
`;
