import { describe, it, expect, vi, beforeEach } from "vitest";
import * as core from "@actions/core";
import { startBuildkitd } from "./setup_builder";
import { execa } from "execa";

vi.mock("@actions/core");
vi.mock("execa");
vi.mock("fs", () => ({
  promises: {
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
  createWriteStream: vi.fn().mockReturnValue({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  }),
}));
vi.mock("child_process", () => ({
  exec: vi.fn((cmd, callback) => {
    // Mock pgrep to return a buildkitd PID
    if (cmd.includes("pgrep buildkitd")) {
      callback(null, { stdout: "12345\n", stderr: "" });
    } else {
      callback(null, { stdout: "", stderr: "" });
    }
  }),
}));

describe("driver-opts parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should parse and set environment variables from driver-opts", async () => {
    const mockExeca = vi.mocked(execa);
    mockExeca.mockReturnValue({
      on: vi.fn(),
      stdout: {
        pipe: vi.fn(),
      },
      stderr: {
        pipe: vi.fn(),
      },
    } as unknown as ReturnType<typeof execa>);

    const driverOpts = [
      "env.OTEL_TRACES_EXPORTER=otlp",
      "env.OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
      "env.OTEL_EXPORTER_OTLP_ENDPOINT=https://example.com",
      "env.OTEL_SERVICE_NAME=buildkitd",
    ];

    await startBuildkitd(4, "tcp://127.0.0.1:1234", undefined, driverOpts);

    // Verify that execa was called with the correct command
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const commandCall = mockExeca.mock.calls[0][0] as string;

    // Check that environment variables are included in the command with sudo env
    expect(commandCall).toContain("sudo env");
    expect(commandCall).toContain("OTEL_TRACES_EXPORTER='otlp'");
    expect(commandCall).toContain(
      "OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'",
    );
    expect(commandCall).toContain(
      "OTEL_EXPORTER_OTLP_ENDPOINT='https://example.com'",
    );
    expect(commandCall).toContain("OTEL_SERVICE_NAME='buildkitd'");
  });

  it("should warn about invalid driver-opt format", async () => {
    const mockCoreWarning = vi.mocked(core.warning);
    const mockExeca = vi.mocked(execa);
    mockExeca.mockReturnValue({
      on: vi.fn(),
      stdout: {
        pipe: vi.fn(),
      },
      stderr: {
        pipe: vi.fn(),
      },
    } as unknown as ReturnType<typeof execa>);

    const driverOpts = [
      "env.VALID_VAR=value",
      "env.INVALID_VAR", // Missing value
      "unsupported.option=value", // Unsupported prefix
    ];

    await startBuildkitd(4, "tcp://127.0.0.1:1234", undefined, driverOpts);

    // Check warnings were logged
    expect(mockCoreWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid driver-opt format (missing value): env.INVALID_VAR",
      ),
    );
    expect(mockCoreWarning).toHaveBeenCalledWith(
      expect.stringContaining(
        "Unsupported driver-opt (only env.* options are currently supported): unsupported.option=value",
      ),
    );
  });

  it("should handle empty driver-opts array", async () => {
    const mockExeca = vi.mocked(execa);
    mockExeca.mockReturnValue({
      on: vi.fn(),
      stdout: {
        pipe: vi.fn(),
      },
      stderr: {
        pipe: vi.fn(),
      },
    } as unknown as ReturnType<typeof execa>);

    await startBuildkitd(4, "tcp://127.0.0.1:1234", undefined, []);

    // Verify that execa was called with only the default environment variables
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const commandCall = mockExeca.mock.calls[0][0] as string;

    expect(commandCall).not.toContain("OTEL_");
    expect(commandCall).toContain(
      "BUILDKIT_SESSION_HEALTHCHECK_MAX_FAILURES='10'",
    );
    expect(commandCall).toContain("nohup sudo");
  });

  it("should handle undefined driver-opts", async () => {
    const mockExeca = vi.mocked(execa);
    mockExeca.mockReturnValue({
      on: vi.fn(),
      stdout: {
        pipe: vi.fn(),
      },
      stderr: {
        pipe: vi.fn(),
      },
    } as unknown as ReturnType<typeof execa>);

    await startBuildkitd(4, "tcp://127.0.0.1:1234", undefined, undefined);

    // Verify that execa was called with only the default environment variables
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const commandCall = mockExeca.mock.calls[0][0] as string;

    expect(commandCall).not.toContain("OTEL_");
    expect(commandCall).toContain(
      "BUILDKIT_SESSION_HEALTHCHECK_MAX_FAILURES='10'",
    );
    expect(commandCall).toContain("nohup sudo");
  });

  it("should handle driver-opts with special characters in values", async () => {
    const mockExeca = vi.mocked(execa);
    mockExeca.mockReturnValue({
      on: vi.fn(),
      stdout: {
        pipe: vi.fn(),
      },
      stderr: {
        pipe: vi.fn(),
      },
    } as unknown as ReturnType<typeof execa>);

    const driverOpts = [
      "env.SPECIAL_CHARS=value with spaces",
      "env.QUOTES=value'with'quotes",
      "env.EQUALS=key=value",
    ];

    await startBuildkitd(4, "tcp://127.0.0.1:1234", undefined, driverOpts);

    // Verify that execa was called with properly escaped values
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const commandCall = mockExeca.mock.calls[0][0] as string;

    // Check that values are properly quoted
    expect(commandCall).toContain("SPECIAL_CHARS='value with spaces'");
    expect(commandCall).toContain("QUOTES='value'with'quotes'");
    expect(commandCall).toContain("EQUALS='key=value'");
  });
});
