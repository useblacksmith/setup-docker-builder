import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import * as stateHelper from "./state-helper";
import { shutdownBuildkitd } from "./shutdown";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./state-helper", () => ({
  setSigkillUsed: vi.fn(),
}));

vi.mock("child_process", () => ({
  exec: vi.fn(),
}));

type ExecCb = (
  err: Error | null,
  result: { stdout: string; stderr: string },
) => void;

function execError(code: number): Error & { code: number } {
  return Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
  });
}

async function mockExec(handler: (cmd: string) => Error | string) {
  const exec = (await import("child_process")).exec as unknown as {
    mockImplementation: (fn: (cmd: string, cb: ExecCb) => void) => void;
  };
  exec.mockImplementation((cmd: string, cb: ExecCb) => {
    const result = handler(cmd);
    if (result instanceof Error) {
      cb(result, { stdout: "", stderr: "" });
    } else {
      cb(null, { stdout: result, stderr: "" });
    }
  });
}

describe("shutdownBuildkitd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true after a graceful shutdown", async () => {
    await mockExec((cmd) => {
      if (cmd.includes("pkill -TERM")) return "";
      if (cmd.includes("pgrep")) return execError(1);
      throw new Error(`unexpected command: ${cmd}`);
    });

    await expect(shutdownBuildkitd()).resolves.toBe(true);
    expect(stateHelper.setSigkillUsed).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      "buildkitd successfully shutdown gracefully",
    );
  });

  it("returns false without throwing when buildkitd is already gone", async () => {
    await mockExec((cmd) => {
      if (cmd.includes("pkill -TERM")) return execError(1);
      throw new Error(`unexpected command: ${cmd}`);
    });

    await expect(shutdownBuildkitd()).resolves.toBe(false);
    expect(stateHelper.setSigkillUsed).not.toHaveBeenCalled();
    expect(core.error).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      "buildkitd is not running; nothing to shut down",
    );
  });

  it("rethrows pkill failures other than no-match", async () => {
    await mockExec((cmd) => {
      if (cmd.includes("pkill -TERM")) return execError(2);
      throw new Error(`unexpected command: ${cmd}`);
    });

    await expect(shutdownBuildkitd()).rejects.toThrow();
    expect(core.error).toHaveBeenCalled();
  });
});
