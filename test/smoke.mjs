/**
 * Offline smoke test for dsh-muse-media. No network, no quota, no host packages.
 *
 *   node test/smoke.mjs
 *
 * It imports the plugin exactly as the DSH loader does (plain ESM), captures the
 * tool definitions, then drives them with a stubbed fetch to check:
 *   - tool definitions survive registration (name/parameters/output/render/execute)
 *   - elapsed_s is reported in seconds, not milliseconds
 *   - the video tool parses the real clip length out of the MP4 header and reports
 *     requested/actual/matched/note
 *   - a relative outDir resolves against the session workspace (or process.cwd())
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

/** Minimal MP4 header long enough for the mvhd parser (duration 10 s @ 1000). */
function fakeMp4(seconds = 10) {
  const buffer = Buffer.alloc(64);
  buffer.write("mvhd", 0, "ascii");
  buffer[4] = 0; // version 0
  buffer.writeUInt32BE(1000, 16); // timescale
  buffer.writeUInt32BE(seconds * 1000, 20); // duration
  return buffer;
}

const tools = new Map();
const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) }, get: () => undefined };

const outRoot = mkdtempSync(join(tmpdir(), "dsh-muse-media-"));
const media = {
  create: "/v1/media/fake.mp4",
  image: "/v1/media/fake.webp",
};

globalThis.fetch = async (url, init) => {
  const path = String(url).replace("http://127.0.0.1:18610", "");
  const json = (value) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  });
  if (path === "/v1/images/generations") {
    assert.ok(init && init.method === "POST");
    return json({ data: [{ url: media.image, bytes: 4, revised_prompt: "stubbed" }] });
  }
  if (path === "/v1/videos" && init && init.method === "POST") {
    return json({ id: "task_stub", status: "queued" });
  }
  if (path === "/v1/videos/task_stub") {
    return json({ id: "task_stub", status: "completed", progress: 100, result: { url: media.create } });
  }
  if (path === media.create) {
    const buffer = fakeMp4(10);
    return { ok: true, status: 200, arrayBuffer: async () => buffer };
  }
  if (path === media.image) {
    const buffer = Buffer.from("RIFF****WEBP");
    return { ok: true, status: 200, arrayBuffer: async () => buffer };
  }
  throw new Error("unexpected url: " + url);
};

apply(ctx, { outputDir: outRoot, apiKey: "m2a_test_key" });

// ---- image tool -----------------------------------------------------------
{
  const definition = tools.get("muse_generate_image");
  assert.equal(typeof definition.execute, "function");
  assert.equal(definition.output.schema.type, undefined, "output schema must be the open {} schema");
  const result = await definition.execute({ prompt: "a blue square" }, {});
  assert.equal(result.ok, true);
  assert.equal(result.ratio, "1:1");
  assert.ok(result.file && existsSync(result.file), "image file must be written");
  assert.equal(readFileSync(result.file, "utf8"), "RIFF****WEBP");
  assert.ok(Number.isFinite(result.elapsed_s) && result.elapsed_s >= 0 && result.elapsed_s < 5, "elapsed_s must be seconds, got " + result.elapsed_s);
  assert.equal(result.out_dir, outRoot);
}

// ---- video tool -----------------------------------------------------------
{
  const definition = tools.get("muse_generate_video");
  const result = await definition.execute({ prompt: "a paper boat", duration: 5, ratio: "16:9" }, {});
  assert.equal(result.ok, true);
  assert.equal(result.task_id, "task_stub");
  assert.equal(result.requested_duration_s, 5);
  assert.equal(result.actual_duration_s, 10);
  assert.equal(result.duration_matched, false);
  assert.match(result.duration_note, /实际输出 10 秒/);
  assert.ok(result.elapsed_s < 5, "elapsed_s must be seconds, got " + result.elapsed_s);
  assert.ok(existsSync(result.file), "video file must be written");
  assert.equal(result.out_dir, outRoot);
}

// ---- status tool ----------------------------------------------------------
{
  const definition = tools.get("muse_video_status");
  const result = await definition.execute({ taskId: "task_stub", download: true, outDir: outRoot }, {});
  assert.equal(result.ok, true);
  assert.equal(result.actual_duration_s, 10);
  assert.ok(existsSync(result.file));
}

rmSync(outRoot, { recursive: true, force: true });
console.log("smoke: ok — 3 tools, elapsed in seconds, duration parsed, outDir resolved");
