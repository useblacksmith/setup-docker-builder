import * as core from "@actions/core";
import { UserInputError } from "./user-input-error";
import axios from "axios";
import axiosRetry from "axios-retry";
import { create } from "@bufbuild/protobuf";
import { Client, Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  MetricSchema,
  Metric_MetricType,
  StickyDiskService,
} from "@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb.js";

// Configure base axios instance for Blacksmith API
const createBlacksmithAPIClient = () => {
  const apiUrl =
    process.env.BLACKSMITH_BACKEND_URL ||
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

  axiosRetry(client, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
      return (
        axiosRetry.isNetworkOrIdempotentRequestError(error) ||
        ((error as { response?: { status?: number } }).response?.status
          ? (error as { response: { status: number } }).response.status >= 500
          : false)
      );
    },
  });

  return client;
};

// Cached so we open a single HTTP/2 session per process. The session must
// be torn down via closeBlacksmithAgentClient() before the action exits,
// otherwise it keeps the Node event loop alive for ~30s.
let cachedAgentSessionManager: Http2SessionManager | undefined;
let cachedAgentClient: Client<typeof StickyDiskService> | undefined;
let cachedAgentBaseUrl: string | undefined;

export function getAgentAddr(): string | undefined {
  return process.env.BLACKSMITH_AGENT_ADDR || undefined;
}

// True for environments where the agent is not expected to serve sticky
// disks (agent address/port env not exported, or the agent rejected the
// RPC as unimplemented); these are not infra failures and are not reported.
export function isAgentUnsupportedError(error: unknown): boolean {
  if (
    error instanceof Error &&
    error.message.includes("cannot dial the Blacksmith agent")
  ) {
    return true;
  }
  return error instanceof ConnectError && error.code === Code.Unimplemented;
}

export function createBlacksmithAgentClient(): Client<
  typeof StickyDiskService
> {
  const addr = getAgentAddr();
  const port = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT;
  if (!addr || !port) {
    throw new Error(
      "BLACKSMITH_AGENT_ADDR or BLACKSMITH_STICKY_DISK_GRPC_PORT is not set; cannot dial the Blacksmith agent",
    );
  }
  const baseUrl = `http://${addr}:${port}`;

  if (cachedAgentClient && cachedAgentBaseUrl === baseUrl) {
    return cachedAgentClient;
  }

  if (cachedAgentSessionManager) {
    try {
      cachedAgentSessionManager.abort();
    } catch {
      // best-effort
    }
  }

  core.info(`Creating Blacksmith agent client for ${baseUrl}`);

  cachedAgentSessionManager = new Http2SessionManager(baseUrl);
  const transport = createGrpcTransport({
    baseUrl,
    sessionManager: cachedAgentSessionManager,
  });
  cachedAgentClient = createClient(StickyDiskService, transport);
  cachedAgentBaseUrl = baseUrl;

  return cachedAgentClient;
}

// Must be called before the action exits. See cache comment above.
// Safe to call multiple times.
export function closeBlacksmithAgentClient(): void {
  if (cachedAgentSessionManager) {
    try {
      cachedAgentSessionManager.abort();
    } catch (error) {
      core.debug(
        `Failed to abort Blacksmith agent session: ${(error as Error).message}`,
      );
    }
    cachedAgentSessionManager = undefined;
  }
  cachedAgentClient = undefined;
  cachedAgentBaseUrl = undefined;
}

export async function reportBuildPushActionFailure(
  type:
    | "BUILDER_STARTUP"
    | "BUILDER_CLEANUP"
    | "STICKYDISK_SETUP"
    | "STICKYDISK_COMMIT",
  error?: Error,
  event?: string,
) {
  if (error instanceof UserInputError) {
    core.debug(
      `Not reporting user input error to Blacksmith: ${error.message}`,
    );
    return;
  }
  const requestOptions = {
    stickydisk_key: process.env.GITHUB_REPO_NAME || "",
    repo_name: process.env.GITHUB_REPO_NAME || "",
    region: process.env.BLACKSMITH_REGION || "eu-central",
    arch: process.env.BLACKSMITH_ENV?.includes("arm") ? "arm64" : "amd64",
    vm_id: process.env.BLACKSMITH_VM_ID || "",
    petname: process.env.PETNAME || "",
    type: type,
    message: event ? `${event}: ${error?.message || ""}` : error?.message || "",
  };

  try {
    const client = createBlacksmithAPIClient();
    const response = await client.post(
      "/stickydisks/report-failed",
      requestOptions,
    );
    return response.data;
  } catch (error) {
    core.warning(
      `Failed to report error to Blacksmith: ${(error as Error).message}`,
    );
  }
}

export async function reportMetric(
  metricType: Metric_MetricType,
  value: number,
) {
  try {
    const agentClient = createBlacksmithAgentClient();
    const metric = create(MetricSchema, {
      type: metricType,
      value: { case: "intValue", value: BigInt(value) },
    });

    await agentClient.reportMetric({
      repoName: process.env.GITHUB_REPO_NAME || "",
      region: process.env.BLACKSMITH_REGION || "eu-central",
      metric: metric,
    });
  } catch (error) {
    core.debug(`Failed to report metric: ${(error as Error).message}`);
  }
}

export async function commitStickyDisk(
  exposeId: string,
  fsDiskUsageBytes: number | null,
  cacheKey?: string,
): Promise<void> {
  try {
    const agentClient = createBlacksmithAgentClient();

    const commitRequest: Record<string, unknown> = {
      exposeId: exposeId,
      stickyDiskKey: cacheKey || process.env.GITHUB_REPO_NAME || "",
      vmId: process.env.BLACKSMITH_VM_ID || "",
      shouldCommit: true,
      repoName: process.env.GITHUB_REPO_NAME || "",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
    };

    // Only include fsDiskUsageBytes if we have valid data (> 0)
    // This allows storage agent to fall back to previous sizing logic when data is unavailable
    if (fsDiskUsageBytes !== null && fsDiskUsageBytes > 0) {
      commitRequest.fsDiskUsageBytes = BigInt(fsDiskUsageBytes);
      core.debug(`Reporting fs usage: ${fsDiskUsageBytes} bytes`);
    } else {
      core.debug(
        "No fs usage data available, storage agent will use fallback sizing",
      );
    }

    await agentClient.commitStickyDisk(commitRequest);

    // The host applies the commit at VM teardown, after this step has ended;
    // this only confirms the request was accepted.
    core.info("Sticky disk commit requested; applied at VM shutdown");
  } catch (error) {
    core.warning(`Failed to commit sticky disk: ${(error as Error).message}`);
    throw error;
  }
}

// Stub for build reporting - not used in setup-docker-builder
// This function is only needed in build-push-action
// Keeping it here as a stub to maintain interface compatibility
export async function reportBuild(): Promise<{
  docker_build_id: string;
} | null> {
  return null;
}
