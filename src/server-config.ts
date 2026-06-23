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
