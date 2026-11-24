import * as core from "@actions/core";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const SNAPSHOT_NAME = "buildkit-cache-ro";
// 4 KiB copy-on-write chunks, matching the ext4 block size.
const CHUNK_SECTORS = 8;

export type CacheMode = "read-write" | "read-only";

export function parseCacheMode(value: string): CacheMode {
  if (value === "read-only") return "read-only";
  if (value === "" || value === "read-write") return "read-write";
  throw new Error(
    `Invalid cache-mode '${value}'. Expected 'read-write' or 'read-only'.`,
  );
}

export interface CopyOnWriteOverlay {
  origin: string;
  device: string;
  loopDevice: string;
  cowFile: string;
}

/**
 * Device-mapper table for a non-persistent snapshot of `origin` whose
 * changed chunks are stored on `cowDevice`.
 */
export function snapshotTable(
  origin: string,
  cowDevice: string,
  sectors: number,
): string {
  return `0 ${sectors} snapshot ${origin} ${cowDevice} N ${CHUNK_SECTORS}`;
}

/**
 * Puts a copy-on-write snapshot in front of the sticky disk so buildkitd can
 * read and write its state while the sticky disk itself is never written.
 * Every write lands in a sparse file on the runner's local disk and is
 * dropped when the snapshot is removed.
 */
export async function attachCopyOnWrite(
  origin: string,
): Promise<CopyOnWriteOverlay> {
  const tmpDir = process.env.RUNNER_TEMP || "/tmp";
  const cowFile = path.join(tmpDir, `${SNAPSHOT_NAME}-${Date.now()}.cow`);
  let loopDevice = "";
  try {
    await execAsync("sudo modprobe dm-snapshot").catch(() => {
      // Built into the kernel or already loaded; dmsetup reports the real error.
    });
    const { stdout: sizeOut } = await execAsync(
      `sudo blockdev --getsz ${origin}`,
    );
    const sectors = parseInt(sizeOut.trim(), 10);
    if (isNaN(sectors) || sectors <= 0) {
      throw new Error(`Invalid size for ${origin}: '${sizeOut.trim()}'`);
    }

    // Sparse, so it only takes local disk space for chunks actually written.
    await execAsync(`truncate -s ${sectors * 512} "${cowFile}"`);
    loopDevice = (
      await execAsync(`sudo losetup --find --show "${cowFile}"`)
    ).stdout.trim();
    await execAsync(
      `sudo dmsetup create ${SNAPSHOT_NAME} --table "${snapshotTable(origin, loopDevice, sectors)}"`,
    );
    // Refuse any other writer that opens the sticky disk directly.
    await execAsync(`sudo blockdev --setro ${origin}`).catch((error) => {
      core.warning(
        `Could not mark ${origin} read-only: ${(error as Error).message}`,
      );
    });

    const device = `/dev/mapper/${SNAPSHOT_NAME}`;
    core.info(
      `Sticky disk ${origin} is attached read-only; writes go to ${device} backed by ${cowFile}`,
    );
    return { origin, device, loopDevice, cowFile };
  } catch (error) {
    if (loopDevice) {
      await execAsync(`sudo losetup -d ${loopDevice}`).catch(() => {});
    }
    await execAsync(`rm -f "${cowFile}"`).catch(() => {});
    throw new Error(
      `Could not attach the sticky disk read-only (needs dmsetup, losetup and the dm-snapshot kernel module): ${(error as Error).message}`,
    );
  }
}

/** Removes the snapshot and its local copy-on-write file. Call after unmount. */
export async function detachCopyOnWrite(
  overlay: CopyOnWriteOverlay,
): Promise<void> {
  await execAsync(`sudo dmsetup remove ${SNAPSHOT_NAME}`);
  await execAsync(`sudo losetup -d ${overlay.loopDevice}`);
  await execAsync(`rm -f "${overlay.cowFile}"`);
  core.info(`Detached the read-only overlay of ${overlay.origin}`);
}
