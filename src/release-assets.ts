import * as core from "@actions/core";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import axios from "axios";

// SHA-256 of the release assets for the default and recommended versions,
// taken from each release's published asset digests. Add the new entries in
// the same change that bumps a default.
export const PINNED_SHA256: Readonly<Record<string, string>> = {
  "buildkit-v0.35.1.linux-amd64.tar.gz":
    "b248c2b91698aafef11818fe8b681dc5e341581f7d5676709ff45ca1f29b0408",
  "buildkit-v0.35.1.linux-arm64.tar.gz":
    "46c7d1799250bd8b31266ed718715ab9d3464bad0455d5bfbe48e2eeb92ca965",
  "buildx-v0.39.1.linux-amd64":
    "903090816da68f8bc1a2ff5346dd163a5adacfce4548d003c75df42cd47a9bf4",
  "buildx-v0.39.1.linux-arm64":
    "05c88e0f9152825e609a1cdb391faf14d5f94d23d071eaecb87bae69d98da8b8",
};

export function linuxArch(): "amd64" | "arm64" {
  switch (os.arch()) {
    case "x64":
      return "amd64";
    case "arm64":
      return "arm64";
    default:
      throw new Error(`Unsupported runner architecture: ${os.arch()}`);
  }
}

/** Accepts `<hex>` or `sha256:<hex>`; returns lowercase hex or throws. */
export function normalizeSha256(value: string): string {
  const hex = value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error(`Invalid SHA-256 digest: '${value}'`);
  }
  return hex;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Resolves `latest` to the newest published release tag of `repo`. */
export async function resolveReleaseTag(
  repo: string,
  version: string,
  token?: string,
): Promise<string> {
  if (version !== "latest") {
    return version;
  }
  const { data } = await axios.get<{ tag_name: string }>(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers: githubApiHeaders(token), timeout: 30000 },
  );
  return data.tag_name;
}

async function releaseAssetDigest(
  repo: string,
  tag: string,
  assetName: string,
  token?: string,
): Promise<string | undefined> {
  const { data } = await axios.get<{
    assets?: Array<{ name: string; digest?: string | null }>;
  }>(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: githubApiHeaders(token),
    timeout: 30000,
  });
  return data.assets?.find((a) => a.name === assetName)?.digest ?? undefined;
}

export interface ReleaseAsset {
  repo: string;
  tag: string;
  name: string;
}

/**
 * Expected SHA-256 for a release asset, in order of precedence: the caller's
 * input, the pinned table, then the digest GitHub publishes for the asset.
 * Throws when none is available so an unverified binary is never installed.
 */
export async function resolveExpectedSha256(
  asset: ReleaseAsset,
  override: string,
  token?: string,
): Promise<{ sha256: string; source: string }> {
  if (override.trim() !== "") {
    return { sha256: normalizeSha256(override), source: "input" };
  }
  const pinned = PINNED_SHA256[asset.name];
  if (pinned) {
    return { sha256: pinned, source: "pinned" };
  }
  let digest: string | undefined;
  try {
    digest = await releaseAssetDigest(asset.repo, asset.tag, asset.name, token);
  } catch (error) {
    core.warning(
      `Could not read the published digest of ${asset.name}: ${(error as Error).message}`,
    );
  }
  if (digest) {
    return { sha256: normalizeSha256(digest), source: "release digest" };
  }
  throw new Error(
    `No SHA-256 is known for ${asset.name}; pass it through the action's sha256 input to install this version`,
  );
}

/** Downloads a release asset to `dest` and fails unless its SHA-256 matches. */
export async function downloadVerifiedAsset(
  asset: ReleaseAsset,
  dest: string,
  override: string,
  token?: string,
): Promise<void> {
  const expected = await resolveExpectedSha256(asset, override, token);
  const url = `https://github.com/${asset.repo}/releases/download/${asset.tag}/${asset.name}`;
  core.info(`Downloading ${url}`);

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 60000,
  });
  const writer = fs.createWriteStream(dest);
  response.data.pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", () => resolve());
    writer.on("error", reject);
    response.data.on("error", reject);
  });

  const actual = await sha256File(dest);
  if (actual !== expected.sha256) {
    await fs.promises.rm(dest, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${asset.name}: expected ${expected.sha256} (${expected.source}), got ${actual}`,
    );
  }
  core.info(`Verified SHA-256 of ${asset.name} (${expected.source})`);
}
