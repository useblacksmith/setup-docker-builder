import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

export async function shutdownBuildkitd(): Promise<void> {
  const startTime = Date.now();
  const timeout = 10000; // 10 seconds
  const backoff = 300; // 300ms

  try {
    await execAsync(`sudo pkill -TERM buildkitd`);

    // Wait for buildkitd to shutdown with backoff retry
    while (Date.now() - startTime < timeout) {
      try {
        const { stdout } = await execAsync("pgrep buildkitd");
        core.debug(
          `buildkitd process still running with PID: ${stdout.trim()}`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } catch (error) {
        if ((error as { code?: number }).code === 1) {
          // pgrep returns exit code 1 when no process is found, which means shutdown successful
          core.debug("buildkitd successfully shutdown");
          return;
        }
        // Some other error occurred
        throw error;
      }
    }

    throw new Error(
      "Timed out waiting for buildkitd to shutdown after 10 seconds",
    );
  } catch (error) {
    core.error(
      `error shutting down buildkitd process: ${(error as Error).message}`,
    );
    throw error;
  }
}
