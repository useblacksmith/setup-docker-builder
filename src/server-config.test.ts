import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  buildkitdConfigFromServer,
  DEFAULT_BUILDKITD_CONFIG,
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
