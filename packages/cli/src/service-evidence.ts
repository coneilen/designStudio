import { ApplicationError, PROJECT_ID } from "@design-studio/application";
export const SERVICE_QUIESCENCE_PREFIX = "DESIGNCTL_SERVICE_QUIESCENCE ";
export function quiescenceRecord(): string {
  return `${SERVICE_QUIESCENCE_PREFIX}${JSON.stringify({ kind: "quiescent", projectId: PROJECT_ID, requestId: "service_stop" })}\n`;
}
export async function emitServiceQuiescence(): Promise<void> {
  const record = quiescenceRecord();
  if (Buffer.byteLength(record) > 512)
    throw new ApplicationError("INTERNAL_ERROR");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ApplicationError("INTERRUPTED", 409)),
      5000,
    );
    try {
      process.stderr.write(record, (error) => {
        clearTimeout(timer);
        if (error) reject(new ApplicationError("INTERRUPTED", 409));
        else resolve();
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
