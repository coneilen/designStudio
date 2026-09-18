import type { DesignIR, OperationContext } from "@design-studio/contracts";

export function inspectContractTypes(
  design: DesignIR,
  context: OperationContext,
): string {
  return `${design.schemaVersion}:${context.projectId}`;
}
