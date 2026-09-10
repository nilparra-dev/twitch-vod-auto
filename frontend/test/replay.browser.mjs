import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";
import { fileURLToPath } from "node:url";

const server = await preview({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  build: { outDir: "../dist/player" },
  preview: { host: "127.0.0.1", port: 0 },
});
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(new URL("replay.html", origin).href);
  // Generate a small real media fixture locally. The test needs no network or binary assets.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start();
    let frame = 0;
    const timer = setInterval(() => {
      context.fillStyle = "#252529";
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = "#bf94ff";
      context.fillRect((frame++ * 8) % 280, 65, 40, 40);
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    recorder.stop();
    clearInterval(timer);
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  await page
    .getByLabel("Video file", { exact: true })
    .setInputFiles({ name: "test.webm", mimeType: "video/webm", buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  assert.equal(await page.locator("video").evaluate((video) => video.controls), false);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("video").currentTime > 0.3);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  assert.equal(await page.locator("video").evaluate((video) => video.muted), true);
  await page.getByRole("button", { name: "Unmute", exact: true }).click();
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.getByLabel("Video file", { exact: true }).setInputFiles({
    name: "second.webm", mimeType: "video/webm", buffer: Buffer.from(bytes),
  });
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  assert.equal(await page.locator("video").evaluate(video => video.muted), true, "source changes retain mute");
  await page.getByRole("button", { name: "Unmute", exact: true }).click();
  await page.getByLabel("Playback speed").selectOption("2");
  assert.equal(await page.locator("video").evaluate((video) => video.playbackRate), 2);
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  await page.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
  await page.waitForFunction(() => !document.fullscreenElement);

  const messages = Array.from({ length: 2000 }, (_, index) => ({
    id: String(index),
    offsetSeconds: index / 20,
    createdAt: "2026-09-01T00:00:00Z",
    user: null,
    color: null,
    text:
      index % 7
        ? `Message ${index}`
        : "A long chat message that must wrap inside the panel. ".repeat(12),
    fragments: [],
    badges: [],
  }));
  await page.getByLabel("Add archived chat", { exact: true }).setInputFiles({
    name: "chat.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        vodId: "test",
        coverage: "available-replay",
        status: "complete",
        messageCount: messages.length,
        video: { title: "Layout regression" },
        messages,
      }),
    ),
  });
  await page.getByLabel("Search chat", { exact: true }).waitFor();
  const dimensions = () =>
    page.evaluate(() => ({
      documentHeight: document.documentElement.scrollHeight,
      chatHeight: document.querySelector(".replay-chat").getBoundingClientRect().height,
    }));
  const initial = await dimensions();
  for (const offset of [5, 10, 20, 40, 60, 80]) {
    await page.getByLabel("Chat offset in seconds").fill(String(offset));
    await page.waitForFunction((expected) => {
      const last = document.querySelector(".replay-chat-log .replay-message:last-child button");
      return (
        last &&
        last.textContent
          .trim()
          .split(":")
          .reduce((total, part) => total * 60 + Number(part), 0) >= expected
      );
    }, offset);
    assert.deepEqual(await dimensions(), initial, "messages must not grow the document or panel");
  }
  assert.equal(initial.documentHeight, 900);
  assert.ok(
    await page.locator(".replay-chat-log").evaluate((log) => log.scrollHeight > log.clientHeight),
  );
  await page.locator(".replay-chat-log").evaluate((log) => {
    log.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Follow replay", exact: true }).click();
  await page.waitForFunction(() => {
    const log = document.querySelector(".replay-chat-log");
    return log.scrollHeight - log.scrollTop - log.clientHeight < 50;
  });
  await page.getByLabel("Search chat", { exact: true }).fill("Message 1500");
  await page.getByText("Message 1500", { exact: true }).waitFor();
  assert.deepEqual(await dimensions(), initial);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("button", { name: "Hide chat", exact: true }).click();
  assert.equal(await page.getByLabel("Replay chat", { exact: true }).isVisible(), false);
  await page.getByRole("button", { name: "Show chat", exact: true }).click();
  await page.getByRole("button", { name: "Theater mode", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Theater mode", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await dimensions();
  for (const offset of [10, 40, 80]) {
    await page.getByLabel("Chat offset in seconds").fill(String(offset));
    await page.waitForTimeout(150);
    assert.deepEqual(await dimensions(), mobile);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(
    "Browser regression passed: custom controls, 2,000-message bounded chat, search, follow, theater and mobile.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
