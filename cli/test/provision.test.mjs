import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FfmpegError } from "../../dist/download/ffmpeg.js";
import { provisionFfmpeg, releaseFor, sha256File } from "../../dist/download/provision.js";

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function serve(payload) {
  const requests = { count: 0 };
  const server = createServer((_request, response) => {
    requests.count += 1;
    response.writeHead(200, { "content-length": payload.length });
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/archive.zip`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fakeExtract(archiveBody) {
  return async (_archive, destination) => {
    const bin = join(destination, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), "fake binary");
    assert.equal(Boolean(archiveBody), true);
  };
}

const fakeProbe = (path) => ({ ffmpeg: path, ffprobe: null, version: "ffmpeg version test" });

describe("ffmpeg release matrix", () => {
  it("pins https assets with 64 character checksums", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["win32", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ]) {
      const release = releaseFor(platform, arch);
      assert.ok(release, `${platform}-${arch} should have a pinned release`);
      assert.match(release.url, /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-/);
      assert.match(release.sha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(releaseFor("darwin", "arm64"), undefined);
    assert.equal(releaseFor("freebsd", "x64"), undefined);
  });

  it("computes the sha256 of a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-provision-test-"));
    try {
      const file = join(directory, "hello.txt");
      await writeFile(file, "hello");
      assert.equal(
        await sha256File(file),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ffmpeg provisioning", () => {
  it("downloads, verifies and reuses the pinned build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-provision-test-"));
    const body = Buffer.from("fake archive body");
    const server = await serve(body);
    try {
      const release = {
        id: "test-release",
        url: server.url,
        sha256: createHash("sha256").update(body).digest("hex"),
        archive: "zip",
      };
      const starts = [];
      const progress = [];
      const options = {
        cacheDir: directory,
        release,
        extract: fakeExtract(body),
        probe: fakeProbe,
        onStart: (value) => starts.push(value),
        onProgress: (value) => progress.push(value),
      };

      const first = await provisionFfmpeg(options);

      assert.equal(server.requests.count, 1);
      assert.equal(starts.length, 1);
      assert.ok(progress.some((update) => update.receivedBytes === body.length));
      assert.ok(first.ffmpeg.includes(release.id));
      assert.equal(await exists(first.ffmpeg), true);
      assert.deepEqual(await readdir(directory), [release.id]);

      const second = await provisionFfmpeg(options);
      assert.equal(server.requests.count, 1);
      assert.equal(second.ffmpeg, first.ffmpeg);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a checksum mismatch and leaves no install behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-provision-test-"));
    const server = await serve(Buffer.from("tampered archive"));
    try {
      await assert.rejects(
        provisionFfmpeg({
          cacheDir: directory,
          release: {
            id: "bad-release",
            url: server.url,
            sha256: "0".repeat(64),
            archive: "zip",
          },
          extract: fakeExtract(),
          probe: fakeProbe,
        }),
        (error) => error instanceof FfmpegError && error.code === "FFMPEG_PROVISION_FAILED" && /checksum/.test(error.message),
      );
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
