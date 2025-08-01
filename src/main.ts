import * as fs from "fs";
import * as path from "path";
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
  leaveTailnet,
  pruneBuildkitCache,
} from "./setup_builder";
import { shutdownBuildkitd } from "./shutdown";
import { resolveRemoteBuilderPlatforms } from "./platform-utils";
import { Metric_MetricType } from "@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb.js";

const DEFAULT_BUILDX_VERSION = "v0.23.0";
const mountPoint = "/var/lib/buildkit";
const execAsync = promisify(exec);

// Minimal inputs interface for setup-docker-builder
export interface Inputs {
  "buildx-version": string;
  platforms: string[];
  nofallback: boolean;
  "github-token": string;
}

async function getInputs(): Promise<Inputs> {
  return {
    "buildx-version": core.getInput("buildx-version"),
    platforms: Util.getInputList("platforms"),
    nofallback: core.getBooleanInput("nofallback"),
    "github-token": core.getInput("github-token"),
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

    // Get CPU count for parallelism
    const parallelism = await getNumCPUs();

    // Start buildkitd
    const buildkitdStartTime = Date.now();
    const buildkitdAddr = await startAndConfigureBuildkitd(parallelism);
    const buildkitdDurationMs = Date.now() - buildkitdStartTime;
    await reporter.reportMetric(
      Metric_MetricType.BPA_BUILDKITD_READY_DURATION_MS,
      buildkitdDurationMs,
    );

    // Save state for post action
    stateHelper.setExposeId(stickyDiskSetup.exposeId);
    stateHelper.setBuildkitdAddr(buildkitdAddr);

    return { addr: buildkitdAddr, exposeId: stickyDiskSetup.exposeId };
  } catch (error) {
    await reporter.reportBuildPushActionFailure(
      error as Error,
      "starting blacksmith builder",
    );

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
  } finally {
    await leaveTailnet();
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

    // Create sentinel file to indicate setup is complete
    const sentinelPath = path.join("/tmp", "builder-setup-complete");
    try {
      fs.writeFileSync(sentinelPath, "Builder setup completed successfully.");
      core.debug(`Created builder setup sentinel file at ${sentinelPath}`);
    } catch (error) {
      core.warning(
        `Failed to create builder setup sentinel file: ${(error as Error).message}`,
      );
    }

    stateHelper.setTmpDir(Context.tmpDir());
  },
  // post action - cleanup
  async () => {
    await core.group("Cleaning up Docker builder", async () => {
      try {
        await leaveTailnet();

        // Check if buildkitd is running
        try {
          const { stdout } = await execAsync("pgrep buildkitd");
          if (stdout.trim()) {
            // Prune cache before shutdown
            try {
              core.info("Pruning BuildKit cache");
              await pruneBuildkitCache();
              core.info("BuildKit cache pruned");
            } catch (error) {
              core.warning(
                `Error pruning BuildKit cache: ${(error as Error).message}`,
              );
            }

            // Shutdown buildkitd
            const buildkitdShutdownStartTime = Date.now();
            await shutdownBuildkitd();
            const buildkitdShutdownDurationMs =
              Date.now() - buildkitdShutdownStartTime;
            await reporter.reportMetric(
              Metric_MetricType.BPA_BUILDKITD_SHUTDOWN_DURATION_MS,
              buildkitdShutdownDurationMs,
            );
            core.info("Shutdown buildkitd");
          } else {
            core.debug("No buildkitd process found running");
          }
        } catch (error) {
          if ((error as { code?: number }).code === 1) {
            core.debug("No buildkitd process found running");
          } else {
            core.warning(
              `Error checking for buildkitd processes: ${(error as Error).message}`,
            );
          }
        }

        // Unmount sticky disk
        try {
          await execAsync("sync");
          const { stdout: mountOutput } = await execAsync(
            `mount | grep ${mountPoint}`,
          );
          if (mountOutput) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await execAsync(`sudo umount ${mountPoint}`);
                core.debug(`${mountPoint} has been unmounted`);
                break;
              } catch (error) {
                if (attempt === 3) {
                  throw error;
                }
                core.warning(`Unmount failed, retrying (${attempt}/3)...`);
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
            core.info("Unmounted device");
          }
        } catch (error) {
          if ((error as { code?: number }).code === 1) {
            core.debug("No dangling mounts found to clean up");
          } else {
            core.warning(`Error during cleanup: ${(error as Error).message}`);
          }
        }

        // Clean up temp directory
        if (stateHelper.tmpDir.length > 0) {
          fs.rmSync(stateHelper.tmpDir, { recursive: true });
          core.debug(`Removed temp folder ${stateHelper.tmpDir}`);
        }

        // Commit sticky disk
        const exposeId = stateHelper.getExposeId();
        if (exposeId) {
          core.info("Committing sticky disk");
          await reporter.commitStickyDisk(exposeId);
        } else {
          core.warning(
            "Expose ID not found in state, skipping sticky disk commit",
          );
        }
      } catch (error) {
        core.warning(
          `Error during Docker builder cleanup: ${(error as Error).message}`,
        );
        await reporter.reportBuildPushActionFailure(
          error as Error,
          "docker builder cleanup",
        );
      }
    });
  },
);
