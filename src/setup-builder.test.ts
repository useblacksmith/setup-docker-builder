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

  describe("logBuildCacheContents", () => {
    it("should log build cache contents from buildctl du", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          if (cmd.includes("buildctl") && cmd.includes("du")) {
            cb(null, {
              stdout:
                "ID\tRECLAIMABLE\tSIZE\nabc123\ttrue\t50MB\nTotal:\t\t50MB\n",
              stderr: "",
            });
          }
        },
      );

      await setupBuilder.logBuildCacheContents();
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Build cache contents:"),
      );
    });

    it("should log empty cache when no output", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          cb(null, { stdout: "", stderr: "" });
        },
      );

      await setupBuilder.logBuildCacheContents();
      expect(core.info).toHaveBeenCalledWith("Build cache is empty");
    });

    it("should warn on error without throwing", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          cb(new Error("du failed"), null);
        },
      );

      await setupBuilder.logBuildCacheContents();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Error listing build cache contents"),
      );
    });
  });

  describe("pruneBuildkitCache", () => {
    it("should prune buildkit cache successfully and log reclaimed entries", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          if (cmd.includes("buildctl") && cmd.includes("prune")) {
            cb(null, {
              stdout:
                "ID\tRECLAIMABLE\tSIZE\nabc123\ttrue\t50MB\nTotal:\t\t50MB\n",
              stderr: "",
            });
          }
        },
      );

      await setupBuilder.pruneBuildkitCache();
      expect(core.info).toHaveBeenCalledWith(
        "Build cache pruned: Total:\t\t50MB",
      );
    });

    it("should use custom keep duration when provided", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      let capturedCmd = "";
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          capturedCmd = cmd;
          cb(null, { stdout: "", stderr: "" });
        },
      );

      await setupBuilder.pruneBuildkitCache("72h");
      expect(capturedCmd).toContain("--keep-duration 72h");
    });

    it("should include --keep-storage when provided", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      let capturedCmd = "";
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          capturedCmd = cmd;
          cb(null, { stdout: "", stderr: "" });
        },
      );

      await setupBuilder.pruneBuildkitCache("168h", 1000);
      expect(capturedCmd).toContain("--keep-storage 1000");
      expect(capturedCmd).toContain("--keep-duration 168h");
    });

    it("should not include --keep-storage when null", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      let capturedCmd = "";
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          capturedCmd = cmd;
          cb(null, { stdout: "", stderr: "" });
        },
      );

      await setupBuilder.pruneBuildkitCache("168h", null);
      expect(capturedCmd).not.toContain("--keep-storage");
    });

    it("should not include --keep-duration when null", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      let capturedCmd = "";
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          capturedCmd = cmd;
          cb(null, { stdout: "", stderr: "" });
        },
      );

      await setupBuilder.pruneBuildkitCache(null, 5000);
      expect(capturedCmd).not.toContain("--keep-duration");
      expect(capturedCmd).toContain("--keep-storage 5000");
    });

    it("should log no data reclaimed when prune output is empty", async () => {
      const exec = (await import("child_process")).exec as unknown as {
        mockImplementation: (
          fn: (cmd: string, cb: (...args: unknown[]) => void) => void,
        ) => void;
      };
      exec.mockImplementation(
        (cmd: string, cb: (...args: unknown[]) => void) => {
          if (cmd.includes("buildctl") && cmd.includes("prune")) {
            cb(null, { stdout: "", stderr: "" });
          }
        },
      );

      await setupBuilder.pruneBuildkitCache();
      expect(core.info).toHaveBeenCalledWith(
        "Build cache pruned: no data reclaimed",
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
