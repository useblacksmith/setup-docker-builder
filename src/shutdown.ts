import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as stateHelper from "./state-helper";

const execAsync = promisify(exec);

/**
 * Stops buildkitd. Resolves to `false` when no buildkitd process existed by
 * the time SIGTERM was sent (it already exited on its own); the sticky disk
 * is still intact in that case and the caller decides how to report it.
 */
export async function shutdownBuildkitd(): Promise<boolean> {
  const gracefulTimeout = 30000; // 30 seconds for graceful shutdown.
  const forceTimeout = 5000; // 5 seconds for forced shutdown.
  const backoff = 300; // 300ms.

  try {
    // Step 1: Try graceful shutdown with SIGTERM.
    core.info("Sending SIGTERM to buildkitd for graceful shutdown");
    try {
      await execAsync(`sudo pkill -TERM buildkitd`);
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        // pkill returns exit code 1 when no process matched.
        core.warning("buildkitd is not running; nothing to shut down");
        return false;
      }
      throw error;
    }

    // Wait for graceful shutdown.
    const gracefulStartTime = Date.now();
    while (Date.now() - gracefulStartTime < gracefulTimeout) {
      try {
        const { stdout } = await execAsync("pgrep buildkitd");
        core.debug(
          `buildkitd process still running with PID: ${stdout.trim()}, waiting for graceful shutdown`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } catch (error) {
        if ((error as { code?: number }).code === 1) {
          // pgrep returns exit code 1 when no process is found, which means shutdown successful.
          core.info("buildkitd successfully shutdown gracefully");
          return true;
        }
        // Some other error occurred.
        throw error;
      }
    }

    // Step 2: If graceful shutdown failed, try force kill with SIGKILL.
    core.warning(
      `buildkitd did not shutdown gracefully after ${gracefulTimeout / 1000} seconds, forcing shutdown with SIGKILL`,
    );
    try {
      await execAsync(`sudo pkill -KILL buildkitd`);
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        core.info("buildkitd exited before SIGKILL was sent");
        return true;
      }
      throw error;
    }
    core.warning(
      "Disk may be in a bad state after SIGKILL - will prevent sticky disk commit",
    );
    stateHelper.setSigkillUsed(true);

    // Wait for forced shutdown.
    const forceStartTime = Date.now();
    while (Date.now() - forceStartTime < forceTimeout) {
      try {
        const { stdout } = await execAsync("pgrep buildkitd");
        core.debug(
          `buildkitd process still running after SIGKILL with PID: ${stdout.trim()}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } catch (error) {
        if ((error as { code?: number }).code === 1) {
          // Process is gone.
          core.warning("buildkitd was forcefully terminated with SIGKILL");
          return true;
        }
        // Some other error occurred.
        throw error;
      }
    }

    throw new Error(
      `failed to shutdown buildkitd: process still running after SIGTERM (${gracefulTimeout / 1000}s) and SIGKILL (${forceTimeout / 1000}s)`,
    );
  } catch (error) {
    core.error(
      `error shutting down buildkitd process: ${(error as Error).message}`,
    );
    throw error;
  }
}
