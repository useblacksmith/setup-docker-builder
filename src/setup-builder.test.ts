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
  getAgentAddr: vi.fn(() => process.env.BLACKSMITH_AGENT_ADDR || undefined),
  isAgentUnsupportedError: vi.fn(() => false),
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
    process.env.BLACKSMITH_AGENT_ADDR = "192.168.127.1";
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

    async function getStickyDiskWithAgentResponse(response: object) {
      vi.mocked(core.getInput).mockReturnValue("my-repo/my-image");
      const reporter = await import("./reporter");
      vi.mocked(reporter.createBlacksmithAgentClient).mockReturnValue({
        up: vi.fn().mockResolvedValue({}),
        getStickyDisk: vi.fn().mockResolvedValue(response),
      } as unknown as ReturnType<typeof reporter.createBlacksmithAgentClient>);

      return setupBuilder.getStickyDisk();
    }

    it("applies the backend GC keepDuration from the agent response", async () => {
      const result = await getStickyDiskWithAgentResponse({
        exposeId: "expose-1",
        diskIdentifier: "/dev/vdb",
        parentSnapshotName: "snap-1",
        cloneName: "clone-1",
        buildkitdConfig: { gcKeepDurationHours: 72n },
      });

      expect(result.device).toBe("/dev/vdb");
      expect(result.buildkitd_config.gcPolicy).toEqual([
        { keepDuration: "72h", all: true },
      ]);
    });

    it("keeps the default GC policy when an older agent omits buildkitdConfig", async () => {
      const result = await getStickyDiskWithAgentResponse({
        exposeId: "expose-1",
        diskIdentifier: "/dev/vdb",
        parentSnapshotName: "snap-1",
        cloneName: "clone-1",
      });

      expect(result.buildkitd_config.gcPolicy).toEqual([
        { keepDuration: "192h", all: true },
      ]);
      expect(core.warning).not.toHaveBeenCalled();
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
      process.env.BLACKSMITH_AGENT_ADDR = "192.168.127.1";
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

    it("omits the Docker mirror when BLACKSMITH_AGENT_ADDR is not set", async () => {
      delete process.env.BLACKSMITH_AGENT_ADDR;
      const writeFile = vi.mocked(fs.promises.writeFile);

      await setupBuilder.writeDockerContainerBuildkitdTomlFile(
        "local-buildkitd.toml",
      );

      const config = writeFile.mock.calls[0][1] as string;
      expect(config).not.toContain("mirrors");
      expect(config).not.toContain("192.168.127.1:5000");
    });
  });

  describe("writeBuildkitdTomlFile", () => {
    it("disables in-use pruning and enables GC in the oci worker config", async () => {
      const writeFile = vi.mocked(fs.promises.writeFile);

      await setupBuilder.writeBuildkitdTomlFile(4, "tcp://127.0.0.1:1234", [
        "10.0.0.1",
      ]);

      expect(writeFile.mock.calls[0][0]).toBe("buildkitd.toml");
      const config = writeFile.mock.calls[0][1] as string;
      expect(config).toContain("[worker.oci]");
      expect(config).toContain("pruneInUse = false");
      expect(config).toContain("gc = true");
      expect(config).toContain('keepDuration = "192h"');
      expect(config).toContain("max-parallelism = 4");
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
});
