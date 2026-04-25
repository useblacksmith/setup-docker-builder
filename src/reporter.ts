import * as core from "@actions/core";
import axios from "axios";
import axiosRetry from "axios-retry";
import { create } from "@bufbuild/protobuf";
import { Client, createClient } from "@connectrpc/connect";
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

export function createBlacksmithAgentClient(): Client<
  typeof StickyDiskService
> {
  const baseUrl = `http://192.168.127.1:${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`;

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

  core.info(
    `Creating Blacksmith agent client with port: ${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`,
  );

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

/**
 * Reports bolt DB integrity check failure to the FA agent's internal metrics endpoint.
 * This sends the metric to Grafana via OpenTelemetry with the database file as an attribute.
 * Only called when an integrity check fails.
 */
export async function reportIntegrityCheckFailure(
  dbFile: string,
): Promise<void> {
  try {
    const metricsPort =
      process.env.BLACKSMITH_METRICS_HTTP_PORT ||
      process.env.METRICS_PORT ||
      "5556";
    const metricsHost = "192.168.127.1";
    const url = `http://${metricsHost}:${metricsPort}/internal`;

    // Extract database file name (e.g., "history.db" or "cache.db")
    const dbFileName = dbFile.split("/").pop() || dbFile;

    const payload = {
      metric_type: "boltdb_integrity_check_failure",
      value: 1, // Always 1 for failures
      vm_id: process.env.BLACKSMITH_VM_ID || "",
      attributes: {
        database_file: dbFileName,
      },
    };

    const response = await axios.post(url, payload, {
      timeout: 2000, // 2 second timeout
      headers: {
        "Content-Type": "application/json",
      },
    });

    core.debug(
      `Reported integrity check failure for ${dbFileName} (${response.status})`,
    );
  } catch (error) {
    // Don't fail the action if metrics reporting fails
    core.warning(
      `Failed to report integrity check metric: ${(error as Error).message}`,
    );
  }
}

export async function commitStickyDisk(
  exposeId: string,
  fsDiskUsageBytes: number | null,
): Promise<void> {
  try {
    const agentClient = createBlacksmithAgentClient();

    const commitRequest: Record<string, unknown> = {
      exposeId: exposeId,
      stickyDiskKey: process.env.GITHUB_REPO_NAME || "",
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

    core.info("Successfully committed sticky disk");
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
