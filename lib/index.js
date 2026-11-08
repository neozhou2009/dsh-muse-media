/**
 * dsh-muse-media - Muse image/video generation tools for DeepSeek Harness.
 *
 * Talks to the local muse2api reverse proxy (OpenAI-style):
 *   POST /v1/images/generations            -> muse-image
 *   POST /v1/videos + GET /v1/videos/{id}  -> muse-video (async)
 *   GET  /v1/models
 *
 * Zero-dependency by design: this module imports ONLY Node builtins. The DSH
 * host only resolves `@deepseek-ai/*` packages for plugins that live inside the
 * profile's node_modules, so a plugin installed as a link/junction elsewhere in
 * the filesystem must not import them — otherwise the loader reports
 * `failed to import: Cannot find package '@deepseek-ai/...'` and the fiber never
 * activates. Tool definitions are therefore built structurally, matching what
 * `defineTool()` produces for the same inputs.
 *
 * Media URLs returned as "/v1/media/..." are relative; they are absolutized
 * against the configured origin before downloading.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const name = "dsh-muse-media";
// Only `tools` is a hard dependency. `workingDirectory` is read opportunistically
// through ctx.get() inside tool execution (cordis allows reading a service
// without injecting it), so the plugin still loads in profiles that lack it.
export const inject = ["tools"];

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:18610/v1",
  apiKey: "",
  outputDir: "muse-output",
  requestTimeoutMs: 120000,
  videoTimeoutMs: 420000,
  pollIntervalMs: 4000,
};

const IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const VIDEO_RATIOS = ["16:9", "9:16", "1:1"];
const TERMINAL_OK = new Set(["succeeded", "completed"]);
const TERMINAL_FAIL = new Set(["failed", "cancelled", "expired"]);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function originOf(baseUrl) {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function absolutize(baseUrl, url) {
  if (typeof url !== "string") return url;
  if (url.startsWith("/")) return originOf(baseUrl) + url;
  return url;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Milliseconds since `started`, rounded to 0.1 s. */
function elapsedSeconds(started) {
  return Math.round((Date.now() - started) / 100) / 10;
}

function imageExtension(url) {
  const hit = /\.([a-zA-Z0-9]{2,5})(?:\?|$)/.exec(url || "");
  return hit ? hit[1].toLowerCase() : "webp";
}

/** Read the duration of an MP4/MOV buffer from its movie header (mvhd box). */
function mp4DurationSeconds(buffer) {
  try {
    const index = buffer.indexOf(Buffer.from("mvhd"));
    if (index < 0) return null;
    const version = buffer[index + 4];
    let timescale;
    let duration;
    if (version === 1) {
      timescale = buffer.readUInt32BE(index + 24);
      duration = Number(buffer.readBigUInt64BE(index + 28));
    } else {
      timescale = buffer.readUInt32BE(index + 16);
      duration = buffer.readUInt32BE(index + 20);
    }
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

/**
 * Normalize plugin configuration. The patch layer may pass any subset of keys;
 * everything else falls back to DEFAULTS (config is plain data, no schema).
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const cfg = {
    baseUrl: typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : DEFAULTS.baseUrl,
    apiKey:
      (typeof input.apiKey === "string" && input.apiKey.trim()) ||
      (process.env.MUSE2API_KEY || "").trim(),
    outputDir: typeof input.outputDir === "string" && input.outputDir.trim() ? input.outputDir.trim() : DEFAULTS.outputDir,
    requestTimeoutMs: Number.isFinite(input.requestTimeoutMs) ? input.requestTimeoutMs : DEFAULTS.requestTimeoutMs,
    videoTimeoutMs: Number.isFinite(input.videoTimeoutMs) ? input.videoTimeoutMs : DEFAULTS.videoTimeoutMs,
    pollIntervalMs: Number.isFinite(input.pollIntervalMs) ? input.pollIntervalMs : DEFAULTS.pollIntervalMs,
  };
  if (!/^https?:\/\//i.test(cfg.baseUrl)) throw new Error("baseUrl must be an http(s) URL");
  return cfg;
}

function createClient(cfg) {
  async function apiJson(path, init) {
    if (!cfg.apiKey) {
      throw new Error(
        "muse2api API key is missing: set MUSE2API_KEY in the host environment or pass config.apiKey " +
          '("m2a_..." from the muse2api admin console)',
      );
    }
    const options = init || {};
    const headers = { Authorization: "Bearer " + cfg.apiKey };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(cfg.baseUrl + path, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error("muse2api " + res.status + " " + path + ": " + text.slice(0, 600));
    }
    return text ? JSON.parse(text) : {};
  }

  async function download(url, outDir, filename) {
    const res = await fetch(url, { signal: AbortSignal.timeout(240000) });
    if (!res.ok) throw new Error("download failed " + res.status + " " + url);
    const buffer = Buffer.from(await res.arrayBuffer());
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, filename);
    await writeFile(file, buffer);
    return { file, bytes: buffer.byteLength, buffer };
  }

  return { apiJson, download };
}

/**
 * Resolve the directory a generated file should land in.
 *
 * Absolute `outDir` wins. A relative one resolves against the calling agent's
 * session workspace (the directory the user sees), NOT against the DSH process
 * working directory (which is the profile folder) — passing no outDir therefore
 * writes into `<workspace>/muse-output` instead of a stray profile-local folder.
 */
function resolveOutDir(ctx, exec, requested, cfg) {
  const raw = requested && String(requested).trim() ? String(requested).trim() : cfg.outputDir;
  if (isAbsolute(raw)) return raw;
  return resolve(sessionWorkspace(ctx, exec), raw);
}

function sessionWorkspace(ctx, exec) {
  try {
    const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    const session = exec && exec.agent ? exec.agent.session : undefined;
    const dir = service && session ? service.get(session) : undefined;
    if (typeof dir === "string" && dir) return dir;
  } catch {
    /* fall through to the process directory */
  }
  return process.cwd();
}

function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** One structurally-valid tool definition (the shape `defineTool()` emits). */
function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: { schema: {}, render: renderJson },
    execute: definition.execute,
  };
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  const client = createClient(cfg);

  const imageTool = tool({
    name: "muse_generate_image",
    description:
      "Generate or edit an image with the local Muse service (muse2api, muse-image model). Returns the media URL and downloads the file locally; usually takes 10-30 seconds. Use for text-to-image and image editing. Relative outDir resolves against this session's workspace (default <workspace>/muse-output).",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Image prompt. For editing, describe the change and pass the source image through the image field.",
        },
        ratio: {
          type: "string",
          enum: IMAGE_RATIOS,
          description: "Aspect ratio, default 1:1.",
        },
        image: {
          type: "string",
          description: "Optional source image URL for image editing / img2img.",
        },
        outDir: {
          type: "string",
          description:
            "Optional output directory. Absolute paths are used as-is; relative paths resolve against the session workspace.",
        },
      },
      required: ["prompt"],
    },
    async execute(args, exec) {
      const prompt = args && typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new Error("prompt is required");
      const ratio = IMAGE_RATIOS.includes(args.ratio) ? args.ratio : "1:1";
      const payload = { model: "muse-image", prompt, size: ratio, response_format: "url" };
      if (args.image) payload.image = args.image;

      const started = Date.now();
      const resp = await client.apiJson("/images/generations", { method: "POST", body: payload });
      const item = (resp && resp.data && resp.data[0]) || {};
      const url = absolutize(cfg.baseUrl, item.url);
      const outDir = resolveOutDir(ctx, exec, args.outDir, cfg);
      let file = null;
      let bytes = item.bytes === undefined ? null : item.bytes;
      if (url) {
        try {
          const saved = await client.download(url, outDir, "muse-image-" + stamp() + "." + imageExtension(url));
          file = saved.file;
          bytes = bytes === null ? saved.bytes : bytes;
        } catch (error) {
          return {
            ok: false,
            stage: "download",
            url,
            out_dir: outDir,
            error: String(error && error.message ? error.message : error),
            elapsed_s: elapsedSeconds(started),
          };
        }
      }
      return {
        ok: Boolean(url) && file !== null,
        model: "muse-image",
        ratio,
        url,
        file,
        out_dir: outDir,
        bytes,
        revised_prompt: item.revised_prompt === undefined ? null : item.revised_prompt,
        elapsed_s: elapsedSeconds(started),
      };
    },
  });

  const videoTool = tool({
    name: "muse_generate_video",
    description:
      "Create a Muse video task (muse-video model, text-to-video or image-to-video), poll it until it finishes (usually 60-120 seconds) and download the MP4 locally. Ratios: 16:9, 9:16, 1:1. Duration is in seconds (default 5) and is ADVISORY: muse2api forwards it only as prompt text, upstream produces 5 s or 10 s clips and the returned clip is not guaranteed to match the request — the result reports requested_duration_s and actual_duration_s. Relative outDir resolves against this session's workspace (default <workspace>/muse-output).",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Video prompt describing subject, action, camera movement and lighting.",
        },
        duration: {
          type: "integer",
          description: "Requested clip length in seconds (default 5). Advisory: upstream may return 5 s or 10 s.",
        },
        ratio: {
          type: "string",
          enum: VIDEO_RATIOS,
          description: "Aspect ratio, default 16:9.",
        },
        image: {
          type: "string",
          description: "Optional source image URL for image-to-video.",
        },
        outDir: {
          type: "string",
          description:
            "Optional output directory. Absolute paths are used as-is; relative paths resolve against the session workspace.",
        },
      },
      required: ["prompt"],
    },
    async execute(args, exec) {
      const prompt = args && typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new Error("prompt is required");
      const requested = Number.isFinite(args.duration) ? Math.trunc(args.duration) : 5;
      const duration = Math.min(30, Math.max(1, requested));
      const ratio = VIDEO_RATIOS.includes(args.ratio) ? args.ratio : "16:9";
      const payload = { model: "muse-video", prompt, duration, size: ratio };
      if (args.image) payload.image = args.image;

      const started = Date.now();
      const created = await client.apiJson("/videos", { method: "POST", body: payload });
      const taskId = created && created.id;
      if (!taskId) throw new Error("muse2api did not return a task id");

      let task = created;
      let status = String(task.status || "queued");
      while (Date.now() - started < cfg.videoTimeoutMs) {
        if (TERMINAL_OK.has(status) || TERMINAL_FAIL.has(status)) break;
        await sleep(cfg.pollIntervalMs);
        try {
          task = await client.apiJson("/videos/" + encodeURIComponent(taskId));
          status = String(task.status || "");
        } catch {
          /* transient poll failure: keep the previous status and retry */
        }
      }

      const url = absolutize(cfg.baseUrl, taskUrlOf(task));
      const outDir = resolveOutDir(ctx, exec, args.outDir, cfg);
      let file = null;
      let bytes = null;
      let actual = null;
      if (TERMINAL_OK.has(status) && url) {
        try {
          const saved = await client.download(url, outDir, "muse-video-" + taskId + ".mp4");
          file = saved.file;
          bytes = saved.bytes;
          actual = mp4DurationSeconds(saved.buffer);
        } catch (error) {
          return {
            ok: false,
            stage: "download",
            task_id: taskId,
            status,
            url,
            out_dir: outDir,
            error: String(error && error.message ? error.message : error),
            elapsed_s: elapsedSeconds(started),
          };
        }
      }

      const actualRounded = actual === null ? null : Math.round(actual * 100) / 100;
      return {
        ok: TERMINAL_OK.has(status) && Boolean(url) && file !== null,
        task_id: taskId,
        status,
        url,
        file,
        out_dir: outDir,
        bytes,
        requested_duration_s: duration,
        actual_duration_s: actualRounded,
        duration_matched: actualRounded === null ? null : Math.abs(actualRounded - duration) <= 0.25,
        duration_note:
          actualRounded !== null && Math.abs(actualRounded - duration) > 0.25
            ? "Muse 上游实际输出 " +
              actualRounded +
              " 秒（请求 " +
              duration +
              " 秒）。duration 只是提示词层面的请求：上游只出 5 秒或 10 秒，且不保证等于请求值，剪辑时请按 actual_duration_s 规划。"
            : null,
        timed_out: !TERMINAL_OK.has(status) && !TERMINAL_FAIL.has(status),
        elapsed_s: elapsedSeconds(started),
      };
    },
  });

  const statusTool = tool({
    name: "muse_video_status",
    description:
      "Inspect an existing Muse video task by id (task_...) and optionally download the MP4. Use it after muse_generate_video times out; it never creates a new task and does not consume quota. Relative outDir resolves against this session's workspace.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id returned by muse_generate_video (task_...).",
        },
        download: {
          type: "boolean",
          description: "Download the MP4 when the task succeeded, default true.",
        },
        outDir: {
          type: "string",
          description:
            "Optional output directory for the download. Relative paths resolve against the session workspace.",
        },
      },
      required: ["taskId"],
    },
    async execute(args, exec) {
      const taskId = args && typeof args.taskId === "string" ? args.taskId.trim() : "";
      if (!taskId) throw new Error("taskId is required");
      const task = await client.apiJson("/videos/" + encodeURIComponent(taskId));
      const status = String(task.status || "");
      const url = absolutize(cfg.baseUrl, taskUrlOf(task));
      const outDir = resolveOutDir(ctx, exec, args.outDir, cfg);
      let file = null;
      let bytes = null;
      let actual = null;
      if (args.download !== false && TERMINAL_OK.has(status) && url) {
        try {
          const saved = await client.download(url, outDir, "muse-video-" + taskId + ".mp4");
          file = saved.file;
          bytes = saved.bytes;
          actual = mp4DurationSeconds(saved.buffer);
        } catch (error) {
          return {
            ok: false,
            stage: "download",
            task_id: taskId,
            status,
            url,
            out_dir: outDir,
            error: String(error && error.message ? error.message : error),
          };
        }
      }
      return {
        ok: TERMINAL_OK.has(status),
        task_id: taskId,
        status,
        url,
        file,
        out_dir: outDir,
        bytes,
        actual_duration_s: actual === null ? null : Math.round(actual * 100) / 100,
        progress: task.progress === undefined ? null : task.progress,
      };
    },
  });

  for (const definition of [imageTool, videoTool, statusTool]) {
    ctx.tools.register(definition);
  }
}

/** Video URL as muse2api reports it across its response shapes. */
function taskUrlOf(task) {
  if (!task) return null;
  if (task.result && task.result.url) return task.result.url;
  if (task.url) return task.url;
  if (task.video && task.video.url) return task.video.url;
  return null;
}
