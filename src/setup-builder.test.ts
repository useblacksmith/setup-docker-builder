import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as fs from "fs";
import * as setupBuilder from "./setup_builder";
import { UserInputError } from "./user-input-error";
// import * as reporter from "./reporter";

// Mock the modules
vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(() => ""),
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

  describe("getStickyDisk", () => {
    it("throws UserInputError without contacting the agent when cache-key is missing", async () => {
      vi.mocked(core.getInput).mockReturnValue("");
      const reporter = await import("./reporter");

      await expect(setupBuilder.getStickyDisk()).rejects.toThrow(
        UserInputError,
      );
      expect(reporter.createBlacksmithAgentClient).not.toHaveBeenCalled();
    });
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

  describe("writeDockerContainerBuildkitdTomlFile", () => {
    it("writes a docker-container BuildKit config with the Docker mirror", async () => {
      const writeFile = vi.mocked(fs.promises.writeFile);

      await setupBuilder.writeDockerContainerBuildkitdTomlFile(
        "local-buildkitd.toml",
      );

      expect(writeFile.mock.calls[0][0]).toBe("local-buildkitd.toml");
      const config = writeFile.mock.calls[0][1] as string;
      expect(config).toContain('mirrors = [ "http://192.168.127.1:5000" ]');
      expect(config).toContain('[registry."docker.io"]');
      expect(config).toContain('[registry."192.168.127.1:5000"]');
      expect(config).not.toContain("[grpc]");
      expect(core.info).toHaveBeenCalledWith(
        "Wrote Docker container BuildKit config to local-buildkitd.toml",
      );
    });
  });

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

      await setupBuilder.pruneBuildkitCache(1000);
      expect(capturedCmd).toContain("--keep-storage 1000");
    });

    it("should default to 20480 MB when no value provided", async () => {
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

      await setupBuilder.pruneBuildkitCache();
      expect(capturedCmd).toContain("--keep-storage 20480");
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
