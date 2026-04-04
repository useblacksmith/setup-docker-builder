import * as core from "@actions/core";
import * as os from "os";
import axios, { type AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);

// Port that buildkitd listens on inside the follower VM.
const FOLLOWER_BUILDKITD_PORT = 1234;

// Port of the tunnel manager HTTP proxy running inside every sandbox VM.
const TUNNEL_MANAGER_PORT = 8377;

// Maximum time (ms) to wait for follower SSH to become available.
const SSH_READY_TIMEOUT_MS = 60_000;

// Maximum time (ms) to wait for follower buildkitd to be ready.
const BUILDKITD_READY_TIMEOUT_MS = 30_000;

export interface FollowerInfo {
  /** The VM ID returned by the sandbox API. */
  vmId: string;
  /** The buildx endpoint address reachable from the leader (via tunnel manager). */
  buildkitdAddr: string;
  /** The architecture of the follower (e.g. "amd64", "arm64"). */
  arch: string;
}

/**
 * Determines whether the requested platforms require a multi-arch build and
 * returns the architecture of the follower VM that needs to be spawned.
 *
 * Returns `null` if the build is single-arch or the host can handle all
 * requested platforms natively.
 */
export function getRequiredFollowerArch(platforms: string[]): string | null {
  if (!platforms || platforms.length === 0) {
    return null;
  }

  // Normalise: "linux/amd64,linux/arm64" may arrive as a single string or
  // already split into an array by the action toolkit.
  const allPlatforms = platforms
    .flatMap((p) => p.split(","))
    .map((p) => p.trim().toLowerCase());

  // Extract unique architectures from "linux/<arch>" entries.
  const arches = new Set<string>();
  for (const plat of allPlatforms) {
    const parts = plat.split("/");
    if (parts.length >= 2) {
      arches.add(parts[1]);
    }
  }

  // If only one architecture is requested, no follower is needed.
  if (arches.size <= 1) {
    return null;
  }

  // Determine the host architecture.
  const nodeArch = os.arch();
  const archMap: Record<string, string> = {
    x64: "amd64",
    arm64: "arm64",
    arm: "arm",
  };
  const hostArch = archMap[nodeArch] || nodeArch;

  // The follower should run the architecture that the host does NOT have.
  for (const arch of arches) {
    if (arch !== hostArch) {
      return arch;
    }
  }

  // All requested architectures match the host — no follower needed.
  return null;
}

/**
 * Creates an axios client configured to talk to the Blacksmith sandbox API
 * using the BLACKSMITH_SANDBOX_TOKEN for authentication.
 */
function createSandboxAPIClient(): AxiosInstance {
  const apiUrl =
    process.env.BLACKSMITH_BACKEND_URL ||
    (process.env.BLACKSMITH_ENV?.includes("staging")
      ? "https://stagingapi.blacksmith.sh"
      : "https://api.blacksmith.sh");

  const token = process.env.BLACKSMITH_SANDBOX_TOKEN;
  if (!token) {
    throw new Error(
      "BLACKSMITH_SANDBOX_TOKEN is not set. Cannot create follower sandbox.",
    );
  }

  const client = axios.create({
    baseURL: apiUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) =>
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      ((error as { response?: { status?: number } }).response?.status
        ? (error as { response: { status: number } }).response.status >= 500
        : false),
  });

  return client;
}

/**
 * Generates an ephemeral ED25519 SSH keypair in /tmp for inter-VM communication.
 * Returns { privateKeyPath, publicKey }.
 */
async function generateEphemeralSSHKey(): Promise<{
  privateKeyPath: string;
  publicKey: string;
}> {
  const keyPath = `/tmp/blacksmith_multiarch_ssh_${Date.now()}`;
  await execAsync(
    `ssh-keygen -t ed25519 -f ${keyPath} -N "" -C "multiarch-follower" -q`,
  );
  const { stdout: publicKey } = await execAsync(`cat ${keyPath}.pub`);
  core.info("Generated ephemeral SSH keypair for follower communication");
  return { privateKeyPath: keyPath, publicKey: publicKey.trim() };
}

/**
 * Spawns a follower sandbox VM on the specified architecture.
 * Returns the VM ID and SSH connection details.
 */
async function spawnFollowerSandbox(
  client: AxiosInstance,
  arch: string,
  sshPublicKey: string,
): Promise<{ vmId: string; sshHost: string; sshPort: number }> {
  core.info(`Creating follower sandbox with arch=${arch}...`);

  const createResponse = await client.post("/api/sandbox", {
    arch,
    ssh_public_key: sshPublicKey,
    vcpu: 2,
    teardown_minutes: 0, // No auto-teardown; we clean up explicitly.
    labels: ["multiarch-follower"],
  });

  const vmId = createResponse.data.vm_id;
  if (!vmId) {
    throw new Error(
      `Sandbox creation did not return vm_id: ${JSON.stringify(createResponse.data)}`,
    );
  }
  core.info(`Follower sandbox created: vm_id=${vmId}`);

  // Poll for SSH connection string.
  const startTime = Date.now();
  while (Date.now() - startTime < SSH_READY_TIMEOUT_MS) {
    try {
      const getResponse = await client.get(`/api/sandbox/${vmId}`);
      const data = getResponse.data;
      if (data.ssh_connection_string) {
        // Parse "ssh -p <port> runner@<host>" or "<host>:<port>" formats.
        const parsed = parseSSHConnectionString(data.ssh_connection_string);
        core.info(
          `Follower SSH ready: ${parsed.host}:${parsed.port} (took ${Date.now() - startTime}ms)`,
        );
        return { vmId, sshHost: parsed.host, sshPort: parsed.port };
      }
    } catch (error) {
      core.debug(`Waiting for follower SSH... ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(
    `Follower sandbox ${vmId} SSH not ready after ${SSH_READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Parses an SSH connection string into host and port.
 * Handles formats like "ssh -p 22 runner@host" or "host:port".
 */
function parseSSHConnectionString(connStr: string): {
  host: string;
  port: number;
} {
  // Format: "ssh -p <port> runner@<host>"
  const sshMatch = connStr.match(/-p\s+(\d+)\s+\S+@(\S+)/);
  if (sshMatch) {
    return { host: sshMatch[2], port: parseInt(sshMatch[1], 10) };
  }

  // Format: "<host>:<port>"
  const colonMatch = connStr.match(/^(\S+):(\d+)$/);
  if (colonMatch) {
    return { host: colonMatch[1], port: parseInt(colonMatch[2], 10) };
  }

  throw new Error(`Cannot parse SSH connection string: ${connStr}`);
}

/**
 * Executes a command on the follower VM via SSH.
 */
async function sshExec(
  privateKeyPath: string,
  host: string,
  port: number,
  command: string,
  timeoutMs = 30_000,
): Promise<string> {
  const sshCmd = [
    "ssh",
    `-i ${privateKeyPath}`,
    `-p ${port}`,
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
    `-o ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    `runner@${host}`,
    `'${command.replace(/'/g, "'\\''")}'`,
  ].join(" ");

  const { stdout } = await execAsync(sshCmd, { timeout: timeoutMs });
  return stdout.trim();
}

/**
 * Starts buildkitd on the follower VM via SSH and waits for it to be ready.
 */
async function startFollowerBuildkitd(
  privateKeyPath: string,
  host: string,
  port: number,
): Promise<void> {
  core.info("Starting buildkitd on follower VM...");

  // Start buildkitd in the background, listening on TCP.
  await sshExec(
    privateKeyPath,
    host,
    port,
    `nohup sudo buildkitd --addr tcp://0.0.0.0:${FOLLOWER_BUILDKITD_PORT} > /tmp/buildkitd.log 2>&1 &`,
  );

  // Wait for buildkitd to be ready.
  const startTime = Date.now();
  while (Date.now() - startTime < BUILDKITD_READY_TIMEOUT_MS) {
    try {
      const result = await sshExec(
        privateKeyPath,
        host,
        port,
        `sudo buildctl --addr tcp://127.0.0.1:${FOLLOWER_BUILDKITD_PORT} debug workers 2>/dev/null`,
        10_000,
      );
      if (result.includes("Platforms:")) {
        core.info(
          `Follower buildkitd ready (took ${Date.now() - startTime}ms)`,
        );
        return;
      }
    } catch {
      // buildkitd not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Follower buildkitd not ready after ${BUILDKITD_READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Exposes the follower's buildkitd port via the tunnel manager running inside
 * the follower VM. Returns the publicly reachable address.
 */
async function exposeFollowerBuildkitd(
  privateKeyPath: string,
  host: string,
  port: number,
): Promise<string> {
  core.info("Exposing follower buildkitd via tunnel manager...");

  const result = await sshExec(
    privateKeyPath,
    host,
    port,
    `curl -s -X POST http://localhost:${TUNNEL_MANAGER_PORT}/expose-port -H "Content-Type: application/json" -d '{"vm_port":${FOLLOWER_BUILDKITD_PORT}}'`,
    15_000,
  );

  const parsed = JSON.parse(result);
  if (!parsed.vm_hostname || !parsed.host_port) {
    throw new Error(`Tunnel manager did not return expected fields: ${result}`);
  }

  const addr = `tcp://${parsed.vm_hostname}:${parsed.host_port}`;
  core.info(`Follower buildkitd exposed at ${addr}`);
  return addr;
}

/**
 * Sets up a multi-arch build environment by spawning a follower sandbox VM
 * on the opposite architecture, starting buildkitd, and exposing it via
 * the tunnel manager.
 *
 * Returns information about the follower needed to configure buildx and
 * clean up afterwards.
 */
export async function setupMultiArchFollower(
  followerArch: string,
): Promise<FollowerInfo> {
  const client = createSandboxAPIClient();

  // Step 1: Generate ephemeral SSH keypair.
  const { privateKeyPath, publicKey } = await generateEphemeralSSHKey();

  // Step 2: Spawn follower sandbox.
  const { vmId, sshHost, sshPort } = await spawnFollowerSandbox(
    client,
    followerArch,
    publicKey,
  );

  // Step 3: Start buildkitd on the follower.
  await startFollowerBuildkitd(privateKeyPath, sshHost, sshPort);

  // Step 4: Expose follower buildkitd via tunnel manager.
  const buildkitdAddr = await exposeFollowerBuildkitd(
    privateKeyPath,
    sshHost,
    sshPort,
  );

  return {
    vmId,
    buildkitdAddr,
    arch: followerArch,
  };
}

/**
 * Tears down a follower sandbox VM by calling DELETE /api/sandbox/{vm_id}.
 * This also implicitly cleans up tunnel manager rules on the host.
 */
export async function teardownFollower(vmId: string): Promise<void> {
  try {
    const client = createSandboxAPIClient();
    core.info(`Deleting follower sandbox ${vmId}...`);
    await client.delete(`/api/sandbox/${vmId}`);
    core.info(`Follower sandbox ${vmId} deleted`);
  } catch (error) {
    core.warning(
      `Failed to delete follower sandbox ${vmId}: ${(error as Error).message}`,
    );
  }
}
