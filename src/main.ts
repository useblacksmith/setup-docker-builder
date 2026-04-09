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
  execWithTimeout,
  ExecTimeoutError,
  BOLT_CHECK_MEMORY_MAX_BYTES,
  BOLT_CHECK_MAX_FILE_BYTES,
} from "./exec-utils";
import {
  setupStickyDisk,
  startAndConfigureBuildkitd,
  getNumCPUs,
  pruneBuildkitCache,
  logBuildCacheContents,
  logDatabaseHashes,
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

async function getDeviceFromMount(mountPath: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`findmnt -n -o SOURCE "${mountPath}"`);
    const device = stdout.trim();
    if (device) {
      // Log full mount info for debugging
      try {
        const { stdout: mountInfo } = await execAsync(
          `findmnt -n -o SOURCE,FSTYPE,OPTIONS "${mountPath}"`,
        );
        core.info(`Mount info for ${mountPath}: ${mountInfo.trim()}`);
      } catch {
        // Ignore if we can't get full mount info
      }
      return device;
    }
  } catch {
    core.info(`findmnt failed for ${mountPath}, trying mount command`);
  }

  try {
    const { stdout } = await execAsync(`mount | grep " ${mountPath} "`);
    const match = stdout.match(/^(\/dev\/\S+)/);
    if (match) {
      core.info(`Mount info for ${mountPath}: ${stdout.trim()}`);
      return match[1];
    }
  } catch {
    core.info(`mount grep failed for ${mountPath}`);
  }

  return null;
}

const FLUSH_TIMEOUT_SECS = 10;
const TIMEOUT_EXIT_CODE = 124;

async function flushBlockDevice(devicePath: string): Promise<void> {
  const deviceName = devicePath.replace("/dev/", "");
  if (!deviceName) {
    core.warning(`Could not extract device name from ${devicePath}`);
    return;
  }

  const statPath = `/sys/block/${deviceName}/stat`;

  let beforeStats = "";
  try {
    const { stdout } = await execAsync(`cat ${statPath}`);
    beforeStats = stdout.trim();
  } catch {
    core.warning(`Could not read block device stats before flush: ${statPath}`);
  }

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execAsync(
      `timeout ${FLUSH_TIMEOUT_SECS} sudo blockdev --flushbufs ${devicePath}; echo "EXIT_CODE:$?"`,
    );
    const duration = Date.now() - startTime;

    // Parse exit code from output
    const exitCodeMatch = stdout.match(/EXIT_CODE:(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

    if (exitCode === TIMEOUT_EXIT_CODE) {
      core.warning(
        `guest flush timed out for ${devicePath} after ${FLUSH_TIMEOUT_SECS}s`,
      );
      return;
    }

    if (exitCode !== 0) {
      core.warning(
        `guest flush failed for ${devicePath} after ${duration}ms: exit code ${exitCode}, stderr: ${stderr}`,
      );
      return;
    }

    // Log stderr as warning even on success, in case there's useful diagnostic info
    if (stderr && stderr.trim()) {
      core.warning(`guest flush stderr (exit 0): ${stderr.trim()}`);
    }

    let afterStats = "";
    try {
      const { stdout } = await execAsync(`cat ${statPath}`);
      afterStats = stdout.trim();
    } catch {
      core.warning(
        `Could not read block device stats after flush: ${statPath}`,
      );
    }

    core.info(
      `guest flush duration: ${duration}ms, device: ${devicePath}, before_stats: ${beforeStats}, after_stats: ${afterStats}`,
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    core.warning(
      `guest flush failed for ${devicePath} after ${duration}ms: ${errorMsg}`,
    );
  }
}

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
      await execWithTimeout(
        "test -d /var/lib/buildkit",
        15_000,
        "test buildkit dir exists",
      );
      core.debug(
        "Found /var/lib/buildkit directory, checking for database files",
      );

      // Find all *.db files in /var/lib/buildkit
      const { stdout: dbFiles } = await execWithTimeout(
        "find /var/lib/buildkit -name '*.db' 2>/dev/null || true",
        30_000,
        "find db files",
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
              let sizeBytes = 0;
              try {
                const { stdout: sizeOutput } = await execWithTimeout(
                  `stat -c%s "${dbFile}" 2>/dev/null || stat -f%z "${dbFile}"`,
                  15_000,
                  `stat db file ${dbFile}`,
                );
                sizeBytes = parseInt(sizeOutput.trim(), 10);
                if (!isNaN(sizeBytes) && sizeBytes > 0) {
                  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                  sizeInfo = ` (${sizeMB} MB)`;
                }
              } catch (error) {
                core.debug(
                  `Could not determine file size for ${dbFile}: ${(error as Error).message}`,
                );
              }

              // Skip integrity check for files that are too large for the memory-limited
              // systemd scope. bbolt check mmaps the entire file, and with ~50-60 MB of
              // Go runtime overhead the process will be OOM-killed for large files.
              if (sizeBytes > BOLT_CHECK_MAX_FILE_BYTES) {
                const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
                core.info(
                  `${dbFile}: Skipping integrity check - file size ${sizeMB} MB exceeds limit (${BOLT_CHECK_MAX_FILE_BYTES / (1024 * 1024)} MB)`,
                );
                continue;
              }

              core.info(`Running bolt check on ${dbFile}${sizeInfo}...`);
              const startTime = Date.now();

              try {
                const memoryMaxMB = BOLT_CHECK_MEMORY_MAX_BYTES / (1024 * 1024);
                const { stdout: checkResult } = await execWithTimeout(
                  `sudo systemd-run --scope --quiet -p MemoryMax=${memoryMaxMB}M -p RuntimeMaxSec=6s bbolt check "${dbFile}" 2>&1`,
                  30_000,
                  `bbolt check ${dbFile}`,
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

                // ExecTimeoutError = Promise.race timeout (process stuck in D state, e.g. Ceph partition)
                if (checkError instanceof ExecTimeoutError) {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check hit hard timeout after ${durationSeconds}s (possible I/O stall) - skipping`,
                  );
                  // Exit code 124 = timeout, 137 = SIGKILL (likely OOM), 143 = SIGTERM
                } else if (exitCode === 124) {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check timed out after ${durationSeconds}s - skipping`,
                  );
                } else if (
                  exitCode === 137 ||
                  errorMessage.toLowerCase().includes("out of memory") ||
                  errorMessage.toLowerCase().includes("cannot allocate memory")
                ) {
                  core.warning(
                    `⚠ ${dbFile}: Integrity check hit memory limit - skipping`,
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
      if (error instanceof ExecTimeoutError) {
        core.warning(
          `Integrity check hit hard timeout during filesystem access (possible I/O stall) - skipping`,
        );
        return true;
      }
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
  "max-parallelism": number | null;
  "cache-max-age": string | null;
  "cache-keep-storage": number | null;
}

async function getInputs(): Promise<Inputs> {
  const maxParallelismInput = core.getInput("max-parallelism");
  let maxParallelism: number | null = null;
  if (maxParallelismInput) {
    const parsed = parseInt(maxParallelismInput, 10);
    if (!isNaN(parsed) && parsed > 0) {
      maxParallelism = parsed;
    } else {
      core.warning(
        `Invalid max-parallelism value '${maxParallelismInput}', ignoring. Must be a positive integer.`,
      );
    }
  }

  const cacheKeepStorageInput = core.getInput("cache-keep-storage");
  let cacheKeepStorage: number | null = null;
  if (cacheKeepStorageInput) {
    const parsed = parseInt(cacheKeepStorageInput, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      cacheKeepStorage = parsed;
    } else {
      core.warning(
        `Invalid cache-keep-storage value '${cacheKeepStorageInput}', ignoring. Must be a non-negative integer (MB).`,
      );
    }
  }

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
    "max-parallelism": maxParallelism,
    "cache-max-age": core.getInput("cache-max-age") || null,
    "cache-keep-storage": cacheKeepStorage,
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
    // If buildkitd is already running, skip - the builder is already initialized.
    try {
      const { stdout } = await execAsync("pgrep buildkitd");
      if (stdout.trim()) {
        core.info(
          `Detected existing buildkitd process (PID: ${stdout.trim()}). ` +
            `Skipping builder setup - builder is already initialized.`,
        );
        return { addr: null, exposeId: "" };
      }
    } catch (error) {
      if ((error as { code?: number }).code !== 1) {
        throw new Error(
          `Failed to check for existing buildkitd process: ${(error as Error).message}`,
        );
      }
    }

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

    // Get CPU count for parallelism, allow user override via max-parallelism input
    let parallelism = await getNumCPUs();
    if (inputs["max-parallelism"] !== null) {
      core.info(
        `Overriding max-parallelism from ${parallelism} (nproc) to ${inputs["max-parallelism"]} (user-specified)`,
      );
      parallelism = inputs["max-parallelism"];
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

/**
 * Shuts down buildkitd only if this action instance started it.
 * When setup is called multiple times in one job, only the first
 * instance starts buildkitd; subsequent instances reuse it and
 * should not shut it down.
 */
async function maybeShutdownBuildkitd(): Promise<void> {
  const buildkitdAddr = stateHelper.getBuildkitdAddr();
  if (!buildkitdAddr) {
    core.info("This instance did not start buildkitd, skipping shutdown");
    return;
  }

  core.info(`buildkitd addr: ${buildkitdAddr}`);

  let pid: string | null = null;
  try {
    const { stdout } = await execAsync("pgrep buildkitd");
    pid = stdout.trim() || null;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) {
      throw new Error(
        `failed to check buildkitd status: ${(error as Error).message}`,
      );
    }
  }

  if (!pid) {
    core.warning(
      "buildkitd process has crashed - expected to be running but not found",
    );
    await logBuildkitdCrashLogs();
    return;
  }

  core.info(`buildkitd process: ${pid}`);

  await logBuildCacheContents();

  try {
    const cacheMaxAge = "1s";
    const keepStorageMB = 1000;
    const parts: string[] = [];
    if (cacheMaxAge) parts.push(`max age ${cacheMaxAge}`);
    if (keepStorageMB != null) parts.push(`keep at least ${keepStorageMB} MB`);
    const desc = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    core.info(`Pruning BuildKit cache${desc}`);
    await pruneBuildkitCache(cacheMaxAge, keepStorageMB);
    core.info("BuildKit cache pruned");
  } catch (error) {
    core.warning(`Error pruning BuildKit cache: ${(error as Error).message}`);
  }

  const buildkitdShutdownStartTime = Date.now();
  await shutdownBuildkitd();
  const buildkitdShutdownDurationMs = Date.now() - buildkitdShutdownStartTime;
  await reporter.reportMetric(
    Metric_MetricType.BPA_BUILDKITD_SHUTDOWN_DURATION_MS,
    buildkitdShutdownDurationMs,
  );

  if (stateHelper.getSigkillUsed()) {
    core.warning(
      "buildkitd was terminated with SIGKILL after graceful shutdown failed",
    );
  } else {
    core.info("Shutdown buildkitd gracefully");
  }
}

async function logBuildkitdCrashLogs(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      "tail -n 100 /tmp/buildkitd.log 2>/dev/null || echo 'No buildkitd.log found'",
    );
    core.info("Last 100 lines of buildkitd.log:");
    core.info(stdout);
  } catch (error) {
    core.warning(`Could not read buildkitd logs: ${(error as Error).message}`);
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
      core.warning(
        "Blacksmith builder setup skipped or failed, checking for existing configured builder",
      );
      await core.group(`Checking for configured builder`, async () => {
        try {
          const builder = await toolkit.builder.inspect();
          if (builder && builder.driver !== "docker") {
            core.info(
              `Found configured builder: ${builder.name} (driver: ${builder.driver})`,
            );
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
        // Step 1: Shut down buildkitd if this instance started it.
        // When setup is called multiple times in one job, only the first
        // instance starts buildkitd; subsequent instances reuse it and
        // should not shut it down.
        await maybeShutdownBuildkitd();

        // Step 2: Sync and unmount sticky disk
        await execAsync("sync");

        // Get device path before unmount for durability flush
        let devicePath: string | null = null;
        try {
          devicePath = await getDeviceFromMount(mountPoint);
          if (devicePath) {
            core.info(
              `Found device ${devicePath} for mount point ${mountPoint}`,
            );
          }
        } catch {
          core.info(`Could not determine device for ${mountPoint}`);
        }

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

            // Flush block device buffers after unmount to ensure data durability
            // before the Ceph RBD snapshot is taken. The device is still mapped even though unmounted.
            if (devicePath) {
              await flushBlockDevice(devicePath);
            } else {
              core.info(
                "Skipping durability flush: device path not found for mount point",
              );
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
