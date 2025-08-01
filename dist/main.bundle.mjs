import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as actionsToolkit from '@docker/actions-toolkit';
import { Toolkit } from '@docker/actions-toolkit/lib/toolkit';
import { Docker } from '@docker/actions-toolkit/lib/docker/docker';
import { Exec } from '@docker/actions-toolkit/lib/exec';
import { GitHub } from '@docker/actions-toolkit/lib/github';
import { Context } from '@docker/actions-toolkit/lib/context';
import { Util } from '@docker/actions-toolkit/lib/util';
import { promisify } from 'util';
import { exec } from 'child_process';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { StickyDiskService } from '@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect';
import { Metric, Metric_MetricType } from '@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb.js';
import * as TOML from '@iarna/toml';
import { execa } from 'execa';

// State variables needed for setup-docker-builder
const tmpDir = process.env.STATE_tmpDir || "";
process.env.STATE_inputs
    ? JSON.parse(process.env.STATE_inputs)
    : undefined;
function setTmpDir(tmpDir) {
    core.saveState("tmpDir", tmpDir);
}
function setInputs(inputs) {
    core.saveState("inputs", JSON.stringify(inputs));
}
function setExposeId(exposeId) {
    core.saveState("exposeId", exposeId);
}
function getExposeId() {
    return core.getState("exposeId");
}
function setBuildkitdAddr(addr) {
    core.saveState("buildkitdAddr", addr);
}
function setBuilderName(name) {
    core.saveState("builderName", name);
}

// Configure base axios instance for Blacksmith API
const createBlacksmithAPIClient = () => {
    const apiUrl = process.env.BLACKSMITH_BACKEND_URL ||
        (process.env.BLACKSMITH_ENV?.includes("staging")
            ? "https://stagingapi.blacksmith.sh"
            : "https://api.blacksmith.sh");
    core.debug(`Using Blacksmith API URL: ${apiUrl}`);
    const client = axios.create({
        baseURL: apiUrl,
        headers: {
            Authorization: `Bearer ${process.env.BLACKSMITH_STICKYDISK_TOKEN}`,
            "X-Github-Repo-Name": process.env.GITHUB_REPO_NAME || "",
            "Content-Type": "application/json",
        },
    });
    axiosRetry.default(client, {
        retries: 5,
        retryDelay: axiosRetry.exponentialDelay,
        retryCondition: (error) => {
            return (axiosRetry.isNetworkOrIdempotentRequestError(error) ||
                (error.response?.status ? error.response.status >= 500 : false));
        },
    });
    return client;
};
function createBlacksmithAgentClient() {
    core.info(`Creating Blacksmith agent client with port: ${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`);
    const transport = createGrpcTransport({
        baseUrl: `http://192.168.127.1:${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`,
        httpVersion: "2",
    });
    return createClient(StickyDiskService, transport);
}
async function reportBuildPushActionFailure(error, event, isWarning) {
    const requestOptions = {
        stickydisk_key: process.env.GITHUB_REPO_NAME || "",
        repo_name: process.env.GITHUB_REPO_NAME || "",
        region: process.env.BLACKSMITH_REGION || "eu-central",
        arch: process.env.BLACKSMITH_ENV?.includes("arm") ? "arm64" : "amd64",
        vm_id: process.env.BLACKSMITH_VM_ID || "",
        petname: process.env.PETNAME || "",
        message: event ? `${event}: ${error?.message || ""}` : error?.message || "",
        warning: isWarning || false,
    };
    try {
        const client = createBlacksmithAPIClient();
        const response = await client.post("/stickydisks/report-failed", requestOptions);
        return response.data;
    }
    catch (error) {
        core.warning(`Failed to report error to Blacksmith: ${error.message}`);
    }
}
async function reportMetric(metricType, value) {
    try {
        const agentClient = createBlacksmithAgentClient();
        const metric = new Metric({
            metricType,
            value: BigInt(value),
        });
        await agentClient.reportMetric({
            metrics: [metric],
        });
    }
    catch (error) {
        core.debug(`Failed to report metric: ${error.message}`);
    }
}
async function commitStickyDisk(exposeId) {
    try {
        const agentClient = createBlacksmithAgentClient();
        await agentClient.commitStickyDisk({
            exposeId: exposeId,
            stickyDiskKey: process.env.GITHUB_REPO_NAME || "",
            vmId: process.env.BLACKSMITH_VM_ID || "",
            shouldCommit: true,
            repoName: process.env.GITHUB_REPO_NAME || "",
            stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
        });
        core.info("Successfully committed sticky disk");
    }
    catch (error) {
        core.warning(`Failed to commit sticky disk: ${error.message}`);
        throw error;
    }
}

// Constants for configuration.
const BUILDKIT_DAEMON_ADDR = "tcp://127.0.0.1:1234";
const mountPoint$1 = "/var/lib/buildkit";
const execAsync$2 = promisify(exec);
// Tailscale functions removed - not needed for setup-docker-builder
// Multi-platform builds are handled differently in the new architecture
async function maybeFormatBlockDevice(device) {
    try {
        // Check if device is formatted with ext4
        try {
            const { stdout } = await execAsync$2(`sudo blkid -o value -s TYPE ${device}`);
            if (stdout.trim() === "ext4") {
                core.debug(`Device ${device} is already formatted with ext4`);
                try {
                    // Run resize2fs to ensure filesystem uses full block device
                    await execAsync$2(`sudo resize2fs -f ${device}`);
                    core.debug(`Resized ext4 filesystem on ${device}`);
                }
                catch (error) {
                    core.warning(`Error resizing ext4 filesystem on ${device}: ${error}`);
                }
                return device;
            }
        }
        catch (error) {
            // blkid returns non-zero if no filesystem found, which is fine
            core.debug(`No filesystem found on ${device}, will format it`);
        }
        // Format device with ext4
        core.debug(`Formatting device ${device} with ext4`);
        await execAsync$2(`sudo mkfs.ext4 -m0 -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`);
        core.debug(`Successfully formatted ${device} with ext4`);
        return device;
    }
    catch (error) {
        core.error(`Failed to format device ${device}: ${error.message}`);
        throw error;
    }
}
async function getNumCPUs() {
    try {
        const { stdout } = await execAsync$2("sudo nproc");
        return parseInt(stdout.trim());
    }
    catch (error) {
        core.warning(`Failed to get CPU count, defaulting to 1: ${error.message}`);
        return 1;
    }
}
async function writeBuildkitdTomlFile(parallelism, addr) {
    const jsonConfig = {
        root: "/var/lib/buildkit",
        grpc: {
            address: [addr],
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
    }
    catch (err) {
        core.warning(`error writing TOML configuration: ${err.message}`);
        throw err;
    }
}
async function startBuildkitd(parallelism, addr) {
    try {
        await writeBuildkitdTomlFile(parallelism, addr);
        // Creates a log stream to write buildkitd output to a file.
        const logStream = fs.createWriteStream("/tmp/buildkitd.log", {
            flags: "a",
        });
        // Start buildkitd in background (detached) mode since we're only setting up
        const buildkitdCommand = "nohup sudo buildkitd --debug --config=buildkitd.toml --allow-insecure-entitlement security.insecure --allow-insecure-entitlement network.host > /tmp/buildkitd.log 2>&1 &";
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
                const { stdout } = await execAsync$2("pgrep buildkitd");
                if (stdout.trim()) {
                    core.info(`buildkitd daemon started successfully with PID ${stdout.trim()}`);
                    return addr;
                }
            }
            catch (error) {
                // pgrep returns non-zero if process not found, which is expected while waiting
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
        throw new Error("Timed out waiting for buildkitd to start after 10 seconds");
    }
    catch (error) {
        core.error(`failed to start buildkitd daemon: ${error.message}`);
        throw error;
    }
}
async function getStickyDisk(options) {
    const client = await createBlacksmithAgentClient();
    core.info(`Created Blacksmith agent client`);
    // Test connection using up endpoint
    try {
        await client.up({}, { signal: options?.signal });
        core.info("Successfully connected to Blacksmith agent");
    }
    catch (error) {
        throw new Error(`grpc connection test failed: ${error.message}`);
    }
    const stickyDiskKey = process.env.GITHUB_REPO_NAME || "";
    if (stickyDiskKey === "") {
        throw new Error("GITHUB_REPO_NAME is not set");
    }
    core.info(`Getting sticky disk for ${stickyDiskKey}`);
    const response = await client.getStickyDisk({
        stickyDiskKey: stickyDiskKey,
        region: process.env.BLACKSMITH_REGION || "eu-central",
        installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || "",
        vmId: process.env.BLACKSMITH_VM_ID || "",
        stickyDiskType: "dockerfile",
        repoName: process.env.GITHUB_REPO_NAME || "",
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
    }, {
        signal: options?.signal,
    });
    return {
        expose_id: response.exposeId || "",
        device: response.diskIdentifier || "",
    };
}
async function leaveTailnet() {
    try {
        // Check if we're part of a tailnet before trying to leave
        try {
            const { stdout } = await execAsync$2("sudo tailscale status");
            if (stdout.trim() !== "") {
                await execAsync$2("sudo tailscale down");
                core.debug("Successfully left tailnet.");
            }
            else {
                core.debug("Not part of a tailnet, skipping leave.");
            }
        }
        catch (error) {
            // Type guard for ExecException which has the code property
            if (error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === 1) {
                core.debug("Not part of a tailnet, skipping leave.");
                return;
            }
            // Any other exit code indicates a real error
            throw error;
        }
    }
    catch (error) {
        core.warning(`Error leaving tailnet: ${error instanceof Error ? error.message : String(error)}`);
    }
}
// buildkitdTimeoutMs states the max amount of time this action will wait for the buildkitd
// daemon to start have its socket ready. It also additionally governs how long we will wait for
// the buildkitd workers to be ready.
const buildkitdTimeoutMs = 30000;
async function startAndConfigureBuildkitd(parallelism, platforms) {
    // Use standard buildkitd address
    const buildkitdAddr = BUILDKIT_DAEMON_ADDR;
    const addr = await startBuildkitd(parallelism, buildkitdAddr);
    core.debug(`buildkitd daemon started at addr ${addr}`);
    // Check that buildkit instance is ready by querying workers for up to 30s
    const startTimeBuildkitReady = Date.now();
    const timeoutBuildkitReady = buildkitdTimeoutMs;
    while (Date.now() - startTimeBuildkitReady < timeoutBuildkitReady) {
        try {
            const { stdout } = await execAsync$2(`sudo buildctl --addr ${addr} debug workers`);
            const lines = stdout.trim().split("\n");
            // We only need 1 worker for setup-docker-builder
            const requiredWorkers = 1;
            if (lines.length > requiredWorkers) {
                core.info(`Found ${lines.length - 1} workers, required ${requiredWorkers}`);
                break;
            }
        }
        catch (error) {
            core.debug(`Error checking buildkit workers: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // Final check after timeout.
    try {
        const { stdout } = await execAsync$2(`sudo buildctl --addr ${addr} debug workers`);
        const lines = stdout.trim().split("\n");
        const requiredWorkers = 1;
        if (lines.length <= requiredWorkers) {
            throw new Error(`buildkit workers not ready after ${buildkitdTimeoutMs}ms timeout. Found ${lines.length - 1} workers, required ${requiredWorkers}`);
        }
    }
    catch (error) {
        core.warning(`Error checking buildkit workers: ${error.message}`);
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
async function pruneBuildkitCache() {
    try {
        const sevenDaysInHours = 7 * 24;
        await execAsync$2(`sudo buildctl --addr ${BUILDKIT_DAEMON_ADDR} prune --keep-duration ${sevenDaysInHours}h --all`);
        core.debug("Successfully pruned buildkit cache");
    }
    catch (error) {
        core.warning(`Error pruning buildkit cache: ${error.message}`);
        throw error;
    }
}
// stickyDiskTimeoutMs states the max amount of time this action will wait for the VM agent to
// expose the sticky disk from the storage agent, map it onto the host and then patch the drive
// into the VM.
const stickyDiskTimeoutMs = 45000;
// setupStickyDisk mounts a sticky disk for the entity and returns the device information.
// throws an error if it is unable to do so because of a timeout or an error
async function setupStickyDisk() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, stickyDiskTimeoutMs);
        const stickyDiskResponse = await getStickyDisk({
            signal: controller.signal,
        });
        let exposeId = stickyDiskResponse.expose_id;
        let device = stickyDiskResponse.device;
        if (device === "") {
            // TODO(adityamaru): Remove this once all of our VM agents are returning the device in the stickydisk response.
            device = "/dev/vdb";
        }
        clearTimeout(timeoutId);
        await maybeFormatBlockDevice(device);
        // We don't report builds in setup-docker-builder since we're only setting up
        await execAsync$2(`sudo mkdir -p ${mountPoint$1}`);
        await execAsync$2(`sudo mount ${device} ${mountPoint$1}`);
        core.debug(`${device} has been mounted to ${mountPoint$1}`);
        core.info("Successfully obtained sticky disk");
        // Check inode usage at mountpoint, and report if over 80%.
        try {
            const { stdout } = await execAsync$2(`df -i ${mountPoint$1} | tail -1 | awk '{print $5}' | sed 's/%//'`);
            const inodePercentage = parseInt(stdout.trim());
            if (!isNaN(inodePercentage) && inodePercentage > 80) {
                // Report if over 80%
                await reportBuildPushActionFailure(new Error(`High inode usage (${inodePercentage}%) detected at ${mountPoint$1}`), "setupStickyDisk", true /* isWarning */);
                core.warning(`High inode usage (${inodePercentage}%) detected at ${mountPoint$1}`);
            }
        }
        catch (error) {
            core.debug(`Error checking inode usage: ${error.message}`);
        }
        return { device, exposeId };
    }
    catch (error) {
        core.warning(`Error in setupStickyDisk: ${error.message}`);
        throw error;
    }
}

const execAsync$1 = promisify(exec);
async function shutdownBuildkitd() {
    const startTime = Date.now();
    const timeout = 10000; // 10 seconds
    const backoff = 300; // 300ms
    try {
        await execAsync$1(`sudo pkill -TERM buildkitd`);
        // Wait for buildkitd to shutdown with backoff retry
        while (Date.now() - startTime < timeout) {
            try {
                const { stdout } = await execAsync$1("pgrep buildkitd");
                core.debug(`buildkitd process still running with PID: ${stdout.trim()}`);
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
            catch (error) {
                if (error.code === 1) {
                    // pgrep returns exit code 1 when no process is found, which means shutdown successful
                    core.debug("buildkitd successfully shutdown");
                    return;
                }
                // Some other error occurred
                throw error;
            }
        }
        throw new Error("Timed out waiting for buildkitd to shutdown after 10 seconds");
    }
    catch (error) {
        core.error(`error shutting down buildkitd process: ${error.message}`);
        throw error;
    }
}

const DEFAULT_BUILDX_VERSION = "v0.23.0";
const mountPoint = "/var/lib/buildkit";
const execAsync = promisify(exec);
async function getInputs() {
    return {
        "buildx-version": core.getInput("buildx-version"),
        platforms: Util.getInputList("platforms"),
        nofallback: core.getBooleanInput("nofallback"),
        "github-token": core.getInput("github-token"),
    };
}
async function retryWithBackoff(operation, maxRetries = 5, initialBackoffMs = 200) {
    let lastError = new Error("No error occurred");
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (error.message?.includes("429") ||
                error.status === 429) {
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
async function setupBuildx(version, toolkit) {
    let toolPath;
    const standalone = await toolkit.buildx.isStandalone();
    if (!(await toolkit.buildx.isAvailable()) || version) {
        await core.group(`Download buildx from GitHub Releases`, async () => {
            toolPath = await retryWithBackoff(() => toolkit.buildxInstall.download(version || "latest", true));
        });
    }
    if (toolPath) {
        await core.group(`Install buildx`, async () => {
            if (standalone) {
                await toolkit.buildxInstall.installStandalone(toolPath);
            }
            else {
                await toolkit.buildxInstall.installPlugin(toolPath);
            }
        });
    }
    await core.group(`Buildx version`, async () => {
        await toolkit.buildx.printVersion();
    });
}
function isValidBuildxVersion(version) {
    return version === "latest" || /^v\d+\.\d+\.\d+$/.test(version);
}
/**
 * Starts and configures the Blacksmith builder
 * Returns the buildkit address and expose ID for the sticky disk
 */
async function startBlacksmithBuilder(inputs) {
    try {
        // Setup sticky disk
        const stickyDiskStartTime = Date.now();
        const stickyDiskSetup = await setupStickyDisk();
        const stickyDiskDurationMs = Date.now() - stickyDiskStartTime;
        await reportMetric(Metric_MetricType.BPA_HOTLOAD_DURATION_MS, stickyDiskDurationMs);
        // Get CPU count for parallelism
        const parallelism = await getNumCPUs();
        // Start buildkitd
        const buildkitdStartTime = Date.now();
        const buildkitdAddr = await startAndConfigureBuildkitd(parallelism, inputs.platforms);
        const buildkitdDurationMs = Date.now() - buildkitdStartTime;
        await reportMetric(Metric_MetricType.BPA_BUILDKITD_READY_DURATION_MS, buildkitdDurationMs);
        // Save state for post action
        setExposeId(stickyDiskSetup.exposeId);
        setBuildkitdAddr(buildkitdAddr);
        return { addr: buildkitdAddr, exposeId: stickyDiskSetup.exposeId };
    }
    catch (error) {
        await reportBuildPushActionFailure(error, "starting blacksmith builder");
        if (inputs.nofallback) {
            core.warning(`Error during Blacksmith builder setup: ${error.message}. Failing because nofallback is set.`);
            throw error;
        }
        core.warning(`Error during Blacksmith builder setup: ${error.message}. Falling back to local builder.`);
        return { addr: null, exposeId: "" };
    }
    finally {
        await leaveTailnet();
    }
}
actionsToolkit.run(
// main action
async () => {
    await reportMetric(Metric_MetricType.BPA_FEATURE_USAGE, 1);
    const inputs = await getInputs();
    setInputs(inputs);
    const toolkit = new Toolkit();
    // Print runtime token ACs
    await core.group(`GitHub Actions runtime token ACs`, async () => {
        try {
            await GitHub.printActionsRuntimeTokenACs();
        }
        catch (e) {
            core.warning(e.message);
        }
    });
    // Print Docker info
    await core.group(`Docker info`, async () => {
        try {
            await Docker.printVersion();
            await Docker.printInfo();
        }
        catch (e) {
            core.info(e.message);
        }
    });
    // Validate and setup buildx version
    let buildxVersion = DEFAULT_BUILDX_VERSION;
    if (inputs["buildx-version"] && inputs["buildx-version"].trim() !== "") {
        if (isValidBuildxVersion(inputs["buildx-version"])) {
            buildxVersion = inputs["buildx-version"];
        }
        else {
            core.warning(`Invalid buildx-version '${inputs["buildx-version"]}'. ` +
                `Expected 'latest' or a version in the form v<MAJOR>.<MINOR>.<PATCH>. ` +
                `Falling back to default ${DEFAULT_BUILDX_VERSION}.`);
        }
    }
    // Setup buildx
    await core.group(`Setup buildx`, async () => {
        await setupBuildx(buildxVersion, toolkit);
        if (!(await toolkit.buildx.isAvailable())) {
            core.setFailed(`Docker buildx is required. See https://github.com/docker/setup-buildx-action to set up buildx.`);
            return;
        }
    });
    // Start Blacksmith builder
    let builderInfo = {
        addr: null};
    await core.group(`Starting Blacksmith builder`, async () => {
        builderInfo = await startBlacksmithBuilder(inputs);
    });
    if (builderInfo.addr) {
        // Create and configure the builder
        await core.group(`Creating builder instance`, async () => {
            const name = `blacksmith-${Date.now().toString(36)}`;
            setBuilderName(name);
            // Create the builder
            const createCmd = await toolkit.buildx.getCommand([
                "create",
                "--name",
                name,
                "--driver",
                "remote",
                builderInfo.addr,
            ]);
            core.info(`Creating builder with command: ${createCmd.command} ${createCmd.args.join(" ")}`);
            await Exec.getExecOutput(createCmd.command, createCmd.args, {
                ignoreReturnCode: true,
            }).then((res) => {
                if (res.stderr.length > 0 && res.exitCode != 0) {
                    throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? "unknown error");
                }
            });
            // Set as default builder
            const useCmd = await toolkit.buildx.getCommand(["use", name]);
            core.info("Setting builder as default");
            await Exec.getExecOutput(useCmd.command, useCmd.args, {
                ignoreReturnCode: true,
            }).then((res) => {
                if (res.stderr.length > 0 && res.exitCode != 0) {
                    throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? "unknown error");
                }
            });
        });
        // Print builder info
        await core.group(`Builder info`, async () => {
            const builder = await toolkit.builder.inspect();
            core.info(JSON.stringify(builder, null, 2));
            core.info("Blacksmith builder is ready for use by Docker");
        });
    }
    else {
        // Fallback to local builder
        core.warning("Failed to setup Blacksmith builder, using local builder");
        await core.group(`Checking for configured builder`, async () => {
            try {
                const builder = await toolkit.builder.inspect();
                if (builder) {
                    core.info(`Found configured builder: ${builder.name}`);
                }
                else {
                    // Create a local builder
                    const createLocalBuilderCmd = "docker buildx create --name local --driver docker-container --use";
                    try {
                        await Exec.exec(createLocalBuilderCmd);
                        core.info("Created and set a local builder for use");
                    }
                    catch (error) {
                        core.setFailed(`Failed to create local builder: ${error.message}`);
                    }
                }
            }
            catch (error) {
                core.setFailed(`Error configuring builder: ${error.message}`);
            }
        });
    }
    // Create sentinel file to indicate setup is complete
    const sentinelPath = path.join("/tmp", "builder-setup-complete");
    try {
        fs.writeFileSync(sentinelPath, "Builder setup completed successfully.");
        core.debug(`Created builder setup sentinel file at ${sentinelPath}`);
    }
    catch (error) {
        core.warning(`Failed to create builder setup sentinel file: ${error.message}`);
    }
    setTmpDir(Context.tmpDir());
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
                    }
                    catch (error) {
                        core.warning(`Error pruning BuildKit cache: ${error.message}`);
                    }
                    // Shutdown buildkitd
                    const buildkitdShutdownStartTime = Date.now();
                    await shutdownBuildkitd();
                    const buildkitdShutdownDurationMs = Date.now() - buildkitdShutdownStartTime;
                    await reportMetric(Metric_MetricType.BPA_BUILDKITD_SHUTDOWN_DURATION_MS, buildkitdShutdownDurationMs);
                    core.info("Shutdown buildkitd");
                }
                else {
                    core.debug("No buildkitd process found running");
                }
            }
            catch (error) {
                if (error.code === 1) {
                    core.debug("No buildkitd process found running");
                }
                else {
                    core.warning(`Error checking for buildkitd processes: ${error.message}`);
                }
            }
            // Unmount sticky disk
            try {
                await execAsync("sync");
                const { stdout: mountOutput } = await execAsync(`mount | grep ${mountPoint}`);
                if (mountOutput) {
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            await execAsync(`sudo umount ${mountPoint}`);
                            core.debug(`${mountPoint} has been unmounted`);
                            break;
                        }
                        catch (error) {
                            if (attempt === 3) {
                                throw error;
                            }
                            core.warning(`Unmount failed, retrying (${attempt}/3)...`);
                            await new Promise((resolve) => setTimeout(resolve, 100));
                        }
                    }
                    core.info("Unmounted device");
                }
            }
            catch (error) {
                if (error.code === 1) {
                    core.debug("No dangling mounts found to clean up");
                }
                else {
                    core.warning(`Error during cleanup: ${error.message}`);
                }
            }
            // Clean up temp directory
            if (tmpDir.length > 0) {
                fs.rmSync(tmpDir, { recursive: true });
                core.debug(`Removed temp folder ${tmpDir}`);
            }
            // Commit sticky disk
            const exposeId = getExposeId();
            if (exposeId) {
                core.info("Committing sticky disk");
                await commitStickyDisk(exposeId);
            }
            else {
                core.warning("Expose ID not found in state, skipping sticky disk commit");
            }
        }
        catch (error) {
            core.warning(`Error during Docker builder cleanup: ${error.message}`);
            await reportBuildPushActionFailure(error, "docker builder cleanup");
        }
    });
});
