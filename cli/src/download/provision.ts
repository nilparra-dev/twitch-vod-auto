/**
 * Opt-in ffmpeg provisioning. Users who do not want to install ffmpeg can let
 * the CLI download a pinned LGPL static build, verify its SHA-256 and keep it
 * in the user cache. The CLI never provisions on its own: the download command
 * requires `--install-ffmpeg`.
 *
 * The release matrix below is the only place that needs an update to add or
 * bump a platform. Checksums come from the release's own `checksums.sha256`
 * and were verified against the downloaded archive before being pinned here.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { FfmpegError, findFfmpeg, type FfmpegTools } from "./ffmpeg.js";

/** The win64 LGPL zip is ~163 MB; anything much larger is not our release. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

const BTBN_TAG = "autobuild-2026-09-11-13-20";
const BTBN_VERSION = "n9.0.1-29-gad500d59cb";

export interface FfmpegRelease {
  /** Cache folder name; stable for a pinned release and platform. */
  id: string;
  url: string;
  sha256: string;
  archive: "zip" | "tar.xz";
}

function btbnRelease(platform: string, arch: string, asset: string, sha256: string, archive: "zip" | "tar.xz"): FfmpegRelease {
  return {
    id: `${BTBN_VERSION}-${platform}-${arch}`,
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}/${asset}`,
    sha256,
    archive,
  };
}

/**
 * Pinned LGPL static builds from BtbN. macOS is not covered yet; install
 * ffmpeg with Homebrew there.
 */
const RELEASES: Readonly<Record<string, FfmpegRelease>> = {
  "win32-x64": btbnRelease(
    "win32",
    "x64",
    "ffmpeg-n9.0.1-29-gad500d59cb-win64-lgpl-9.0.zip",
    "2ed9c183065b944197d771eb6486fe7e4627b28059a9b32e852f3a69495fc9b5",
    "zip",
  ),
  "win32-arm64": btbnRelease(
    "win32",
    "arm64",
    "ffmpeg-n9.0.1-29-gad500d59cb-winarm64-lgpl-9.0.zip",
    "c2b72737f40e0f6206f61c885e011753c5b6307e9d63a2db59a3e949fe24b345",
    "zip",
  ),
  "linux-x64": btbnRelease(
    "linux",
    "x64",
    "ffmpeg-n9.0.1-29-gad500d59cb-linux64-lgpl-9.0.tar.xz",
    "b8f6a666dac99d2ce2010e35f192ab9696bca4c258b13e33fedf1383defff1ea",
    "tar.xz",
  ),
  "linux-arm64": btbnRelease(
    "linux",
    "arm64",
    "ffmpeg-n9.0.1-29-gad500d59cb-linuxarm64-lgpl-9.0.tar.xz",
    "ee6b813257af01e125c23740d282fdbc9d656874103ce898f708bdc753b95936",
    "tar.xz",
  ),
};

export function releaseFor(platform: string, arch: string): FfmpegRelease | undefined {
  return RELEASES[`${platform}-${arch}`];
}

export function defaultCacheDir(): string {
  return join(homedir(), ".cache", "twitch-vod-m3u8", "ffmpeg");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

async function downloadArchive(options: {
  url: string;
  destination: string;
  fetch: typeof fetch;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: DownloadProgress) => void) | undefined;
}): Promise<void> {
  const response = await options.fetch(options.url, {
    redirect: "follow",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok || !response.body) {
    throw new FfmpegError(`Downloading ffmpeg failed with HTTP ${response.status}.`, "FFMPEG_PROVISION_FAILED");
  }
  const declared = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (totalBytes !== null && totalBytes > MAX_ARCHIVE_BYTES) {
    await response.body.cancel();
    throw new FfmpegError(`The ffmpeg archive is larger than expected (${totalBytes} bytes).`, "FFMPEG_PROVISION_FAILED");
  }
  const file = await open(options.destination, "w");
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new FfmpegError("The ffmpeg archive is larger than expected.", "FFMPEG_PROVISION_FAILED");
      }
      await file.write(value);
      options.onProgress?.({ receivedBytes: received, totalBytes });
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * `tar -xf` handles zip on Windows and macOS (bsdtar) and tar.xz on Linux
 * (GNU tar), so provisioning needs no archive library.
 */
async function extractArchive(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const result = spawnSync("tar", ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    timeout: EXTRACT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split(/\r?\n/).slice(-2).join(" ");
    throw new FfmpegError(
      `Could not extract the ffmpeg archive${detail ? `: ${detail}` : "."}`,
      "FFMPEG_PROVISION_FAILED",
    );
  }
}

function executableName(): string {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

async function findBinary(directory: string, name: string): Promise<string | null> {
  try {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name);
    }
  } catch {
    /* Missing directory means not installed. */
  }
  return null;
}

async function findInstalled(
  directory: string,
  probe?: ((path: string) => FfmpegTools | null) | undefined,
): Promise<FfmpegTools | null> {
  const binary = await findBinary(directory, executableName());
  if (!binary) return null;
  try {
    return (probe ?? findFfmpeg)(binary);
  } catch {
    return null;
  }
}

export interface ProvisionOptions {
  cacheDir?: string | undefined;
  /** Test override for the pinned release. */
  release?: FfmpegRelease | undefined;
  fetch?: typeof fetch | undefined;
  /** Test override for archive extraction. */
  extract?: ((archive: string, destination: string) => Promise<void>) | undefined;
  /** Test override for binary validation. */
  probe?: ((path: string) => FfmpegTools | null) | undefined;
  signal?: AbortSignal | undefined;
  onStart?: ((release: FfmpegRelease) => void) | undefined;
  onProgress?: ((progress: DownloadProgress) => void) | undefined;
}

/**
 * Return a working ffmpeg from the cache, downloading and verifying the pinned
 * release on first use. The install directory appears only after the archive
 * checksum, the extraction and the binary probe all succeed.
 */
export async function provisionFfmpeg(options: ProvisionOptions = {}): Promise<FfmpegTools> {
  const release = options.release ?? releaseFor(process.platform, process.arch);
  if (!release) {
    throw new FfmpegError(
      `No pinned ffmpeg build exists for ${process.platform}-${process.arch}. Install ffmpeg manually or use --ffmpeg-path.`,
      "FFMPEG_UNSUPPORTED_PLATFORM",
    );
  }
  const root = resolve(options.cacheDir ?? defaultCacheDir());
  const installDir = join(root, release.id);
  const installed = await findInstalled(installDir, options.probe);
  if (installed) return installed;

  await mkdir(root, { recursive: true });
  const archivePath = join(root, `${release.id}.download`);
  const stagingDir = join(root, `${release.id}.tmp`);
  await rm(stagingDir, { recursive: true, force: true });
  await rm(installDir, { recursive: true, force: true });
  try {
    options.onStart?.(release);
    await downloadArchive({
      url: release.url,
      destination: archivePath,
      fetch: options.fetch ?? fetch,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const actual = await sha256File(archivePath);
    if (actual !== release.sha256) {
      throw new FfmpegError(
        `The ffmpeg archive checksum does not match the pinned SHA-256 (expected ${release.sha256}, got ${actual}).`,
        "FFMPEG_PROVISION_FAILED",
      );
    }
    await (options.extract ?? extractArchive)(archivePath, stagingDir);
    if (!(await findBinary(stagingDir, executableName()))) {
      throw new FfmpegError("The ffmpeg archive did not contain an ffmpeg binary.", "FFMPEG_PROVISION_FAILED");
    }
    await rename(stagingDir, installDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(archivePath, { force: true });
  }

  const tools = await findInstalled(installDir, options.probe);
  if (!tools) {
    await rm(installDir, { recursive: true, force: true });
    throw new FfmpegError("The downloaded ffmpeg binary failed to run.", "FFMPEG_PROVISION_FAILED");
  }
  return tools;
}
