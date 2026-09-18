interface NativeTimingGroup {
  kind: string;
  calls: number;
  totalMs: number;
  maxMs: number;
}
export function nativeTimings(clock?: () => number): {
  measure<T>(kind: string, operation: () => T): T;
  report(): { samplingErrors: number; groups: NativeTimingGroup[] };
};
export const nativeCapture: ReturnType<typeof nativeTimings>;
