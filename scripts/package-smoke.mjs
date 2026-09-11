// Smoke test the npm artifact: pack the working tree without running lifecycle
// scripts, install the tarball into a temporary consumer project and verify the
// published files, the CLI entry point and the public API.
//
// Run `npm run build:package` first so dist/ contains the bundled player.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedFiles = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/resolver.js",
  "dist/chat/command.js",
  "dist/watch/server.js",
  "dist/player/replay.html",
  "dist/player/THIRD_PARTY_LICENSES.txt",
];

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", ...options });
}

function runNpm(args, options = {}) {
  // Under `npm run`, npm_execpath points at the npm CLI that invoked us. Using
  // it avoids Windows shim quirks entirely.
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) {
    return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", ...options });
  }
  // Fallback for direct invocations: let the shell resolve npm/npm.cmd instead
  // of building a quoted command line by hand.
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm ${args[0]} failed with code ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  }
  return result.stdout;
}

async function main() {
  for (const file of expectedFiles) {
    const info = await stat(join(root, file)).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`${file} is missing from the build. Run "npm run build:package" first.`);
    }
  }

  const temporary = await mkdtemp(join(tmpdir(), "twitch-m3u8-smoke-"));
  try {
    const packed = JSON.parse(
      runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root }),
    );
    const info = packed[0];
    if (!info?.filename || !Array.isArray(info.files)) {
      throw new Error("npm pack did not report tarball details.");
    }

    const published = new Set(info.files.map((entry) => entry.path));
    for (const file of expectedFiles) {
      if (!published.has(file)) throw new Error(`${file} is missing from the tarball.`);
    }

    // Every local asset referenced by the built page must ship in the tarball.
    const playerHtml = await readFile(join(root, "dist", "player", "replay.html"), "utf8");
    const referenced = [...playerHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)]
      .map((match) => match[1])
      .filter((value) => Boolean(value) && !/^https?:/i.test(value));
    for (const asset of referenced) {
      const file = `dist/player/${asset}`;
      if (!published.has(file)) {
        throw new Error(`${file} is referenced by replay.html but missing from the tarball.`);
      }
    }

    const consumer = join(temporary, "consumer");
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: "smoke-consumer", private: true, type: "module" }),
    );
    runNpm(
      ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", join(temporary, info.filename)],
      { cwd: consumer },
    );

    const packageDirectory = join(consumer, "node_modules", "twitch-vod-m3u8");
    const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
    const cli = join(packageDirectory, "dist", "cli.js");

    const printed = run(process.execPath, [cli, "--version"], { cwd: consumer }).trim();
    if (printed !== version) {
      throw new Error(`--version printed "${printed}" instead of "${version}".`);
    }
    const help = run(process.execPath, [cli, "--help"], { cwd: consumer });
    for (const command of ["chat", "watch", "list", "target", "download"]) {
      if (!help.includes(command)) throw new Error(`--help does not list the "${command}" command.`);
    }
    run(process.execPath, [cli, "chat", "--help"], { cwd: consumer });
    run(process.execPath, [cli, "watch", "--help"], { cwd: consumer });
    run(process.execPath, [cli, "list", "--help"], { cwd: consumer });
    run(process.execPath, [cli, "target", "--help"], { cwd: consumer });
    run(process.execPath, [cli, "download", "--help"], { cwd: consumer });

    const apiCheck = join(consumer, "check-api.mjs");
    await writeFile(
      apiCheck,
      `import { ResolveError, chooseFormat, parseInput, resolveM3U8 } from "twitch-vod-m3u8";
if (typeof resolveM3U8 !== "function" || typeof parseInput !== "function" || typeof chooseFormat !== "function" || typeof ResolveError !== "function") {
  throw new Error("Public API exports are missing.");
}
const target = parseInput("https://www.twitch.tv/videos/2434567890");
if (target.kind !== "public" || target.videoId !== "2434567890") {
  throw new Error("parseInput returned an unexpected result.");
}
`,
    );
    run(process.execPath, [apiCheck], { cwd: consumer });

    return info.filename;
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
      () => undefined,
    );
  }
}

try {
  const tarball = await main();
  console.log(
    `Package smoke test passed: ${tarball} (CLI, list/chat/watch/download help, player assets and public API).`,
  );
} catch (error) {
  console.error(`Package smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
