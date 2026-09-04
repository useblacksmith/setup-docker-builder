import { describe, it, expect } from "vitest";
import {
  admitBuild,
  capRunnerStepTimeline,
  chunkBuilds,
  newExportCounters,
  newJobLifecycle,
  MAX_TIMELINE_BYTES,
  MAX_TOTAL_PAYLOAD_BYTES,
  type ExportedBuild,
} from "./build-telemetry";

function makeBuild(recordBytes: number, traceBytes: number): ExportedBuild {
  return {
    ref: "ref",
    historyRecord: new Uint8Array(recordBytes),
    trace: new Uint8Array(traceBytes),
    incomplete: false,
    truncated: false,
  };
}

const MIB = 1024 * 1024;

describe("admitBuild", () => {
  it("caps the job at 32 MiB", () => {
    expect(MAX_TOTAL_PAYLOAD_BYTES).toBe(32 * MIB);
  });

  it("charges record and trace bytes of an admitted build", () => {
    const counters = newExportCounters();
    const build = makeBuild(1000, 5000);
    expect(admitBuild(build, false, counters)).toBe(true);
    expect(build.trace).toHaveLength(5000);
    expect(build.truncated).toBe(false);
    expect(counters).toEqual({
      historyExportBytes: 6000,
      tracesDroppedOversize: 0,
      tracesDroppedPayloadCap: 0,
      recordsDroppedPayloadCap: 0,
    });
  });

  it("counts a per-build trace drop as oversize", () => {
    const counters = newExportCounters();
    const build = makeBuild(1000, 0);
    build.truncated = true;
    expect(admitBuild(build, true, counters)).toBe(true);
    expect(counters.historyExportBytes).toBe(1000);
    expect(counters.tracesDroppedOversize).toBe(1);
    expect(counters.tracesDroppedPayloadCap).toBe(0);
    expect(counters.recordsDroppedPayloadCap).toBe(0);
  });

  it("keeps the record but drops the trace when only the trace overflows the cap", () => {
    const counters = newExportCounters();
    counters.historyExportBytes = MAX_TOTAL_PAYLOAD_BYTES - 1500;
    const build = makeBuild(1000, 5000);
    expect(admitBuild(build, false, counters)).toBe(true);
    expect(build.trace).toHaveLength(0);
    expect(build.truncated).toBe(true);
    expect(counters.historyExportBytes).toBe(MAX_TOTAL_PAYLOAD_BYTES - 500);
    expect(counters.tracesDroppedPayloadCap).toBe(1);
    expect(counters.tracesDroppedOversize).toBe(0);
    expect(counters.recordsDroppedPayloadCap).toBe(0);
  });

  it("drops the whole build when the record overflows the cap", () => {
    const counters = newExportCounters();
    counters.historyExportBytes = MAX_TOTAL_PAYLOAD_BYTES - 500;
    const build = makeBuild(1000, 5000);
    expect(admitBuild(build, true, counters)).toBe(false);
    expect(counters.historyExportBytes).toBe(MAX_TOTAL_PAYLOAD_BYTES - 500);
    expect(counters.recordsDroppedPayloadCap).toBe(1);
    expect(counters.tracesDroppedPayloadCap).toBe(0);
    expect(counters.tracesDroppedOversize).toBe(0);
  });

  it("admits a build that exactly fills the cap", () => {
    const counters = newExportCounters();
    counters.historyExportBytes = MAX_TOTAL_PAYLOAD_BYTES - 6000;
    const build = makeBuild(1000, 5000);
    expect(admitBuild(build, false, counters)).toBe(true);
    expect(build.trace).toHaveLength(5000);
    expect(counters.historyExportBytes).toBe(MAX_TOTAL_PAYLOAD_BYTES);
  });

  it("counts every build under exactly one reason across a job", () => {
    const counters = newExportCounters();
    // The first build lost its trace to the per-trace cap; the rest are
    // 64 KiB records with 1 MiB traces.
    const builds = Array.from({ length: 40 }, () => makeBuild(64 * 1024, MIB));
    builds[0].trace = new Uint8Array(0);
    builds[0].truncated = true;
    const admitted: ExportedBuild[] = [];
    builds.forEach((b, i) => {
      if (admitBuild(b, i === 0, counters)) {
        admitted.push(b);
      }
    });
    // 64 KiB + 30 * 1088 KiB = 32704 KiB: builds 1..30 fit whole, build 31's
    // record exactly fills the 32 MiB cap but its trace does not fit, and
    // builds 32..39 fit nothing.
    expect(admitted).toHaveLength(32);
    expect(counters.tracesDroppedOversize).toBe(1);
    expect(counters.tracesDroppedPayloadCap).toBe(1);
    expect(counters.recordsDroppedPayloadCap).toBe(8);
    expect(counters.historyExportBytes).toBe(MAX_TOTAL_PAYLOAD_BYTES);
    expect(admitted.filter((b) => b.trace.length > 0)).toHaveLength(30);
    expect(admitted.filter((b) => b.truncated)).toHaveLength(2);
  });
});

describe("capRunnerStepTimeline", () => {
  it("ships a small timeline whole", () => {
    const lifecycle = newJobLifecycle();
    const raw = new Uint8Array(1234);
    const out = capRunnerStepTimeline(raw, lifecycle);
    expect(out).toHaveLength(1234);
    expect(lifecycle.timelineBytes).toBe(1234);
    expect(lifecycle.timelineTruncated).toBe(false);
  });

  it("keeps the newest bytes and records the truncation", () => {
    const lifecycle = newJobLifecycle();
    const raw = new Uint8Array(MAX_TIMELINE_BYTES + 10);
    raw.fill(1, 0, 10);
    raw.fill(2, 10);
    const out = capRunnerStepTimeline(raw, lifecycle);
    expect(out).toHaveLength(MAX_TIMELINE_BYTES);
    expect(out[0]).toBe(2);
    expect(lifecycle.timelineBytes).toBe(MAX_TIMELINE_BYTES);
    expect(lifecycle.timelineTruncated).toBe(true);
  });

  it("records an empty timeline", () => {
    const lifecycle = newJobLifecycle();
    expect(capRunnerStepTimeline(new Uint8Array(0), lifecycle)).toHaveLength(0);
    expect(lifecycle.timelineBytes).toBe(0);
    expect(lifecycle.timelineTruncated).toBe(false);
  });
});

describe("chunkBuilds", () => {
  it("keeps small builds in a single chunk", () => {
    const builds = [makeBuild(1000, 5000), makeBuild(2000, 0)];
    const chunks = chunkBuilds(builds, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("splits builds so each chunk fits the request budget", () => {
    // Each build is ~1.2 MiB; with a 1 MiB timeline the per-chunk budget is
    // ~2 MiB, so only one build fits per chunk.
    const builds = [
      makeBuild(200 * 1024, MIB),
      makeBuild(200 * 1024, MIB),
      makeBuild(200 * 1024, MIB),
    ];
    const chunks = chunkBuilds(builds, MIB);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      const bytes = chunk.reduce(
        (n, b) => n + b.historyRecord.length + b.trace.length,
        0,
      );
      expect(bytes + MIB).toBeLessThanOrEqual(3 * MIB);
    }
  });

  it("always ships an oversized build in its own chunk", () => {
    const builds = [makeBuild(512 * 1024, 2 * MIB), makeBuild(1000, 0)];
    const chunks = chunkBuilds(builds, MIB);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(1);
  });

  it("returns no chunks for no builds", () => {
    expect(chunkBuilds([], 100)).toHaveLength(0);
  });

  it("preserves build order across chunks", () => {
    const builds = Array.from({ length: 10 }, (_, i) => {
      const b = makeBuild(MIB, 0);
      b.ref = `ref-${i}`;
      return b;
    });
    const chunks = chunkBuilds(builds, 0);
    const refs = chunks.flat().map((b) => b.ref);
    expect(refs).toEqual(builds.map((b) => b.ref));
  });
});
