import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  buildkitdConfigFromServer,
  DEFAULT_BUILDKITD_CONFIG,
  parseMaxCacheSizeMB,
  withMaxCacheSize,
} from "./server-config";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

describe("buildkitdConfigFromServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to the default config when the backend sent no policy", () => {
    expect(buildkitdConfigFromServer(undefined)).toBe(DEFAULT_BUILDKITD_CONFIG);
    expect(buildkitdConfigFromServer(0)).toBe(DEFAULT_BUILDKITD_CONFIG);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("overrides only keepDuration, keeping the rest of the default policy", () => {
    const config = buildkitdConfigFromServer(72n);

    expect(config.gc).toBe(true);
    expect(config.gcPolicy).toEqual([{ keepDuration: "72h", all: true }]);
    expect(DEFAULT_BUILDKITD_CONFIG.gcPolicy?.[0]?.keepDuration).toBe("192h");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("accepts plain numbers and the range bounds", () => {
    expect(buildkitdConfigFromServer(1).gcPolicy?.[0]?.keepDuration).toBe("1h");
    expect(buildkitdConfigFromServer(8760n).gcPolicy?.[0]?.keepDuration).toBe(
      "8760h",
    );
  });

  it.each([-1, 0.5, 8761, Number.NaN, 2n ** 40n])(
    "warns and falls back for invalid value %s",
    (value) => {
      expect(buildkitdConfigFromServer(value)).toBe(DEFAULT_BUILDKITD_CONFIG);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring invalid buildkitd GC keepDuration"),
      );
    },
  );
});

describe("parseMaxCacheSizeMB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without warning when the input is not set", () => {
    expect(parseMaxCacheSizeMB("")).toBeNull();
    expect(parseMaxCacheSizeMB("   ")).toBeNull();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("parses a positive integer number of MB", () => {
    expect(parseMaxCacheSizeMB("51200")).toBe(51200);
    expect(parseMaxCacheSizeMB(" 409600 ")).toBe(409600);
    expect(parseMaxCacheSizeMB("1")).toBe(1);
  });

  it.each(["0", "-1", "1.5", "50GB", "1e5", "abc", "99999999999"])(
    "warns and ignores invalid value %s",
    (value) => {
      expect(parseMaxCacheSizeMB(value)).toBeNull();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Invalid max-cache-size-mb value"),
      );
    },
  );
});

describe("withMaxCacheSize", () => {
  it("returns the config unchanged when no limit is set", () => {
    expect(withMaxCacheSize(DEFAULT_BUILDKITD_CONFIG, null)).toBe(
      DEFAULT_BUILDKITD_CONFIG,
    );
  });

  it("appends a size-bounded policy after the age-based default", () => {
    const config = withMaxCacheSize(DEFAULT_BUILDKITD_CONFIG, 51200);

    expect(config.gc).toBe(true);
    expect(config.gcPolicy).toEqual([
      { keepDuration: "192h", all: true },
      { all: true, keepBytes: 51_200_000_000 },
    ]);
    // The shared default is not mutated.
    expect(DEFAULT_BUILDKITD_CONFIG.gcPolicy).toEqual([
      { keepDuration: "192h", all: true },
    ]);
  });

  it("keeps the backend keepDuration and gc flag", () => {
    const config = withMaxCacheSize(buildkitdConfigFromServer(72n), 1024);
    expect(config.gcPolicy).toEqual([
      { keepDuration: "72h", all: true },
      { all: true, keepBytes: 1_024_000_000 },
    ]);

    const gcOff = withMaxCacheSize({ gc: false, gcPolicy: [] }, 1024);
    expect(gcOff.gc).toBe(false);
    expect(gcOff.gcPolicy).toEqual([{ all: true, keepBytes: 1_024_000_000 }]);
  });
});
