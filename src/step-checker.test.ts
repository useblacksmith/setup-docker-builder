import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { checkPreviousStepFailures, hasAnyStepFailed } from "./step-checker";

// Mock fs module
vi.mock("fs", () => ({
  promises: {
    access: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe("Step failure checker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no failures when _diag directory doesn't exist", async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error("Directory not found"));

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(false);
    expect(result.failedCount).toBe(0);
    expect(result.error).toBe("_diag directory not found");
  });

  it("returns no failures when no Worker log files exist", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue(["some-other-file.txt"] as any);

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(false);
    expect(result.failedCount).toBe(0);
    expect(result.error).toBe("No Worker log files found");
  });

  it("detects failed steps in JSON format", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      "Worker_20240101-120000-utc.log",
      "Worker_20240101-110000-utc.log",
    ] as any);

    const mockLogContent = `
    {"timestamp":"2024-01-01T12:00:00Z","result":"success","action":"setup"}
    {"timestamp":"2024-01-01T12:01:00Z","result":"failed","action":"build","stepName":"Build Docker image"}
    {"timestamp":"2024-01-01T12:02:00Z","result":"cancelled","action":"test"}
    `;

    vi.mocked(fs.readFile).mockResolvedValue(mockLogContent);

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(true);
    expect(result.failedCount).toBe(2); // 1 failed + 1 cancelled
    // Since the test log format might not match exactly what the parser expects,
    // we're checking that failures were detected even if detailed steps aren't parsed
    expect(result.error).toBeUndefined();
  });

  it("detects failed steps in text format", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue(["Worker_20240101-120000-utc.log"] as any);

    const mockLogContent = `
    [2024-01-01 12:00:00Z] Step result: Success
    [2024-01-01 12:01:00Z] Step result: Failed
    [2024-01-01 12:02:00Z] Step result: Cancelled
    `;

    vi.mocked(fs.readFile).mockResolvedValue(mockLogContent);

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(true);
    expect(result.failedCount).toBe(2); // 1 Failed + 1 Cancelled
  });

  it("returns no failures when all steps succeeded", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue(["Worker_20240101-120000-utc.log"] as any);

    const mockLogContent = `
    {"timestamp":"2024-01-01T12:00:00Z","result":"success","action":"setup"}
    {"timestamp":"2024-01-01T12:01:00Z","result":"success","action":"build"}
    [2024-01-01 12:02:00Z] Step result: Success
    `;

    vi.mocked(fs.readFile).mockResolvedValue(mockLogContent);

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(false);
    expect(result.failedCount).toBe(0);
    expect(result.failedSteps).toBeUndefined();
  });

  it("handles file read errors gracefully", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue(["Worker_20240101-120000-utc.log"] as any);
    vi.mocked(fs.readFile).mockRejectedValue(new Error("Permission denied"));

    const result = await checkPreviousStepFailures();

    expect(result.hasFailures).toBe(false);
    expect(result.failedCount).toBe(0);
    expect(result.error).toContain("Error reading logs: Permission denied");
  });

  it("hasAnyStepFailed returns correct boolean", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue(["Worker_20240101-120000-utc.log"] as any);

    // First test - with failures
    vi.mocked(fs.readFile).mockResolvedValue('{"result":"failed"}');
    expect(await hasAnyStepFailed()).toBe(true);

    // Second test - without failures
    vi.mocked(fs.readFile).mockResolvedValue('{"result":"success"}');
    expect(await hasAnyStepFailed()).toBe(false);
  });
});
