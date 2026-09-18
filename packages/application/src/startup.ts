import { ApplicationError } from "./response.js";

export class StartupCleanupRequired extends ApplicationError {
  override readonly cause: unknown;
  readonly cleanupFailure: unknown;
  constructor(
    cause: unknown,
    readonly close: () => Promise<boolean>,
    cleanupFailure?: unknown,
  ) {
    super("INTERRUPTED", 409);
    this.cause = cause;
    this.cleanupFailure = cleanupFailure;
  }
}
export async function startOwnedApplication(
  start: () => Promise<void>,
  close: () => Promise<boolean>,
): Promise<void> {
  try {
    await start();
  } catch (failure) {
    let quiescent: boolean;
    try {
      quiescent = await close();
    } catch (cleanupFailure) {
      throw new StartupCleanupRequired(failure, close, cleanupFailure);
    }
    if (!quiescent) throw new StartupCleanupRequired(failure, close);
    throw failure;
  }
}
