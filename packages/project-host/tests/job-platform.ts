/** The native Job bridge verifies only the Windows x64 ABI. */
export function supportsNativeJob(
  platform: string,
  architecture: string,
): boolean {
  return platform === "win32" && architecture === "x64";
}
