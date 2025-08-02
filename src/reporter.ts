import * as core from "@actions/core";
import axios from "axios";
import axiosRetry from "axios-retry";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { StickyDiskService } from "@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect";
import {
  Metric,
  Metric_MetricType,
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

  (
    axiosRetry as unknown as {
      default: (client: unknown, options: unknown) => void;
    }
  ).default(client, {
    retries: 5,
    retryDelay: (
      axiosRetry as unknown as {
        exponentialDelay: (retryNumber: number) => number;
      }
    ).exponentialDelay,
    retryCondition: (error: unknown) => {
      return (
        (
          axiosRetry as unknown as {
            isNetworkOrIdempotentRequestError: (error: unknown) => boolean;
          }
        ).isNetworkOrIdempotentRequestError(error) ||
        ((error as { response?: { status?: number } }).response?.status
          ? (error as { response: { status: number } }).response.status >= 500
          : false)
      );
    },
  });

  return client;
};

export function createBlacksmithAgentClient() {
  core.info(
    `Creating Blacksmith agent client with port: ${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`,
  );
  const transport = createGrpcTransport({
    baseUrl: `http://192.168.127.1:${process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557"}`,
    httpVersion: "2",
  });

  return createClient(StickyDiskService, transport);
}

export async function reportBuildPushActionFailure(
  error?: Error,
  event?: string,
  isWarning?: boolean,
) {
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
    const metric = new Metric({
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

export async function commitStickyDisk(exposeId: string): Promise<void> {
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
