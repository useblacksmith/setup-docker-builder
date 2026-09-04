import { describe, it, expect } from "vitest";
import { chunkBuilds, type ExportedBuild } from "./build-telemetry";

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
