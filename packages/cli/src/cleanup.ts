import { ApplicationError } from "@design-studio/application";

class IncompleteCleanup extends ApplicationError {
  override readonly cause: unknown;
  constructor(
    cause: unknown,
    readonly close: () => Promise<boolean>,
    readonly cleanupFailure?: unknown,
  ) {
    super("INTERRUPTED", 409);
    this.cause = cause;
  }
}
export async function usingProject<T>(
  project: { close(): Promise<boolean> },
  operation: () => Promise<T>,
): Promise<T> {
  let result: { value: T } | { error: unknown };
  try {
    result = { value: await operation() };
  } catch (error) {
    result = { error };
  }
  let closed: boolean;
  try {
    closed = await project.close();
  } catch (error) {
    throw new IncompleteCleanup(
      "error" in result ? result.error : undefined,
      project.close.bind(project),
      error,
    );
  }
  if (!closed)
    throw new IncompleteCleanup(
      "error" in result ? result.error : undefined,
      project.close.bind(project),
    );
  if ("error" in result) throw result.error;
  return result.value;
}
