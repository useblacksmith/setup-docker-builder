import * as fs from "fs";
import * as core from "@actions/core";
import { exec } from "child_process";
import { promisify } from "util";
import * as TOML from "@iarna/toml";
import * as reporter from "./reporter";
import { execa } from "execa";
import * as stateHelper from "./state-helper";

// Constants for configuration.
const BUILDKIT_DAEMON_ADDR = "tcp://127.0.0.1:1234";
const mountPoint = "/var/lib/buildkit";
const execAsync = promisify(exec);

// Tailscale functions removed - not needed for setup-docker-builder
// Multi-platform builds are handled differently in the new architecture

async function maybeFormatBlockDevice(device: string): Promise<string> {
  try {
    // Check if device is formatted with ext4
    try {
      const { stdout } = await execAsync(
        `sudo blkid -o value -s TYPE ${device}`,
      );
      if (stdout.trim() === "ext4") {
        core.debug(`Device ${device} is already formatted with ext4`);
        try {
          // Run resize2fs to ensure filesystem uses full block device
          await execAsync(`sudo resize2fs -f ${device}`);
          core.debug(`Resized ext4 filesystem on ${device}`);
        } catch {
          core.warning(`Error resizing ext4 filesystem on ${device}`);
        }
        return device;
      }
    } catch {
      // blkid returns non-zero if no filesystem found, which is fine
      core.debug(`No filesystem found on ${device}, will format it`);
    }

    // Format device with ext4
    core.debug(`Formatting device ${device} with ext4`);
    await execAsync(
      `sudo mkfs.ext4 -m0 -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`,
    );
    core.debug(`Successfully formatted ${device} with ext4`);
    return device;
  } catch (error) {
    core.error(
      `Failed to format device ${device}: ${(error as Error).message}`,
    );
    throw error;
  }
}

export async function getNumCPUs(): Promise<number> {
  try {
    const { stdout } = await execAsync("sudo nproc");
    return parseInt(stdout.trim());
  } catch (error) {
    core.warning(
      `Failed to get CPU count, defaulting to 1: ${(error as Error).message}`,
    );
    return 1;
  }
}

async function writeBuildkitdTomlFile(
  parallelism: number,
  addr: string,
): Promise<void> {
  const jsonConfig: TOML.JsonMap = {
    root: "/var/lib/buildkit",
    grpc: {
      address: [addr],
    },
    // Configure explicit DNS nameservers to avoid issues with systemd-resolved stub resolver.
    // See: https://github.com/moby/buildkit/issues/5009
    dns: {
      nameservers: ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112"],
    },
    registry: {
      "docker.io": {
        mirrors: ["http://192.168.127.1:5000"],
        http: true,
        insecure: true,
      },
      "192.168.127.1:5000": {
        http: true,
        insecure: true,
      },
    },
    worker: {
      oci: {
        enabled: true,
        // Disable automatic garbage collection, since we will prune manually. Automatic GC
        // has been seen to negatively affect startup times of the daemon.
        gc: false,
        "max-parallelism": parallelism,
        snapshotter: "overlayfs",
      },
      containerd: {
        enabled: false,
      },
    },
  };

  const tomlString = TOML.stringify(jsonConfig);

  try {
    await fs.promises.writeFile("buildkitd.toml", tomlString);
    core.debug(`TOML configuration is ${tomlString}`);
  } catch (err) {
    core.warning(`error writing TOML configuration: ${(err as Error).message}`);
    throw err;
  }
}

export async function startBuildkitd(
  parallelism: number,
  addr: string,
  buildkitdPath?: string,
  driverOpts?: string[],
): Promise<string> {
  try {
    await writeBuildkitdTomlFile(parallelism, addr);

    // Parse driver-opts to extract environment variables
    const envVars: Record<string, string> = {};
    if (driverOpts && driverOpts.length > 0) {
      core.info(`Processing ${driverOpts.length} driver-opt(s)`);
      for (const opt of driverOpts) {
        // Handle environment variable options (env.VARIABLE=value)
        if (opt.startsWith("env.")) {
          // Format: env.VARIABLE=value
          const envPart = opt.substring(4); // Remove "env." prefix
          const equalIndex = envPart.indexOf("=");
          if (equalIndex > 0) {
            const key = envPart.substring(0, equalIndex);
            const value = envPart.substring(equalIndex + 1);
            envVars[key] = value;
            core.info(`Setting buildkitd environment variable: ${key}`);
            core.debug(`  ${key}=${value}`);
          } else {
            core.warning(`Invalid driver-opt format (missing value): ${opt}`);
          }
        } else {
          // Log unsupported options but continue
          core.warning(
            `Unsupported driver-opt (only env.* options are currently supported): ${opt}`,
          );
        }
      }

      if (Object.keys(envVars).length > 0) {
        core.info(
          `Configured ${Object.keys(envVars).length} environment variable(s) for buildkitd`,
        );
      }
    }

    // Creates a log stream to write buildkitd output to a file.
    const logStream = fs.createWriteStream("/tmp/buildkitd.log", {
      flags: "a",
    });
    // Start buildkitd in background (detached) mode since we're only setting up
    // Use custom buildkitd path if provided, otherwise use system buildkitd
    const buildkitdBinary = buildkitdPath || "buildkitd";

    // Build the command with environment variables passed through sudo
    let buildkitdCommand = "nohup sudo";
    // Add environment variables after sudo using env command
    if (Object.keys(envVars).length > 0) {
      buildkitdCommand += " env";
      for (const [key, value] of Object.entries(envVars)) {
        // Use env command to set environment variables after sudo
        buildkitdCommand += ` ${key}='${value}'`;
      }
    }
    buildkitdCommand += ` ${buildkitdBinary} --debug --config=buildkitd.toml --allow-insecure-entitlement security.insecure --allow-insecure-entitlement network.host > /tmp/buildkitd.log 2>&1 &`;

    core.info(`Starting buildkitd with command: ${buildkitdCommand}`);
    const buildkitd = execa(buildkitdCommand, {
      shell: "/bin/bash",
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      cleanup: false,
    });

    // Pipe stdout and stderr to log file
    if (buildkitd.stdout) {
      buildkitd.stdout.pipe(logStream);
    }
    if (buildkitd.stderr) {
      buildkitd.stderr.pipe(logStream);
    }

    buildkitd.on("error", (error) => {
      throw new Error(`Failed to start buildkitd: ${error.message}`);
    });

    // Wait for buildkitd PID to appear with backoff retry
    const startTime = Date.now();
    const timeout = 10000; // 10 seconds
    const backoff = 300; // 300ms

    while (Date.now() - startTime < timeout) {
      try {
        const { stdout } = await execAsync("pgrep buildkitd");
        if (stdout.trim()) {
          core.info(
            `buildkitd daemon started successfully with PID ${stdout.trim()}`,
          );

          try {
            const buildkitdBinary = buildkitdPath || "buildkitd";
            const { stdout: versionOutput } = await execAsync(
              `${buildkitdBinary} --version`,
            );
            const versionMatch = versionOutput.match(/buildkit\s+v?(\S+)/i);
            if (versionMatch) {
              core.info(`buildkitd version: ${versionMatch[1]}`);
            } else {
              core.info(`buildkitd version: ${versionOutput.trim()}`);
            }
          } catch (error) {
            core.debug(
              `Could not determine buildkitd version: ${(error as Error).message}`,
            );
          }

          return addr;
        }
      } catch {
        // pgrep returns non-zero if process not found, which is expected while waiting
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw new Error(
      "Timed out waiting for buildkitd to start after 10 seconds",
    );
  } catch (error) {
    core.error(`failed to start buildkitd daemon: ${(error as Error).message}`);
    await reporter.reportBuildPushActionFailure(
      "BUILDER_STARTUP",
      error as Error,
      "buildkitd startup",
    );
    throw error;
  }
}

export async function getStickyDisk(options?: {
  signal?: AbortSignal;
}): Promise<{
  expose_id: string;
  device: string;
  parent_snapshot_name: string;
  clone_name: string;
}> {
  const client = await reporter.createBlacksmithAgentClient();
  core.info(`Created Blacksmith agent client`);

  // Test connection using up endpoint
  try {
    await client.up({}, { signal: options?.signal });
    core.info("Successfully connected to Blacksmith agent");
  } catch (error) {
    throw new Error(`grpc connection test failed: ${(error as Error).message}`);
  }

  const stickyDiskKey = process.env.GITHUB_REPO_NAME || "";
  if (stickyDiskKey === "") {
    throw new Error("GITHUB_REPO_NAME is not set");
  }
  core.info(`Getting sticky disk for ${stickyDiskKey}`);

  const response = await client.getStickyDisk(
    {
      stickyDiskKey: stickyDiskKey,
      region: process.env.BLACKSMITH_REGION || "eu-central",
      installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || "",
      vmId: process.env.BLACKSMITH_VM_ID || "",
      stickyDiskType: "dockerfile",
      repoName: process.env.GITHUB_REPO_NAME || "",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
    },
    {
      signal: options?.signal,
    },
  );
  return {
    expose_id: (response as { exposeId?: string }).exposeId || "",
    device: (response as { diskIdentifier?: string }).diskIdentifier || "",
    parent_snapshot_name:
      (response as { parentSnapshotName?: string }).parentSnapshotName || "",
    clone_name: (response as { cloneName?: string }).cloneName || "",
  };
}

// buildkitdTimeoutMs states the max amount of time this action will wait for the buildkitd
// daemon to start have its socket ready. It also additionally governs how long we will wait for
// the buildkitd workers to be ready.
const buildkitdTimeoutMs = 30000;

export async function startAndConfigureBuildkitd(
  parallelism: number,
  buildkitdPath?: string,
  driverOpts?: string[],
): Promise<string> {
  // Use standard buildkitd address
  const buildkitdAddr = BUILDKIT_DAEMON_ADDR;

  const addr = await startBuildkitd(
    parallelism,
    buildkitdAddr,
    buildkitdPath,
    driverOpts,
  );
  core.debug(`buildkitd daemon started at addr ${addr}`);
  stateHelper.setBuildkitdAddr(addr);

  // Check that buildkit instance is ready by querying workers for up to 30s
  const startTimeBuildkitReady = Date.now();
  const timeoutBuildkitReady = buildkitdTimeoutMs;

  while (Date.now() - startTimeBuildkitReady < timeoutBuildkitReady) {
    try {
      const { stdout } = await execAsync(
        `sudo buildctl --addr ${addr} debug workers`,
      );
      const lines = stdout.trim().split("\n");
      // We only need 1 worker for setup-docker-builder
      const requiredWorkers = 1;
      if (lines.length > requiredWorkers) {
        core.info(
          `Found ${lines.length - 1} workers, required ${requiredWorkers}`,
        );
        break;
      }
    } catch (error) {
      core.debug(
        `Error checking buildkit workers: ${(error as Error).message}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Final check after timeout.
  try {
    const { stdout } = await execAsync(
      `sudo buildctl --addr ${addr} debug workers`,
    );
    const lines = stdout.trim().split("\n");
    const requiredWorkers = 1;
    if (lines.length <= requiredWorkers) {
      throw new Error(
        `buildkit workers not ready after ${buildkitdTimeoutMs}ms timeout. Found ${lines.length - 1} workers, required ${requiredWorkers}`,
      );
    }
  } catch (error) {
    core.warning(
      `Error checking buildkit workers: ${(error as Error).message}`,
    );
    throw error;
  }

  return addr;
}

/**
 * Prunes buildkit cache data older than 7 days.
 * We don't specify any keep bytes here since we are
 * handling the ceph volume size limits ourselves in
 * the VM Agent.
 * @throws Error if buildctl prune command fails
 */
export async function pruneBuildkitCache(): Promise<void> {
  try {
    const sevenDaysInHours = 7 * 24;
    await execAsync(
      `sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} prune --keep-duration ${sevenDaysInHours}h --all`,
    );
    core.debug("Successfully pruned buildkit cache");
  } catch (error) {
    core.warning(`Error pruning buildkit cache: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Logs MD5 hashes of specific buildkit database files
 * Uses md5sum with a 5-second timeout to avoid blocking on large files
 */
export async function logDatabaseHashes(label: string): Promise<void> {
  const dbFiles = [
    "/var/lib/buildkit/history.db",
    "/var/lib/buildkit/cache.db",
  ];

  core.info(`Database file hashes (${label}):`);

  for (const filePath of dbFiles) {
    try {
      // Use timeout and md5sum to offload computation, avoiding reading file in Node.js
      const { stdout } = await execAsync(
        `timeout 5s sudo md5sum "${filePath}"`,
      );
      const output = stdout.trim();

      if (output) {
        // md5sum output format: "hash  filename"
        const hash = output.split(/\s+/)[0];
        core.info(`  ${filePath}: ${hash}`);
      } else {
        core.info(`  ${filePath}: not found`);
      }
    } catch (error) {
      // timeout command returns exit code 124 on timeout
      const execError = error as { code?: number; message?: string };
      if (execError.code === 124) {
        core.warning(`  ${filePath}: hash computation timed out after 5s`);
      } else {
        core.info(
          `  ${filePath}: error computing hash - ${execError.message || "unknown error"}`,
        );
      }
    }
  }
}

// stickyDiskTimeoutMs states the max amount of time this action will wait for the VM agent to
// expose the sticky disk from the storage agent, map it onto the host and then patch the drive
// into the VM.
const stickyDiskTimeoutMs = 45000;

// setupStickyDisk mounts a sticky disk for the entity and returns the device information.
// throws an error if it is unable to do so because of a timeout or an error
export async function setupStickyDisk(): Promise<{
  device: string;
  exposeId: string;
}> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, stickyDiskTimeoutMs);

    const stickyDiskResponse = await getStickyDisk({
      signal: controller.signal,
    });
    const exposeId = stickyDiskResponse.expose_id;
    const device = stickyDiskResponse.device;
    const parentSnapshotName = stickyDiskResponse.parent_snapshot_name;
    const cloneName = stickyDiskResponse.clone_name;

    core.info(`Sticky disk parent snapshot: ${parentSnapshotName}`);
    core.info(`Sticky disk clone name: ${cloneName}`);

    if (device === "") {
      throw new Error("No device found in sticky disk response");
    }
    clearTimeout(timeoutId);
    await maybeFormatBlockDevice(device);

    await execAsync(`sudo mkdir -p ${mountPoint}`);
    await execAsync(`sudo mount ${device} ${mountPoint}`);
    core.debug(`${device} has been mounted to ${mountPoint}`);
    core.info("Successfully obtained sticky disk");

    // Log filesystem free space after mount
    try {
      const { stdout } = await execAsync(
        `df -B1 --output=avail ${mountPoint} | tail -n1`,
      );
      const freeBytes = parseInt(stdout.trim(), 10);
      if (!isNaN(freeBytes) && freeBytes > 0) {
        const freeGiB = freeBytes / (1 << 30);
        core.info(
          `Filesystem free space after mount: ${freeBytes} bytes (${freeGiB.toFixed(2)} GiB)`,
        );
      } else {
        core.warning(`Invalid free space value from df: "${stdout.trim()}"`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to get filesystem free space: ${errorMsg}`);
    }

    // Check if lost+found directory has recovered files (indicating filesystem issues)
    try {
      const { stdout } = await execAsync(
        `find ${mountPoint}/lost+found -mindepth 1 -maxdepth 1 2>/dev/null | head -1`,
      );
      if (stdout.trim()) {
        // Count the number of recovered files
        const { stdout: countOutput } = await execAsync(
          `find ${mountPoint}/lost+found -mindepth 1 -maxdepth 1 2>/dev/null | wc -l`,
        );
        const fileCount = parseInt(countOutput.trim(), 10);
        core.warning(
          `Found ${fileCount} recovered file(s) in lost+found - this indicates filesystem recovery occurred during a previous unclean shutdown`,
        );
      } else {
        core.debug(`lost+found directory is empty (normal state)`);
      }
    } catch (error) {
      core.debug(
        `Error checking lost+found directory contents: ${(error as Error).message}`,
      );
    }

    // Log database file hashes after mount
    await logDatabaseHashes("after mount");

    return { device, exposeId };
  } catch (error) {
    core.warning(`Error in setupStickyDisk: ${(error as Error).message}`);
    await reporter.reportBuildPushActionFailure(
      "STICKYDISK_SETUP",
      error as Error,
      "sticky disk setup",
    );
    throw error;
  }
}
