import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as stateHelper from "./state-helper";

const state = new Map<string, string>();

vi.mock("@actions/core", () => ({
  saveState: vi.fn((key: string, value: string) => state.set(key, value)),
  getState: vi.fn((key: string) => state.get(key) ?? ""),
}));

describe("max-cache-size-mb state", () => {
  beforeEach(() => {
    state.clear();
    vi.mocked(core.saveState).mockClear();
  });

  it("round-trips the limit to the post step", () => {
    stateHelper.setMaxCacheSizeMB(51200);
    expect(stateHelper.getMaxCacheSizeMB()).toBe(51200);
  });

  it("reads as null when unset, cleared or corrupted", () => {
    expect(stateHelper.getMaxCacheSizeMB()).toBeNull();

    stateHelper.setMaxCacheSizeMB(null);
    expect(core.saveState).toHaveBeenCalledWith("maxCacheSizeMB", "");
    expect(stateHelper.getMaxCacheSizeMB()).toBeNull();

    state.set("maxCacheSizeMB", "garbage");
    expect(stateHelper.getMaxCacheSizeMB()).toBeNull();
  });
});
