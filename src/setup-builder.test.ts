import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as setupBuilder from "./setup_builder";
// import * as reporter from "./reporter";

// Mock the modules
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
}));

vi.mock("./reporter", () => ({
  createBlacksmithAgentClient: vi.fn(),
  reportBuildPushActionFailure: vi.fn(),
  reportMetric: vi.fn(),
  commitStickyDisk: vi.fn(),
  reportBuild: vi.fn(),
}));

vi.mock("child_process", () => ({
  exec: vi.fn((cmd, cb) => cb(null, { stdout: "", stderr: "" })),
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: { pipe: vi.fn() },
    stderr: { pipe: vi.fn() },
  })),
}));

vi.mock("fs", () => ({
  promises: {
    writeFile: vi.fn(),
  },
  createWriteStream: vi.fn(() => ({
    on: vi.fn(),
  })),
}));

describe("setup_builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default environment variables
    process.env.GITHUB_REPO_NAME = "test-repo";
    process.env.BLACKSMITH_REGION = "eu-central";
    process.env.BLACKSMITH_VM_ID = "test-vm-id";
  });

  describe("getNumCPUs", () => {
    it("should return the number of CPUs", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          cb(null, { stdout: "4\n", stderr: "" });
        },
      );

      const numCPUs = await setupBuilder.getNumCPUs();
      expect(numCPUs).toBe(4);
    });

    it("should return 1 if nproc fails", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          cb(new Error("Command failed"), null);
        },
      );

      const numCPUs = await setupBuilder.getNumCPUs();
      expect(numCPUs).toBe(1);
      expect(core.warning).toHaveBeenCalled();
    });
  });

  // Tailscale tests removed - not needed for setup-docker-builder

  describe("pruneBuildkitCache", () => {
    it("should prune buildkit cache successfully", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          if (cmd.includes("buildctl") && cmd.includes("prune")) {
            cb(null, { stdout: "Cache pruned", stderr: "" });
          }
        },
      );

      await setupBuilder.pruneBuildkitCache();
      expect(core.debug).toHaveBeenCalledWith(
        "Successfully pruned buildkit cache",
      );
    });

    it("should handle prune errors", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          cb(new Error("Prune failed"), null);
        },
      );

      await expect(setupBuilder.pruneBuildkitCache()).rejects.toThrow();
      expect(core.warning).toHaveBeenCalled();
    });
  });
});
