import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { downloadVerifiedAsset, linuxArch } from "./release-assets";

const execAsync = promisify(exec);

/**
 * Downloads and installs a specific version of BuildKit
 * @param version The BuildKit version to install (e.g., "v0.35.1")
 * @param sha256 Expected SHA-256 of the release archive; empty to use the
 *   pinned or published digest
 * @param githubToken Optional token for reading the published digest
 * @returns The path to the installed buildkitd binary
 */
export async function installBuildKit(
  version: string,
  sha256 = "",
  githubToken?: string,
): Promise<string> {
  try {
    core.info(`Installing BuildKit ${version}`);
    const arch = linuxArch();

    // Create temp directory
    const tmpDir = `/tmp/buildkit-${Date.now()}`;
    await fs.promises.mkdir(tmpDir, { recursive: true });

    try {
      const archivePath = path.join(tmpDir, "buildkit.tar.gz");
      await downloadVerifiedAsset(
        {
          repo: "moby/buildkit",
          tag: version,
          name: `buildkit-${version}.linux-${arch}.tar.gz`,
        },
        archivePath,
        sha256,
        githubToken,
      );

      core.info("Download complete, extracting...");

      // Extract the archive
      const extractDir = path.join(tmpDir, "extract");
      await fs.promises.mkdir(extractDir, { recursive: true });

      // Use tar command to extract
      await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

      // Install binaries to /usr/local/bin
      const binDir = path.join(extractDir, "bin");
      const targetDir = "/usr/local/bin";

      // List all files in the bin directory
      const files = await fs.promises.readdir(binDir);

      for (const file of files) {
        const sourcePath = path.join(binDir, file);
        const targetPath = path.join(targetDir, file);

        // Copy file with sudo
        await execAsync(`sudo cp "${sourcePath}" "${targetPath}"`);
        await execAsync(`sudo chmod +x "${targetPath}"`);

        core.info(`Installed ${file} to ${targetPath}`);
      }

      // Verify buildkitd is installed
      const { stdout: versionOutput } = await execAsync(
        `${targetDir}/buildkitd --version`,
      );
      core.info(`BuildKit installed successfully: ${versionOutput.trim()}`);

      return path.join(targetDir, "buildkitd");
    } finally {
      // Clean up temp directory
      await execAsync(`rm -rf "${tmpDir}"`);
    }
  } catch (error) {
    core.error(`Failed to install BuildKit: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * Checks if a specific BuildKit version is already installed
 * @param version The BuildKit version to check
 * @returns True if the version is installed, false otherwise
 */
export async function isBuildKitVersionInstalled(
  version: string,
): Promise<boolean> {
  try {
    const { stdout } = await execAsync("buildkitd --version");
    // Parse version from output like "buildkitd github.com/moby/buildkit v0.16.0 ..."
    const match = stdout.match(/v\d+\.\d+\.\d+/);
    if (match && match[0] === version) {
      core.info(`BuildKit ${version} is already installed`);
      return true;
    }
    return false;
  } catch {
    // buildkitd not found or error running it
    return false;
  }
}
