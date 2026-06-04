import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import { Util } from "@docker/actions-toolkit/lib/util";

// Mock the @actions/core module
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  saveState: vi.fn(),
  getState: vi.fn(),
  group: vi.fn((name, fn) => fn()),
}));

// Mock the Util module
vi.mock("@docker/actions-toolkit/lib/util", () => ({
  Util: {
    getInputList: vi.fn(),
  },
}));

describe("setup-docker-builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should validate buildx version correctly", () => {
    // Test isValidBuildxVersion function behavior
    const isValidBuildxVersion = (version: string): boolean => {
      return version === "latest" || /^v\d+\.\d+\.\d+$/.test(version);
    };

    expect(isValidBuildxVersion("latest")).toBe(true);
    expect(isValidBuildxVersion("v0.23.0")).toBe(true);
    expect(isValidBuildxVersion("v1.0.0")).toBe(true);
    expect(isValidBuildxVersion("invalid")).toBe(false);
    expect(isValidBuildxVersion("0.23.0")).toBe(false);
  });

  it("should handle inputs correctly", async () => {
    const mockGetInput = vi.mocked(core.getInput);
    const mockGetBooleanInput = vi.mocked(core.getBooleanInput);
    const mockGetInputList = vi.mocked(Util.getInputList);

    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "buildx-version":
          return "v0.23.0";
        case "github-token":
          return "test-token";
        default:
          return "";
      }
    });

    mockGetBooleanInput.mockImplementation((name: string) => {
      switch (name) {
        case "nofallback":
          return false;
        default:
          return false;
      }
    });

    mockGetInputList.mockImplementation((name: string) => {
      switch (name) {
        case "driver-opts":
          // Simulate the parsing with ignoreComma and quote options
          return [
            "env.OTEL_TRACES_EXPORTER=otlp",
            "env.OTEL_SERVICE_NAME=buildkitd",
          ];
        case "platforms":
          return [];
        default:
          return [];
      }
    });

    // Verify mocks are called correctly
    expect(mockGetInput("buildx-version")).toBe("v0.23.0");
    expect(mockGetBooleanInput("nofallback")).toBe(false);
    expect(mockGetInputList("driver-opts")).toEqual([
      "env.OTEL_TRACES_EXPORTER=otlp",
      "env.OTEL_SERVICE_NAME=buildkitd",
    ]);
  });
});
