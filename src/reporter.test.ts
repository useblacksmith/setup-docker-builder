import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import * as reporter from "./reporter";
import { UserInputError } from "./user-input-error";

vi.mock("@actions/core", () => ({
  debug: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(),
  },
}));

vi.mock("axios-retry", () => {
  const axiosRetry = vi.fn() as unknown as {
    (): void;
    exponentialDelay: unknown;
    isNetworkOrIdempotentRequestError: unknown;
  };
  axiosRetry.exponentialDelay = vi.fn();
  axiosRetry.isNetworkOrIdempotentRequestError = vi.fn();
  return { default: axiosRetry };
});

describe("reportBuildPushActionFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not report user input errors to the backend", async () => {
    await reporter.reportBuildPushActionFailure(
      "STICKYDISK_SETUP",
      new UserInputError("The 'cache-key' input is required"),
      "sticky disk setup",
    );

    expect(axios.create).not.toHaveBeenCalled();
  });

  it("reports other errors to the backend", async () => {
    const post = vi.fn().mockResolvedValue({ data: { status: "recorded" } });
    vi.mocked(axios.create).mockReturnValue({ post } as never);

    await reporter.reportBuildPushActionFailure(
      "STICKYDISK_SETUP",
      new Error("qemu-nbd timed out"),
      "sticky disk setup",
    );

    expect(post).toHaveBeenCalledWith(
      "/stickydisks/report-failed",
      expect.objectContaining({
        type: "STICKYDISK_SETUP",
        message: "sticky disk setup: qemu-nbd timed out",
      }),
    );
  });
});
