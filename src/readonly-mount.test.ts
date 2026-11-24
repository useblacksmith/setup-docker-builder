import { describe, it, expect, vi, beforeEach } from "vitest";
import { exec } from "child_process";
import {
  attachCopyOnWrite,
  parseCacheMode,
  snapshotTable,
} from "./readonly-mount";

vi.mock("@actions/core", () => ({ info: vi.fn(), warning: vi.fn() }));

vi.mock("child_process", () => ({ exec: vi.fn() }));

type ExecCallback = (
  error: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

function mockExec(handler: (cmd: string) => string | Error): string[] {
  const commands: string[] = [];
  vi.mocked(exec).mockImplementation(((cmd: string, cb: ExecCallback) => {
    commands.push(cmd);
    const out = handler(cmd);
    if (out instanceof Error) cb(out);
    else cb(null, { stdout: out, stderr: "" });
  }) as unknown as typeof exec);
  return commands;
}

describe("readonly-mount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_TEMP = "/runner/tmp";
  });

  it("parses cache-mode", () => {
    expect(parseCacheMode("")).toBe("read-write");
    expect(parseCacheMode("read-write")).toBe("read-write");
    expect(parseCacheMode("read-only")).toBe("read-only");
    expect(() => parseCacheMode("ro")).toThrow("Invalid cache-mode");
  });

  it("builds a non-persistent snapshot table over the sticky disk", () => {
    expect(snapshotTable("/dev/vdb", "/dev/loop3", 2048)).toBe(
      "0 2048 snapshot /dev/vdb /dev/loop3 N 8",
    );
  });

  it("puts the snapshot in front of the sticky disk and never writes to it", async () => {
    const commands = mockExec((cmd) => {
      if (cmd.includes("--getsz")) return "2048\n";
      if (cmd.includes("losetup --find")) return "/dev/loop3\n";
      return "";
    });

    const overlay = await attachCopyOnWrite("/dev/vdb");

    expect(overlay.device).toBe("/dev/mapper/buildkit-cache-ro");
    expect(overlay.loopDevice).toBe("/dev/loop3");
    expect(overlay.cowFile.startsWith("/runner/tmp/")).toBe(true);
    expect(commands).toContain(
      'sudo dmsetup create buildkit-cache-ro --table "0 2048 snapshot /dev/vdb /dev/loop3 N 8"',
    );
    expect(commands).toContain("sudo blockdev --setro /dev/vdb");
    expect(commands.some((c) => /mkfs|resize2fs|mount /.test(c))).toBe(false);
  });

  it("cleans up and explains the requirement when dm-snapshot is missing", async () => {
    const commands = mockExec((cmd) => {
      if (cmd.includes("--getsz")) return "2048\n";
      if (cmd.includes("losetup --find")) return "/dev/loop3\n";
      if (cmd.includes("dmsetup create")) {
        return new Error("reload ioctl failed: Invalid argument");
      }
      return "";
    });

    await expect(attachCopyOnWrite("/dev/vdb")).rejects.toThrow(
      "dm-snapshot kernel module",
    );
    expect(commands).toContain("sudo losetup -d /dev/loop3");
    expect(commands.some((c) => c.startsWith("rm -f"))).toBe(true);
    expect(commands.some((c) => c.includes("--setro"))).toBe(false);
  });
});
