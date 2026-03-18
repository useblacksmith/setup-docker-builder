import * as fs from "fs";
import * as core from "@actions/core";
import * as actionsToolkit from "@docker/actions-toolkit";
import { Toolkit } from "@docker/actions-toolkit/lib/toolkit";
import { Docker } from "@docker/actions-toolkit/lib/docker/docker";
import { Exec } from "@docker/actions-toolkit/lib/exec";
import { GitHub } from "@docker/actions-toolkit/lib/github";
import { Context } from "@docker/actions-toolkit/lib/context";
import { Util } from "@docker/actions-toolkit/lib/util";
import { promisify } from "util";
import { exec } from "child_process";

import * as stateHelper from "./state-helper";
import * as reporter from "./reporter";
import {
  setupStickyDisk,
  startAndConfigureBuildkitd,
  getNumCPUs,
  pruneBuildkitCache,
  logDatabaseHashes,
  BUILDKIT_DAEMON_ADDR,
} from "./setup_builder";
import {
  installBuildKit,
  isBuildKitVersionInstalled,
} from "./buildkit-installer";
import { shutdownBuildkitd } from "./shutdown";
import { resolveRemoteBuilderPlatforms } from "./platform-utils";
import { checkPreviousStepFailures } from "./step-checker";
import { Metric_MetricType } from "@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb.js";

const DEFAULT_BUILDX_VERSION = "v0.23.0";
const mountPoint = "/var/lib/buildkit";
const execAsync = promisify(exec);

async function checkBoltDbIntegrity(skip = false): Promise<boolean> {
  if (skip) {
    core.info(
      "Skipping bbolt database integrity check (skip-integrity-check is enabled)",
    );
    return true;
  }

  try {
    // Check if /var/lib/buildkit directory exists
    try {
      await execAsync("test -d /var/lib/buildkit");
      core.debug(
        "Found /var/lib/buildkit directory, checking for database files",
      );

      // Find all *.db files in /var/lib/buildkit
      const { stdout: dbFiles } = await execAsync(
        "find /var/lib/buildkit -name '*.db' 2>/dev/null || true",
      );

      if (dbFiles.trim()) {
        const files = dbFiles.trim().split("\n");
        core.info(
          `Found ${files.length} database file(s): ${files.join(", ")}`,
        );

        let allChecksPass = true;
        for (const dbFile of files) {
          if (dbFile.trim()) {
            try {
              // Get file size
              let sizeInfo = "";
              try {
                const { stdout: sizeOutput } = await execAsync(
                  `stat -c%s "${dbFile}" 2>/dev/null || stat -f%z "${dbFile}"`,
                );
                const sizeBytes = parseInt(sizeOutput.trim(), 10);
                if (!isNaN(sizeBytes) && sizeBytes > 0) {
                  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                  sizeInfo = ` (${sizeMB} MB)`;
                }
              } catch (error) {
                core.debug(
                  `Could not determine file size for ${dbFile}: ${(error as Error).message}`,
                );
              }

              core.info(`Running bolt check on ${dbFile}${sizeInfo}...`);
              const startTime = Date.now();

              try {
                const { stdout: checkResult } = await execAsync(
                  `sudo systemd-run --scope --quiet -p MemoryMax=512M -p RuntimeMaxSec=6s bbolt check "${dbFile}" 2>&1`,
                );
                const duration = Date.now() - startTime;
                const durationSeconds = (duration / 1000).toFixed(2);

                if (duration > 5000) {
                  core.warning(
                    `⚠ ${dbFile}: Check took ${durationSeconds}s (exceeded 5s threshold)`,
                  );
                }

                if (checkResult.includes("OK")) {
                  core.info(`✓ ${dbFile}: Database integrity check passed`);
                } else {
                  core.warning(`⚠ ${dbFile}: ${checkResult}`);
                  allChecksPass = false;
                  // Report failed check
                  await reporter.reportIntegrityCheckFailure(dbFile);
                }
              } catch (checkError) {
                const duration = Date.now() - startTime;
                const durationSeconds = (duration / 1000).toFixed(2);
                const exitCode = (checkError as { code?: number }).code;
                const errorMessage = (checkError as Error).message;

                // Exit code 124 = timeout, 137 = SIGKILL (likely OOM), 143 = SIGTERM
                if (exitCode === 124) {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check timed out after ${durationSeconds}s - skipping (not counted as failure)`,
                  );
                } else if (
                  exitCode === 137 ||
                  errorMessage.toLowerCase().includes("out of memory") ||
                  errorMessage.toLowerCase().includes("cannot allocate memory")
                ) {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check hit memory limit - skipping (not counted as failure)`,
                  );
                } else {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check failed: ${errorMessage}`,
                  );
                  allChecksPass = false;
                  // Report actual failure
                  await reporter.reportIntegrityCheckFailure(dbFile);
                }
              }
            } catch (error) {
              core.warning(
                `Failed to check ${dbFile}: ${(error as Error).message}`,
              );
              allChecksPass = false;
            }
          }
        }
        return allChecksPass;
      } else {
        core.info("No *.db files found in /var/lib/buildkit");
        return true;
      }
    } catch (error) {
      core.info(
        `/var/lib/buildkit directory not found, skipping database checks ${(error as Error).message}`,
      );
      return true;
    }
  } catch (error) {
    core.warning(`BoltDB check failed: ${(error as Error).message}`);
    return false;
  }
}

// Minimal inputs interface for setup-docker-builder
export interface Inputs {
  "buildx-version": string;
  "buildkit-version": string;
  platforms: string[];
  nofallback: boolean;
  "github-token": string;
  "skip-integrity-check": boolean;
  "driver-opts": string[];
}

async function getInputs(): Promise<Inputs> {
  return {
    "buildx-version": core.getInput("buildx-version"),
    "buildkit-version": core.getInput("buildkit-version"),
    platforms: Util.getInputList("platforms"),
    nofallback: core.getBooleanInput("nofallback"),
    "github-token": core.getInput("github-token"),
    "skip-integrity-check": core.getBooleanInput("skip-integrity-check"),
    "driver-opts": Util.getInputList("driver-opts", {
      ignoreComma: true,
      quote: false,
    }),
  };
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries = 5,
  initialBackoffMs = 200,
): Promise<T> {
  let lastError: Error = new Error("No error occurred");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (
        (error as Error).message?.includes("429") ||
        (error as { status?: number }).status === 429
      ) {
        if (attempt < maxRetries - 1) {
          const backoffMs = initialBackoffMs * Math.pow(2, attempt);
          core.info(`Rate limited (429). Retrying in ${backoffMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError;
}

async function setupBuildx(version: string, toolkit: Toolkit): Promise<void> {
  let toolPath: string | undefined;
  const standalone = await toolkit.buildx.isStandalone();

  // Check if requested version is already installed (e.g., pre-installed in VM rootfs)
  if (version && (await toolkit.buildx.isAvailable())) {
    try {
      const { stdout } = await execAsync("buildx version");
      const match = stdout.match(/v\d+\.\d+\.\d+/);
      if (match && match[0] === version) {
        core.info(`Buildx ${version} already installed, skipping download`);
        await core.group(`Buildx version`, async () => {
          await toolkit.buildx.printVersion();
        });
        return;
      }
    } catch {
      // Version check failed, continue to download
    }
  }

  if (!(await toolkit.buildx.isAvailable()) || version) {
    await core.group(`Download buildx from GitHub Releases`, async () => {
      toolPath = await retryWithBackoff(() =>
        toolkit.buildxInstall.download(version || "latest", true),
      );
    });
  }

  if (toolPath) {
    await core.group(`Install buildx`, async () => {
      if (standalone) {
        await toolkit.buildxInstall.installStandalone(toolPath!);
      } else {
        await toolkit.buildxInstall.installPlugin(toolPath!);
      }
    });
  }

  await core.group(`Buildx version`, async () => {
    await toolkit.buildx.printVersion();
  });
}

function isValidBuildxVersion(version: string): boolean {
  return version === "latest" || /^v\d+\.\d+\.\d+$/.test(version);
}

/**
 * Starts and configures the Blacksmith builder
 * Returns the buildkit address and expose ID for the sticky disk
 */
async function startBlacksmithBuilder(
  inputs: Inputs,
): Promise<{ addr: string | null; exposeId: string }> {
  try {
    // Setup sticky disk
    const stickyDiskStartTime = Date.now();
    const stickyDiskSetup = await setupStickyDisk();
    const stickyDiskDurationMs = Date.now() - stickyDiskStartTime;
    await reporter.reportMetric(
      Metric_MetricType.BPA_HOTLOAD_DURATION_MS,
      stickyDiskDurationMs,
    );

    // Install BuildKit if version specified
    let buildkitdPath: string | undefined;
    if (inputs["buildkit-version"]) {
      const version = inputs["buildkit-version"];

      // Check if the requested version is already installed
      const isInstalled = await isBuildKitVersionInstalled(version);

      if (!isInstalled) {
        core.info(`Installing BuildKit ${version}...`);
        buildkitdPath = await installBuildKit(version);
      } else {
        core.info(`Using existing BuildKit ${version}`);
        // Use the installed version from /usr/local/bin
        buildkitdPath = "/usr/local/bin/buildkitd";
      }
    }

    // Get CPU count for parallelism
    const parallelism = await getNumCPUs();

    // Check if buildkitd is already running before starting
    try {
      const { stdout } = await execAsync("pgrep buildkitd");
      if (stdout.trim()) {
        throw new Error(
          `Detected existing buildkitd process (PID: ${stdout.trim()}). Refusing to start to avoid conflicts.`,
        );
      }
    } catch (error) {
      if ((error as { code?: number }).code !== 1) {
        // pgrep returns exit code 1 when no process found, which is what we want
        // Any other error code indicates a real problem
        throw new Error(
          `Failed to check for existing buildkitd process: ${(error as Error).message}`,
        );
      }
      // Exit code 1 means no buildkitd process found, which is good - we can proceed
    }

    // Check for potential boltdb corruption
    const boltdbIntegrity = await checkBoltDbIntegrity(
      inputs["skip-integrity-check"],
    );
    if (!boltdbIntegrity) {
      core.error("BoltDB integrity check failed");
    }

    // Start buildkitd
    const buildkitdStartTime = Date.now();
    const buildkitdAddr = await startAndConfigureBuildkitd(
      parallelism,
      buildkitdPath,
      inputs["driver-opts"],
    );
    const buildkitdDurationMs = Date.now() - buildkitdStartTime;
    await reporter.reportMetric(
      Metric_MetricType.BPA_BUILDKITD_READY_DURATION_MS,
      buildkitdDurationMs,
    );

    // Save state for post action
    stateHelper.setExposeId(stickyDiskSetup.exposeId);

    return { addr: buildkitdAddr, exposeId: stickyDiskSetup.exposeId };
  } catch (error) {
    if (inputs.nofallback) {
      core.warning(
        `Error during Blacksmith builder setup: ${(error as Error).message}. Failing because nofallback is set.`,
      );
      throw error;
    }

    core.warning(
      `Error during Blacksmith builder setup: ${(error as Error).message}. Falling back to local builder.`,
    );
    return { addr: null, exposeId: "" };
  }
}

void actionsToolkit.run(
  // main action
  async () => {
    await reporter.reportMetric(Metric_MetricType.BPA_FEATURE_USAGE, 1);

    const inputs = await getInputs();
    stateHelper.setInputs(inputs);

    const toolkit = new Toolkit();

    // Print runtime token ACs
    await core.group(`GitHub Actions runtime token ACs`, async () => {
      try {
        await GitHub.printActionsRuntimeTokenACs();
      } catch (e) {
        core.warning((e as Error).message);
      }
    });

    // Print Docker info
    await core.group(`Docker info`, async () => {
      try {
        await Docker.printVersion();
        await Docker.printInfo();
      } catch (e) {
        core.info((e as Error).message);
      }
    });

    // Validate and setup buildx version
    let buildxVersion = DEFAULT_BUILDX_VERSION;
    if (inputs["buildx-version"] && inputs["buildx-version"].trim() !== "") {
      if (isValidBuildxVersion(inputs["buildx-version"])) {
        buildxVersion = inputs["buildx-version"];
      } else {
        core.warning(
          `Invalid buildx-version '${inputs["buildx-version"]}'. ` +
            `Expected 'latest' or a version in the form v<MAJOR>.<MINOR>.<PATCH>. ` +
            `Falling back to default ${DEFAULT_BUILDX_VERSION}.`,
        );
      }
    }

    // Setup buildx
    await core.group(`Setup buildx`, async () => {
      await setupBuildx(buildxVersion, toolkit);

      if (!(await toolkit.buildx.isAvailable())) {
        core.setFailed(
          `Docker buildx is required. See https://github.com/docker/setup-buildx-action to set up buildx.`,
        );
        return;
      }
    });

    // Start Blacksmith builder
    let builderInfo: { addr: string | null; exposeId: string } = {
      addr: null,
      exposeId: "",
    };
    await core.group(`Starting Blacksmith builder`, async () => {
      builderInfo = await startBlacksmithBuilder(inputs);
    });

    if (builderInfo.addr) {
      // Create and configure the builder
      await core.group(`Creating builder instance`, async () => {
        const name = `blacksmith-${Date.now().toString(36)}`;
        stateHelper.setBuilderName(name);

        // Create the builder with platform configuration
        const createArgs = ["create", "--name", name, "--driver", "remote"];

        // Add platform flag - use user-supplied platforms or fallback to host arch
        const platformFlag = resolveRemoteBuilderPlatforms(inputs.platforms);
        core.info(`Determined remote builder platform(s): ${platformFlag}`);
        createArgs.push("--platform", platformFlag);

        createArgs.push(builderInfo.addr!);

        const createCmd = await toolkit.buildx.getCommand(createArgs);

        core.info(
          `Creating builder with command: ${createCmd.command} ${createCmd.args.join(" ")}`,
        );
        await Exec.getExecOutput(createCmd.command, createCmd.args, {
          ignoreReturnCode: true,
        }).then((res) => {
          if (res.stderr.length > 0 && res.exitCode != 0) {
            throw new Error(
              /(.*)\s*$/.exec(res.stderr)?.[0]?.trim() ?? "unknown error",
            );
          }
        });

        // Set as default builder
        const useCmd = await toolkit.buildx.getCommand(["use", name]);
        core.info("Setting builder as default");
        await Exec.getExecOutput(useCmd.command, useCmd.args, {
          ignoreReturnCode: true,
        }).then((res) => {
          if (res.stderr.length > 0 && res.exitCode != 0) {
            throw new Error(
              /(.*)\s*$/.exec(res.stderr)?.[0]?.trim() ?? "unknown error",
            );
          }
        });
      });

      // Print builder info
      await core.group(`Builder info`, async () => {
        const builder = await toolkit.builder.inspect();
        core.info(JSON.stringify(builder, null, 2));
        core.info("Blacksmith builder is ready for use by Docker");
      });
    } else {
      // Fallback to local builder
      core.warning("Failed to setup Blacksmith builder, using local builder");
      await core.group(`Checking for configured builder`, async () => {
        try {
          const builder = await toolkit.builder.inspect();
          if (builder) {
            core.info(`Found configured builder: ${builder.name}`);
          } else {
            // Create a local builder
            const createLocalBuilderCmd =
              "docker buildx create --name local --driver docker-container --use";
            try {
              await Exec.exec(createLocalBuilderCmd);
              core.info("Created and set a local builder for use");
            } catch (error) {
              core.setFailed(
                `Failed to create local builder: ${(error as Error).message}`,
              );
            }
          }
        } catch (error) {
          core.setFailed(
            `Error configuring builder: ${(error as Error).message}`,
          );
        }
      });
    }

    stateHelper.setTmpDir(Context.tmpDir());
  },
  // post action - cleanup
  async () => {
    await core.group("Cleaning up Docker builder", async () => {
      const exposeId = stateHelper.getExposeId();
      let cleanupError: Error | null = null;
      let fsDiskUsageBytes: number | null = null;
      let integrityCheckPassed: boolean | null = null;

      try {
        // Step 1: Check if buildkitd is running and shut it down
        try {
          core.info(`buildkitd addr: ${stateHelper.getBuildkitdAddr()}`);
          const { stdout } = await execAsync("pgrep buildkitd");
          core.info(`buildkitd process: ${stdout.trim()}`);
          if (stdout.trim()) {
            core.info("buildkitd process is running");

            // Optional: Prune cache before shutdown (non-critical)
            try {
              // Capture cache state BEFORE prune for diagnostics
              try {
                core.info("=== BuildKit cache BEFORE prune ===");
                const { stdout: duBeforeVerbose } = await execAsync(
                  `sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} du --verbose 2>&1 | tail -200`,
                );
                core.info(duBeforeVerbose);
                const { stdout: duBeforeSummary } = await execAsync(
                  `sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} du 2>&1 | tail -5`,
                );
                core.info(`Cache summary before prune: ${duBeforeSummary}`);
              } catch (e) {
                core.warning(
                  `Could not get pre-prune du: ${(e as Error).message}`,
                );
              }

              core.info("Pruning BuildKit cache");
              await pruneBuildkitCache();
              core.info("BuildKit cache pruned");

              // Capture cache state AFTER prune for diagnostics
              try {
                core.info("=== BuildKit cache AFTER prune ===");
                const { stdout: duAfterVerbose } = await execAsync(
                  `sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} du --verbose 2>&1 | tail -200`,
                );
                core.info(duAfterVerbose);
                const { stdout: duAfterSummary } = await execAsync(
                  `sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} du 2>&1 | tail -5`,
                );
                core.info(`Cache summary after prune: ${duAfterSummary}`);
              } catch (e) {
                core.warning(
                  `Could not get post-prune du: ${(e as Error).message}`,
                );
              }
            } catch (error) {
              core.warning(
                `Error pruning BuildKit cache: ${(error as Error).message}`,
              );
              // Don't fail cleanup for cache prune errors
            }

            // Critical: Shutdown buildkitd
            const buildkitdShutdownStartTime = Date.now();
            await shutdownBuildkitd();
            const buildkitdShutdownDurationMs =
              Date.now() - buildkitdShutdownStartTime;
            await reporter.reportMetric(
              Metric_MetricType.BPA_BUILDKITD_SHUTDOWN_DURATION_MS,
              buildkitdShutdownDurationMs,
            );
            core.info("Shutdown buildkitd gracefully");
          } else {
            // Check if buildkitd was expected to be running (we have state indicating it was started)
            const buildkitdAddr = stateHelper.getBuildkitdAddr();
            if (buildkitdAddr) {
              core.warning(
                "buildkitd process has crashed - process not found but was expected to be running",
              );

              // Print tail of buildkitd logs to help debug the crash
              try {
                const { stdout: logOutput } = await execAsync(
                  "tail -n 100 /tmp/buildkitd.log 2>/dev/null || echo 'No buildkitd.log found'",
                );
                core.info("Last 100 lines of buildkitd.log:");
                core.info(logOutput);
              } catch (error) {
                core.warning(
                  `Could not read buildkitd logs: ${(error as Error).message}`,
                );
              }
            } else {
              core.debug(
                "No buildkitd process found running and none was expected",
              );
            }
          }
        } catch (error) {
          // pgrep returns exit code 1 when no process found, which is OK
          if ((error as { code?: number }).code !== 1) {
            throw new Error(
              `failed to check/shutdown buildkitd: ${(error as Error).message}`,
            );
          }

          // Check if buildkitd was expected to be running (we have state indicating it was started)
          const buildkitdAddr = stateHelper.getBuildkitdAddr();
          if (buildkitdAddr) {
            core.warning(
              "buildkitd process has crashed - pgrep failed but buildkitd was expected to be running",
            );

            // Print tail of blacksmithd logs to help debug the crash
            try {
              const { stdout: logOutput } = await execAsync(
                "tail -n 100 /tmp/buildkitd.log 2>/dev/null || echo 'No buildkitd.log found'",
              );
              core.info("Last 100 lines of buildkitd.log:");
              core.info(logOutput);
            } catch (error) {
              core.warning(
                `Could not read buildkitd logs: ${(error as Error).message}`,
              );
            }
          } else {
            core.debug(
              "No buildkitd process found (pgrep returned 1) and none was expected",
            );
          }
        }

        // Step 2: Sync and unmount sticky disk
        await execAsync("sync");

        try {
          const { stdout: mountOutput } = await execAsync(
            `mount | grep "${mountPoint}"`,
          );
          integrityCheckPassed = await checkBoltDbIntegrity(
            stateHelper.inputs?.["skip-integrity-check"] ?? false,
          );

          // Log database file hashes after integrity check
          await logDatabaseHashes("after integrity check");

          // Get filesystem usage BEFORE unmounting (critical timing)
          try {
            const { stdout } = await execAsync(
              "df -B1 --output=used,size /var/lib/buildkit | tail -n1",
            );
            const values = stdout.trim().split(/\s+/);
            const usedBytes = parseInt(values[0], 10);
            const sizeBytes = parseInt(values[1], 10);

            if (
              isNaN(usedBytes) ||
              usedBytes <= 0 ||
              isNaN(sizeBytes) ||
              sizeBytes <= 0
            ) {
              core.warning(
                `Invalid filesystem values from df: "${stdout.trim()}". Will not report fs usage.`,
              );
            } else {
              fsDiskUsageBytes = usedBytes;
              const usedGiB = (usedBytes / (1 << 30)).toFixed(2);
              const sizeGiB = (sizeBytes / (1 << 30)).toFixed(2);
              const usagePercent = ((usedBytes / sizeBytes) * 100).toFixed(1);
              core.info(
                `Filesystem usage: ${usedBytes} bytes (${usedGiB} GiB) / ${sizeBytes} bytes (${sizeGiB} GiB) [${usagePercent}%]`,
              );
            }
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            core.warning(
              `Failed to get filesystem usage: ${errorMsg}. Will not report fs usage.`,
            );
          }

          if (mountOutput) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await execAsync(`sudo umount "${mountPoint}"`);
                core.info(`Successfully unmounted ${mountPoint}`);
                break;
              } catch (error) {
                if (attempt === 3) {
                  throw new Error(
                    `Failed to unmount ${mountPoint} after 3 attempts: ${(error as Error).message}`,
                  );
                }
                core.warning(`Unmount failed, retrying (${attempt}/3)...`);
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          } else {
            core.debug("No sticky disk mount found");
          }
        } catch (error) {
          // grep returns exit code 1 when no matches, which is OK
          if ((error as { code?: number }).code !== 1) {
            throw new Error(
              `Failed to unmount sticky disk: ${(error as Error).message}`,
            );
          }
          core.debug("No sticky disk mount found (grep returned 1)");
        }

        // Step 3: Clean up temp directory (non-critical)
        if (stateHelper.tmpDir.length > 0) {
          try {
            fs.rmSync(stateHelper.tmpDir, { recursive: true });
            core.debug(`Removed temp folder ${stateHelper.tmpDir}`);
          } catch (error) {
            core.warning(
              `Failed to remove temp directory: ${(error as Error).message}`,
            );
            // Don't fail cleanup for temp directory removal
          }
        }

        // If we made it here, all critical cleanup steps succeeded
        core.info("All critical cleanup steps completed successfully");
      } catch (error) {
        cleanupError = error as Error;
        core.error(`Cleanup failed: ${cleanupError.message}`);
        await reporter.reportBuildPushActionFailure(
          "BUILDER_CLEANUP",
          cleanupError,
          "docker builder cleanup",
        );
      }

      // Step 4: Check for previous step failures before committing
      if (exposeId) {
        if (!cleanupError) {
          // Check if any previous steps failed or were cancelled
          core.info(
            "Checking for previous step failures before committing sticky disk",
          );
          const failureCheck = await checkPreviousStepFailures();

          if (failureCheck.error) {
            core.warning(
              `Unable to check for previous step failures: ${failureCheck.error}`,
            );
            core.warning(
              "Skipping sticky disk commit due to ambiguity in failure detection",
            );
          } else if (integrityCheckPassed === null) {
            core.warning(
              "Skipping sticky disk commit due to integrity check not being run",
            );
          } else if (!integrityCheckPassed) {
            core.warning(
              "Skipping sticky disk commit due to integrity check failure",
            );
          } else if (failureCheck.hasFailures) {
            core.warning(
              `Found ${failureCheck.failedCount} failed/cancelled steps in previous workflow steps`,
            );
            if (failureCheck.failedSteps) {
              failureCheck.failedSteps.forEach((step) => {
                core.warning(
                  `  - Step: ${step.stepName || step.action || "unknown"} (${step.result})`,
                );
              });
            }
            core.warning(
              "Skipping sticky disk commit due to previous step failures",
            );
          } else if (stateHelper.getSigkillUsed()) {
            core.warning(
              "Skipping sticky disk commit because SIGKILL was used to terminate buildkitd - disk may be in a bad state",
            );
          } else {
            // No failures detected and cleanup was successful
            try {
              core.info(
                "No previous step failures detected, committing sticky disk after successful cleanup",
              );

              await reporter.commitStickyDisk(exposeId, fsDiskUsageBytes);
            } catch (error) {
              core.error(
                `Failed to commit sticky disk: ${(error as Error).message}`,
              );
              await reporter.reportBuildPushActionFailure(
                "STICKYDISK_COMMIT",
                error as Error,
                "sticky disk commit",
              );
            }
          }
        } else {
          core.warning(
            `Skipping sticky disk commit due to cleanup error: ${cleanupError.message}`,
          );
        }
      } else {
        core.warning(
          "Expose ID not found in state, skipping sticky disk commit",
        );
      }
    });
  },
);
