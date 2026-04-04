import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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

/** Paths to mTLS certificates used by the leader to connect to the follower. */
export interface MTLSCerts {
  /** Path to the ephemeral CA certificate. */
  caCertPath: string;
  /** Path to the client certificate (signed by the CA). */
  clientCertPath: string;
  /** Path to the client private key. */
  clientKeyPath: string;
}

export interface FollowerInfo {
  /** The VM ID returned by the sandbox API. */
  vmId: string;
  /** The buildx endpoint address reachable from the leader (via tunnel manager). */
  buildkitdAddr: string;
  /** The architecture of the follower (e.g. "amd64", "arm64"). */
  arch: string;
  /** mTLS certificates for securing the buildx → buildkitd connection. */
  mtlsCerts: MTLSCerts;
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
 * Generates an ephemeral mTLS certificate bundle (CA, server cert, client cert)
 * in a temporary directory. All certs are valid for 1 hour — long enough for
 * any build but short-lived enough to limit exposure.
 *
 * Returns paths to the CA cert, server cert/key, and client cert/key.
 */
async function generateMTLSCerts(): Promise<{
  caCertPath: string;
  caKeyPath: string;
  serverCertPath: string;
  serverKeyPath: string;
  clientCertPath: string;
  clientKeyPath: string;
}> {
  const certDir = `/tmp/blacksmith_mtls_${Date.now()}`;
  fs.mkdirSync(certDir, { mode: 0o700 });

  // Generate ephemeral CA.
  await execAsync(
    `openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-x509 -sha256 -days 1 -nodes ` +
      `-keyout ${certDir}/ca.key -out ${certDir}/ca.crt ` +
      `-subj "/CN=blacksmith-multiarch-ca"`,
  );

  // Generate server certificate (used by follower buildkitd).
  await execAsync(
    `openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-nodes -keyout ${certDir}/server.key -out ${certDir}/server.csr ` +
      `-subj "/CN=blacksmith-buildkitd"`,
  );
  // Sign with CA — add SAN with wildcard for vm hostnames.
  await execAsync(
    `openssl x509 -req -in ${certDir}/server.csr ` +
      `-CA ${certDir}/ca.crt -CAkey ${certDir}/ca.key -CAcreateserial ` +
      `-out ${certDir}/server.crt -days 1 -sha256 ` +
      `-extfile <(printf "subjectAltName=DNS:*.vm.blacksmith.sh,DNS:localhost,IP:127.0.0.1")`,
    { shell: "/bin/bash" },
  );

  // Generate client certificate (used by leader buildx).
  await execAsync(
    `openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-nodes -keyout ${certDir}/client.key -out ${certDir}/client.csr ` +
      `-subj "/CN=blacksmith-buildx-client"`,
  );
  await execAsync(
    `openssl x509 -req -in ${certDir}/client.csr ` +
      `-CA ${certDir}/ca.crt -CAkey ${certDir}/ca.key -CAcreateserial ` +
      `-out ${certDir}/client.crt -days 1 -sha256`,
  );

  core.info("Generated ephemeral mTLS certificate bundle");

  return {
    caCertPath: path.join(certDir, "ca.crt"),
    caKeyPath: path.join(certDir, "ca.key"),
    serverCertPath: path.join(certDir, "server.crt"),
    serverKeyPath: path.join(certDir, "server.key"),
    clientCertPath: path.join(certDir, "client.crt"),
    clientKeyPath: path.join(certDir, "client.key"),
  };
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
 * Copies mTLS server certificates to the follower VM via SCP.
 */
async function pushServerCertsToFollower(
  privateKeyPath: string,
  host: string,
  port: number,
  caCertPath: string,
  serverCertPath: string,
  serverKeyPath: string,
): Promise<void> {
  core.info("Copying mTLS server certificates to follower...");

  // Create cert directory on follower.
  await sshExec(privateKeyPath, host, port, "mkdir -p /tmp/buildkitd-certs");

  const scpOpts = [
    `-i ${privateKeyPath}`,
    `-P ${port}`,
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o LogLevel=ERROR",
  ].join(" ");

  for (const [localPath, remoteName] of [
    [caCertPath, "ca.crt"],
    [serverCertPath, "server.crt"],
    [serverKeyPath, "server.key"],
  ] as const) {
    await execAsync(
      `scp ${scpOpts} ${localPath} runner@${host}:/tmp/buildkitd-certs/${remoteName}`,
      { timeout: 15_000 },
    );
  }

  core.info("mTLS server certificates copied to follower");
}

/**
 * Starts buildkitd on the follower VM via SSH with mTLS enabled, and waits
 * for it to be ready.
 */
async function startFollowerBuildkitd(
  privateKeyPath: string,
  host: string,
  port: number,
): Promise<void> {
  core.info("Starting buildkitd on follower VM with mTLS...");

  // Start buildkitd with TLS flags.
  const buildkitdCmd = [
    "nohup sudo buildkitd",
    `--addr tcp://0.0.0.0:${FOLLOWER_BUILDKITD_PORT}`,
    "--tlscacert /tmp/buildkitd-certs/ca.crt",
    "--tlscert /tmp/buildkitd-certs/server.crt",
    "--tlskey /tmp/buildkitd-certs/server.key",
    "> /tmp/buildkitd.log 2>&1 &",
  ].join(" ");

  await sshExec(privateKeyPath, host, port, buildkitdCmd);

  // Wait for buildkitd to be ready (use buildctl with matching TLS certs).
  const startTime = Date.now();
  while (Date.now() - startTime < BUILDKITD_READY_TIMEOUT_MS) {
    try {
      const result = await sshExec(
        privateKeyPath,
        host,
        port,
        `sudo buildctl ` +
          `--addr tcp://127.0.0.1:${FOLLOWER_BUILDKITD_PORT} ` +
          `--tlscacert /tmp/buildkitd-certs/ca.crt ` +
          `--tlscert /tmp/buildkitd-certs/server.crt ` +
          `--tlskey /tmp/buildkitd-certs/server.key ` +
          `debug workers 2>/dev/null`,
        10_000,
      );
      if (result.includes("Platforms:")) {
        core.info(
          `Follower buildkitd ready with mTLS (took ${Date.now() - startTime}ms)`,
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

  // Step 2: Generate ephemeral mTLS certificates.
  const mtls = await generateMTLSCerts();

  // Step 3: Spawn follower sandbox.
  const { vmId, sshHost, sshPort } = await spawnFollowerSandbox(
    client,
    followerArch,
    publicKey,
  );

  // Step 4: Copy server certificates to follower.
  await pushServerCertsToFollower(
    privateKeyPath,
    sshHost,
    sshPort,
    mtls.caCertPath,
    mtls.serverCertPath,
    mtls.serverKeyPath,
  );

  // Step 5: Start buildkitd on the follower with mTLS.
  await startFollowerBuildkitd(privateKeyPath, sshHost, sshPort);

  // Step 6: Expose follower buildkitd via tunnel manager.
  const buildkitdAddr = await exposeFollowerBuildkitd(
    privateKeyPath,
    sshHost,
    sshPort,
  );

  return {
    vmId,
    buildkitdAddr,
    arch: followerArch,
    mtlsCerts: {
      caCertPath: mtls.caCertPath,
      clientCertPath: mtls.clientCertPath,
      clientKeyPath: mtls.clientKeyPath,
    },
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
