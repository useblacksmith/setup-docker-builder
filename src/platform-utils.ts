import * as os from "os";

/**
 * Resolve the platform list that should be passed to `docker buildx create`.
 *
 * Priority:
 *   1. Use the user-supplied platforms list (comma-joined) if provided.
 *   2. Fallback to the architecture of the host runner.
 */
export function resolveRemoteBuilderPlatforms(platforms?: string[]): string {
  // If user explicitly provided platforms, honour them verbatim.
  if (platforms && platforms.length > 0) {
    return platforms.join(",");
  }

  // Otherwise derive from host architecture.
  const nodeArch = os.arch(); // e.g. 'x64', 'arm64', 'arm'
  const archMap: { [key: string]: string } = {
    x64: "amd64",
    arm64: "arm64",
    arm: "arm",
  };
  const mappedArch = archMap[nodeArch] || nodeArch;
  return `linux/${mappedArch}`;
}
