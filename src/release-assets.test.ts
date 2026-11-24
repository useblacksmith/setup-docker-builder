import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import axios from "axios";
import {
  PINNED_SHA256,
  downloadVerifiedAsset,
  normalizeSha256,
  resolveExpectedSha256,
} from "./release-assets";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

const HELLO_SHA256 =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const asset = { repo: "docker/buildx", tag: "v9.9.9", name: "buildx-test" };

describe("release-assets", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "assets-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("normalizes digests and rejects malformed ones", () => {
    expect(normalizeSha256(`sha256:${HELLO_SHA256.toUpperCase()}`)).toBe(
      HELLO_SHA256,
    );
    expect(() => normalizeSha256("abc")).toThrow("Invalid SHA-256");
  });

  it("prefers the input, then the pinned table, then the release digest", async () => {
    const pinnedName = Object.keys(PINNED_SHA256)[0];
    await expect(
      resolveExpectedSha256({ ...asset, name: pinnedName }, HELLO_SHA256),
    ).resolves.toEqual({ sha256: HELLO_SHA256, source: "input" });
    await expect(
      resolveExpectedSha256({ ...asset, name: pinnedName }, ""),
    ).resolves.toEqual({ sha256: PINNED_SHA256[pinnedName], source: "pinned" });

    vi.mocked(axios.get).mockResolvedValueOnce({
      data: {
        assets: [{ name: asset.name, digest: `sha256:${HELLO_SHA256}` }],
      },
    });
    await expect(resolveExpectedSha256(asset, "")).resolves.toEqual({
      sha256: HELLO_SHA256,
      source: "release digest",
    });
  });

  it("refuses to install when no digest is known", async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { assets: [] } });
    await expect(resolveExpectedSha256(asset, "")).rejects.toThrow(
      "No SHA-256 is known",
    );
  });

  it("deletes the download and throws on a checksum mismatch", async () => {
    const dest = path.join(dir, "bin");
    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Readable.from([Buffer.from("tampered")]),
    });
    await expect(
      downloadVerifiedAsset(asset, dest, HELLO_SHA256),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(fs.existsSync(dest)).toBe(false);

    vi.mocked(axios.get).mockResolvedValueOnce({
      data: Readable.from([Buffer.from("hello")]),
    });
    await downloadVerifiedAsset(asset, dest, HELLO_SHA256);
    expect(fs.readFileSync(dest, "utf8")).toBe("hello");
  });
});
