import * as core from "@actions/core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Server-driven buildkitd daemon configuration.
 * Returned by the GetStickyDisk RPC (Phase 2).
 * When absent, the action falls back to DEFAULT_BUILDKITD_CONFIG.
 */
export interface GCPolicy {
  keepDuration?: string;
  keepBytes?: number;
  all?: boolean;
  filters?: string[];
}

export interface BuildkitdConfig {
  gc: boolean;
  gcPolicy?: GCPolicy[];
  maxParallelism?: number;
}

/**
 * Server-driven pre-commit hook definition.
 * Returned by the PrepareCommit RPC (Phase 3).
 */
export interface PreCommitHook {
  command: string;
  timeoutSeconds?: number;
  failureMode: "skip_commit" | "commit_anyway" | "abort";
}

/**
 * Response from the PrepareCommit RPC (Phase 3).
 * When the RPC is unavailable (old agent), the action falls back to
 * unconditional commit with no hooks.
 */
export interface PrepareCommitResponse {
  shouldCommit: boolean;
  hooks: PreCommitHook[];
}

export const DEFAULT_BUILDKITD_CONFIG: BuildkitdConfig = {
  gc: true,
  gcPolicy: [
    {
      keepDuration: "192h",
      all: true,
    },
  ],
};

// Bounds for the backend-supplied GC keepDuration. Anything outside is
// treated as a backend bug and ignored rather than written into buildkitd.toml.
export const MIN_GC_KEEP_DURATION_HOURS = 1;
export const MAX_GC_KEEP_DURATION_HOURS = 8760;

/**
 * Builds the buildkitd config for this job from the GC keepDuration (whole
 * hours) the backend attached to the sticky disk. The backend only overrides
 * the TTL; every other default is kept. Missing or invalid values yield
 * DEFAULT_BUILDKITD_CONFIG so an old agent/backend, or a bad rollout value,
 * never changes GC behavior.
 */
export function buildkitdConfigFromServer(
  gcKeepDurationHours: bigint | number | undefined,
): BuildkitdConfig {
  if (gcKeepDurationHours === undefined || gcKeepDurationHours === 0) {
    core.info(
      `No buildkitd GC policy from backend; using default keepDuration ${DEFAULT_BUILDKITD_CONFIG.gcPolicy?.[0]?.keepDuration}`,
    );
    return DEFAULT_BUILDKITD_CONFIG;
  }

  const hours = Number(gcKeepDurationHours);
  if (
    !Number.isInteger(hours) ||
    hours < MIN_GC_KEEP_DURATION_HOURS ||
    hours > MAX_GC_KEEP_DURATION_HOURS
  ) {
    core.warning(
      `Ignoring invalid buildkitd GC keepDuration from backend: ${String(gcKeepDurationHours)}h ` +
        `(expected ${MIN_GC_KEEP_DURATION_HOURS}-${MAX_GC_KEEP_DURATION_HOURS}); using default ` +
        `${DEFAULT_BUILDKITD_CONFIG.gcPolicy?.[0]?.keepDuration}`,
    );
    return DEFAULT_BUILDKITD_CONFIG;
  }

  const keepDuration = `${hours}h`;
  core.info(`Using backend buildkitd GC keepDuration ${keepDuration}`);
  return {
    ...DEFAULT_BUILDKITD_CONFIG,
    gcPolicy: (DEFAULT_BUILDKITD_CONFIG.gcPolicy ?? []).map((policy) => ({
      ...policy,
      keepDuration,
    })),
  };
}

// `max-cache-size-mb` uses the same decimal megabytes as
// `buildctl prune --keep-storage` and the v1 input: 1 MB = 1,000,000 bytes.
export const BYTES_PER_MB = 1_000_000;

/**
 * Parses the `max-cache-size-mb` input. Returns the limit in MB, or null when
 * the input is empty or invalid (invalid values only warn, so a typo never
 * fails the build). Zero is rejected: buildkit treats a zero byte limit as
 * "no limit" in gcpolicy but as "delete everything" in `prune --keep-storage`.
 */
export function parseMaxCacheSizeMB(input: string): number | null {
  const value = input.trim();
  if (value === "") {
    return null;
  }

  const mb = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(mb * BYTES_PER_MB) || mb <= 0) {
    core.warning(
      `Invalid max-cache-size-mb value '${input}', ignoring. Must be a positive integer number of MB (e.g. 51200 for 50 GB).`,
    );
    return null;
  }

  return mb;
}

/**
 * Adds a size-bounded GC policy to a buildkitd config. The existing policies
 * (the age-based keepDuration, possibly set by the backend) still run first;
 * the extra `all = true, keepBytes = N` policy then evicts least recently used
 * cache records until the cache fits in N bytes. buildkitd runs GC shortly
 * after it starts and after builds, so an oversized cache restored from the
 * sticky disk is trimmed at the start of the job as well. The `gc` flag is
 * left as is; the post step's prune enforces the limit either way.
 *
 * `keepBytes` is used rather than the newer `maxUsedSpace` because every
 * buildkit release accepts it; on buildkit >= v0.17 it maps to
 * `reservedSpace`, which caps usage the same way when no other space limit
 * is set on the policy.
 */
export function withMaxCacheSize(
  config: BuildkitdConfig,
  maxCacheSizeMB: number | null,
): BuildkitdConfig {
  if (maxCacheSizeMB === null) {
    return config;
  }

  return {
    ...config,
    gcPolicy: [
      ...(config.gcPolicy ?? []),
      { all: true, keepBytes: maxCacheSizeMB * BYTES_PER_MB },
    ],
  };
}

/**
 * Runs an ordered list of pre-commit hooks. Returns whether the commit
 * should proceed based on hook results and their failure modes.
 */
export async function runPreCommitHooks(
  hooks: PreCommitHook[],
): Promise<{ shouldProceedWithCommit: boolean }> {
  for (const hook of hooks) {
    const timeout = hook.timeoutSeconds ?? 300;
    core.info(
      `Running pre-commit hook: ${hook.command} (timeout: ${timeout}s)`,
    );

    try {
      const { stdout, stderr } = await execAsync(hook.command, {
        timeout: timeout * 1000,
      });
      if (stdout) core.debug(`Hook stdout: ${stdout.slice(0, 1000)}`);
      if (stderr) core.debug(`Hook stderr: ${stderr.slice(0, 1000)}`);
      core.info(`Pre-commit hook completed successfully`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      core.warning(`Pre-commit hook failed: ${errorMsg}`);

      switch (hook.failureMode) {
        case "skip_commit":
          core.warning("Hook failure mode is skip_commit, skipping commit");
          return { shouldProceedWithCommit: false };
        case "abort":
          core.error("Hook failure mode is abort, failing the action");
          throw new Error(`Pre-commit hook aborted: ${errorMsg}`);
        case "commit_anyway":
          core.warning("Hook failure mode is commit_anyway, continuing");
          break;
      }
    }
  }

  return { shouldProceedWithCommit: true };
}
