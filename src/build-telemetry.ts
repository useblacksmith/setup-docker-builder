import { promises as fs } from "fs";
import * as path from "path";
import * as core from "@actions/core";
import { create, toBinary } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";

import {
  Control,
  BuildHistoryRecordSchema,
  type BuildHistoryRecord,
} from "./gen/github.com/moby/buildkit/api/services/control/control_pb";
import { Content } from "./gen/containerd/services/content/v1/content_pb";
import {
  ReportDockerBuildRequestSchema,
  DockerBuildRecordSchema,
  DockerJobLifecycleSchema,
  CacheMountUsageSchema,
  BuilderMode,
  BuilderFallbackReason,
  CommitDecision,
  CommitSkipReason,
  IntegrityOutcome,
} from "@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb.js";
import * as reporter from "./reporter";

// Size caps: telemetry must never balloon teardown. Records over the cap ship
// without their trace and are marked truncated; the report as a whole is
// bounded too.
const MAX_TRACE_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TIMELINE_BYTES = 1024 * 1024;
const HISTORY_EXPORT_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 10_000;

export interface ExportedBuild {
  ref: string;
  historyRecord: Uint8Array;
  trace: Uint8Array;
  incomplete: boolean;
  truncated: boolean;
}

export interface CacheMount {
  mountId: string;
  bytes: number;
  records: number;
}

export interface DuSnapshot {
  totalBytes: number;
  cacheMountBytes: number;
  layersBytes: number;
  sourceLocalBytes: number;
  cacheMounts: CacheMount[];
}

// Lifecycle facts accumulated across the main and post steps. Values set in
// the main step must go through state-helper (separate processes); this
// object only lives within the post step.
export interface JobLifecycle {
  builderMode: BuilderMode;
  fallbackReason: BuilderFallbackReason;
  commitDecision: CommitDecision;
  commitSkipReason: CommitSkipReason;
  integrityOutcome: IntegrityOutcome;
  integrityDurationMs: number;
  du: DuSnapshot | null;
  fsUsedBytes: number;
  fsSizeBytes: number;
  pruneTriggered: boolean;
  pruneBytes: number;
  hotloadDurationMs: number;
  buildkitdReadyDurationMs: number;
  buildkitdShutdownDurationMs: number;
  buildkitdSigkillUsed: boolean;
  historyExportTimedOut: boolean;
  historyPruneFailed: boolean;
}

export function newJobLifecycle(): JobLifecycle {
  return {
    builderMode: BuilderMode.UNSPECIFIED,
    fallbackReason: BuilderFallbackReason.UNSPECIFIED,
    commitDecision: CommitDecision.UNSPECIFIED,
    commitSkipReason: CommitSkipReason.UNSPECIFIED,
    integrityOutcome: IntegrityOutcome.UNSPECIFIED,
    integrityDurationMs: 0,
    du: null,
    fsUsedBytes: 0,
    fsSizeBytes: 0,
    pruneTriggered: false,
    pruneBytes: 0,
    hotloadDurationMs: 0,
    buildkitdReadyDurationMs: 0,
    buildkitdShutdownDurationMs: 0,
    buildkitdSigkillUsed: false,
    historyExportTimedOut: false,
    historyPruneFailed: false,
  };
}

// --- BuildKit history record inspection --------------------------------------
//
// The BuildHistoryRecord ships as opaque-to-us bytes to the vm-agent (all
// real parsing is agent-side so BuildKit format drift is absorbed by an
// agent deploy). The guest only reads the record's Ref (to delete it after
// export) and the trace descriptor (to fetch the attachment), and strips the
// logs descriptor (logs are excluded from telemetry) before re-serializing.
// protobuf-es retains unknown fields across the decode/re-encode round trip,
// so fields newer than our vendored control.proto still reach the vm-agent.

export interface RecordInfo {
  ref: string;
  completed: boolean;
  traceDigest: string;
  traceSize: number;
  // Record bytes with the logs descriptor stripped.
  sanitized: Uint8Array;
}

export function inspectHistoryRecord(record: BuildHistoryRecord): RecordInfo {
  const info: RecordInfo = {
    ref: record.Ref,
    completed: record.CompletedAt !== undefined,
    traceDigest: record.trace?.digest ?? "",
    traceSize: Number(record.trace?.size ?? 0n),
    sanitized: new Uint8Array(0),
  };
  record.logs = undefined;
  info.sanitized = toBinary(BuildHistoryRecordSchema, record);
  return info;
}

// --- BuildKit history export -------------------------------------------------

function buildkitBaseUrl(buildkitdAddr: string): string {
  return `http://${buildkitdAddr.replace(/^tcp:\/\//, "")}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Exports this job's BuildKit history records via ListenBuildHistory: raw
 * record bytes (logs stripped) plus the solve-status trace attachment
 * fetched from buildkitd's content store. Failed builds are included;
 * builds still in flight are marked incomplete. Never throws.
 */
export async function exportBuildHistory(
  buildkitdAddr: string,
  lifecycle: JobLifecycle,
): Promise<ExportedBuild[]> {
  const sessionManager = new Http2SessionManager(
    buildkitBaseUrl(buildkitdAddr),
  );
  try {
    const transport = createGrpcTransport({
      baseUrl: buildkitBaseUrl(buildkitdAddr),
      sessionManager,
    });
    const control = createClient(Control, transport);
    const content = createClient(Content, transport);

    const collect = async (): Promise<ExportedBuild[]> => {
      const builds: ExportedBuild[] = [];
      let totalBytes = 0;
      for await (const event of control.listenBuildHistory({
        EarlyExit: true,
      })) {
        if (event.record === undefined) {
          continue;
        }
        const info = inspectHistoryRecord(event.record);
        if (info.sanitized.length === 0) {
          continue;
        }
        const build: ExportedBuild = {
          ref: info.ref,
          historyRecord: info.sanitized,
          trace: new Uint8Array(0),
          incomplete: !info.completed,
          truncated: false,
        };
        if (info.sanitized.length > MAX_RECORD_BYTES) {
          build.historyRecord = info.sanitized.subarray(0, MAX_RECORD_BYTES);
          build.truncated = true;
        }
        if (
          info.traceDigest &&
          info.traceSize > 0 &&
          info.traceSize <= MAX_TRACE_BYTES
        ) {
          try {
            const chunks: Uint8Array[] = [];
            for await (const resp of content.read({
              digest: info.traceDigest,
              offset: 0n,
              size: 0n,
            })) {
              chunks.push(resp.data);
            }
            const traceLen = chunks.reduce((n, c) => n + c.length, 0);
            const trace = new Uint8Array(traceLen);
            let off = 0;
            for (const c of chunks) {
              trace.set(c, off);
              off += c.length;
            }
            build.trace = trace;
          } catch (error) {
            core.debug(
              `Failed to read trace ${info.traceDigest}: ${(error as Error).message}`,
            );
            build.truncated = true;
          }
        } else if (info.traceDigest) {
          build.truncated = true;
        }
        const buildBytes = build.historyRecord.length + build.trace.length;
        if (totalBytes + buildBytes > MAX_TOTAL_PAYLOAD_BYTES) {
          build.trace = new Uint8Array(0);
          build.truncated = true;
          if (
            totalBytes + build.historyRecord.length >
            MAX_TOTAL_PAYLOAD_BYTES
          ) {
            core.debug("Build history payload cap reached, dropping record");
            continue;
          }
        }
        totalBytes += build.historyRecord.length + build.trace.length;
        builds.push(build);
      }
      return builds;
    };

    const builds = await withTimeout(
      collect(),
      HISTORY_EXPORT_TIMEOUT_MS,
      "build history export",
    );
    core.info(`Exported ${builds.length} BuildKit history record(s)`);
    return builds;
  } catch (error) {
    if ((error as Error).message?.includes("timed out")) {
      lifecycle.historyExportTimedOut = true;
    }
    core.warning(
      `Failed to export BuildKit history: ${(error as Error).message}`,
    );
    return [];
  } finally {
    try {
      sessionManager.abort();
    } catch {
      // best-effort
    }
  }
}

/**
 * Deletes the job's history records after export so history.db (and its
 * content-store attachment blobs) never get committed to the sticky disk
 * and carried by every future job. Never throws.
 */
export async function pruneBuildHistory(
  buildkitdAddr: string,
  refs: string[],
  lifecycle: JobLifecycle,
): Promise<void> {
  if (refs.length === 0) {
    return;
  }
  const sessionManager = new Http2SessionManager(
    buildkitBaseUrl(buildkitdAddr),
  );
  try {
    const transport = createGrpcTransport({
      baseUrl: buildkitBaseUrl(buildkitdAddr),
      sessionManager,
    });
    const control = createClient(Control, transport);
    for (const ref of refs) {
      if (!ref) {
        continue;
      }
      try {
        await withTimeout(
          control.updateBuildHistory({ Ref: ref, Delete: true }),
          5_000,
          `history delete ${ref}`,
        );
      } catch (error) {
        lifecycle.historyPruneFailed = true;
        core.debug(
          `Failed to delete history record ${ref}: ${(error as Error).message}`,
        );
      }
    }
    core.info(`Pruned ${refs.length} BuildKit history record(s)`);
  } catch (error) {
    lifecycle.historyPruneFailed = true;
    core.warning(
      `Failed to prune BuildKit history: ${(error as Error).message}`,
    );
  } finally {
    try {
      sessionManager.abort();
    } catch {
      // best-effort
    }
  }
}

// --- buildctl du parsing ------------------------------------------------------

/**
 * Parses `buildctl du -v` output into per-record-type totals plus a
 * per-cache-mount size table. The verbose format prints one block per
 * record with `ID:`, `Size:`, `Type:` and (for cache mounts)
 * `Description: cached mount /path` lines.
 */
export function parseDuVerbose(output: string): DuSnapshot {
  const snapshot: DuSnapshot = {
    totalBytes: 0,
    cacheMountBytes: 0,
    layersBytes: 0,
    sourceLocalBytes: 0,
    cacheMounts: [],
  };
  const mounts = new Map<string, CacheMount>();
  const blocks = output.split(/\n\s*\n/);
  for (const block of blocks) {
    if (block.trim().toLowerCase().startsWith("reclaimable:")) {
      continue;
    }
    let size = 0;
    let type = "";
    let description = "";
    for (const line of block.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) {
        continue;
      }
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "size") {
        size = parseHumanSize(value);
      } else if (key === "type") {
        type = value.toLowerCase();
      } else if (key === "description") {
        description = value;
      }
    }
    if (size <= 0 && !type) {
      continue;
    }
    snapshot.totalBytes += size;
    const isCacheMount =
      type === "exec.cachemount" || description.startsWith("cached mount");
    if (isCacheMount) {
      snapshot.cacheMountBytes += size;
      const mountId =
        description.replace(/^cached mount\s+/, "").split(/\s+/)[0] ||
        "unknown";
      const mount = mounts.get(mountId) ?? { mountId, bytes: 0, records: 0 };
      mount.bytes += size;
      mount.records += 1;
      mounts.set(mountId, mount);
    } else if (type === "source.local") {
      snapshot.sourceLocalBytes += size;
    } else if (type === "regular" || type === "") {
      snapshot.layersBytes += size;
    }
  }
  snapshot.cacheMounts = [...mounts.values()];
  return snapshot;
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export function parseHumanSize(value: string): number {
  const match = value.match(/^([\d.]+)\s*([a-zA-Z]*)/);
  if (!match) {
    return 0;
  }
  const num = parseFloat(match[1]);
  if (isNaN(num)) {
    return 0;
  }
  const unit = match[2].toLowerCase() || "b";
  return Math.round(num * (SIZE_UNITS[unit] ?? 1));
}

// --- Runner step timeline -----------------------------------------------------

/**
 * Reads the most recent runner Worker _diag log: the raw step timeline the
 * vm-agent parses to attribute builds to workflow steps. Ships raw (tail
 * beyond the cap is kept: the newest lines matter most). Never throws.
 */
export async function readRunnerStepTimeline(): Promise<Uint8Array> {
  try {
    const cwd = process.cwd();
    let runnerBase: string;
    if (cwd.includes("/_work/")) {
      runnerBase = cwd.substring(0, cwd.indexOf("/_work/"));
    } else {
      runnerBase = "/home/runner";
    }
    const diagPath = path.join(runnerBase, "_diag");
    const files = await fs.readdir(diagPath);
    const workerLogs = files
      .filter((f) => f.startsWith("Worker_") && f.endsWith(".log"))
      .sort();
    if (workerLogs.length === 0) {
      return new Uint8Array(0);
    }
    const raw = await fs.readFile(
      path.join(diagPath, workerLogs[workerLogs.length - 1]),
    );
    if (raw.length > MAX_TIMELINE_BYTES) {
      return new Uint8Array(raw.subarray(raw.length - MAX_TIMELINE_BYTES));
    }
    return new Uint8Array(raw);
  } catch (error) {
    core.debug(
      `Failed to read runner step timeline: ${(error as Error).message}`,
    );
    return new Uint8Array(0);
  }
}

// --- Report -------------------------------------------------------------------

/**
 * Sends the structured docker-build teardown report to the vm-agent over the
 * shared agent client (BLACKSMITH_AGENT_ADDR discovery). docker_build_ids are
 * issued host-side and returned in the response. Fail-soft: telemetry must
 * never fail the customer job.
 */
export async function reportDockerBuild(
  builds: ExportedBuild[],
  runnerStepTimeline: Uint8Array,
  lifecycle: JobLifecycle,
  exposeId: string,
): Promise<void> {
  try {
    const client = reporter.createBlacksmithAgentClient();

    const request = create(ReportDockerBuildRequestSchema, {
      vmId: process.env.BLACKSMITH_VM_ID || "",
      exposeId,
      builds: builds.map((b) =>
        create(DockerBuildRecordSchema, {
          historyRecord: b.historyRecord,
          trace: b.trace,
          incomplete: b.incomplete,
          truncated: b.truncated,
        }),
      ),
      runnerStepTimeline,
      lifecycle: create(DockerJobLifecycleSchema, {
        builderMode: lifecycle.builderMode,
        fallbackReason: lifecycle.fallbackReason,
        commitDecision: lifecycle.commitDecision,
        commitSkipReason: lifecycle.commitSkipReason,
        integrityOutcome: lifecycle.integrityOutcome,
        integrityDurationMs: BigInt(lifecycle.integrityDurationMs),
        duTotalBytes: BigInt(lifecycle.du?.totalBytes ?? 0),
        duCacheMountBytes: BigInt(lifecycle.du?.cacheMountBytes ?? 0),
        duLayersBytes: BigInt(lifecycle.du?.layersBytes ?? 0),
        duSourceLocalBytes: BigInt(lifecycle.du?.sourceLocalBytes ?? 0),
        cacheMounts: (lifecycle.du?.cacheMounts ?? []).map((m) =>
          create(CacheMountUsageSchema, {
            mountId: m.mountId,
            bytes: BigInt(m.bytes),
            records: BigInt(m.records),
          }),
        ),
        fsUsedBytes: BigInt(lifecycle.fsUsedBytes),
        fsSizeBytes: BigInt(lifecycle.fsSizeBytes),
        pruneTriggered: lifecycle.pruneTriggered,
        pruneBytes: BigInt(lifecycle.pruneBytes),
        hotloadDurationMs: BigInt(lifecycle.hotloadDurationMs),
        buildkitdReadyDurationMs: BigInt(lifecycle.buildkitdReadyDurationMs),
        buildkitdShutdownDurationMs: BigInt(
          lifecycle.buildkitdShutdownDurationMs,
        ),
        buildkitdSigkillUsed: lifecycle.buildkitdSigkillUsed,
        historyExportTimedOut: lifecycle.historyExportTimedOut,
        historyPruneFailed: lifecycle.historyPruneFailed,
      }),
      gitSha: process.env.GITHUB_SHA || "",
      gitBranch: process.env.GITHUB_REF_NAME || "",
    });

    const response = await withTimeout(
      client.reportDockerBuild(request),
      REPORT_TIMEOUT_MS,
      "docker build report",
    );
    if (response.dockerBuildIds.length > 0) {
      core.info(
        `Reported ${builds.length} docker build(s): ${response.dockerBuildIds.join(", ")}`,
      );
    } else {
      core.info("Reported docker job lifecycle");
    }
  } catch (error) {
    if (reporter.isAgentUnsupportedError(error)) {
      core.debug(
        `Skipping docker build telemetry: ${(error as Error).message}`,
      );
      return;
    }
    core.warning(
      `Failed to report docker build telemetry: ${(error as Error).message}`,
    );
  }
}
