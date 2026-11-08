# dsh-muse-media

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that exposes the local
**[muse2api](https://github.com/czg86389-hub/muse2api)** reverse proxy (muse.ai web backend) as native
tools: text-to-image, image editing, text-to-video and image-to-video.

No API key juggling beyond your own muse2api key, no copy-sync: it loads straight from a linked
directory because it imports **only Node builtins**.

## Tools

| Tool | What it does | Typical latency |
|---|---|---|
| `muse_generate_image` | muse-image: text-to-image / image editing (`ratio`: 1:1, 16:9, 9:16, 4:3, 3:4) | 10–30 s |
| `muse_generate_video` | muse-video: text-to-video / image-to-video, async task + poll + MP4 download (`ratio`: 16:9, 9:16, 1:1) | 60–120 s |
| `muse_video_status` | inspect/download an existing task by id; never creates a task, costs no quota | instant |

Every result reports the resolved `out_dir`, byte size and `elapsed_s`. The video tools additionally
report `requested_duration_s`, `actual_duration_s`, `duration_matched` and a `duration_note` when the
upstream clip length differs from the request.

## Requirements

- DeepSeek Harness desktop (or any host exposing the `tools` service).
- A running **muse2api** instance, default `http://127.0.0.1:18610/v1`.
- A muse2api API key (`m2a_...`, from the muse2api admin console) — **not** included in this repo.

## Install

The plugin is loaded from this directory through a junction, so there is exactly one copy of the code.

1. **Add the dependency** to `~/.dsh/profiles/desktop/package.json` (`link:` is fine — the plugin has
   no npm dependencies of its own):

   ```json
   {
     "dependencies": {
       "dsh-muse-media": "link:/absolute/path/to/dsh-muse-media"
     }
   }
   ```

2. **Add the loader entry** to `~/.dsh/profiles/desktop/cordis.patch.yml`. Put your own key here (or
   export `MUSE2API_KEY` in the host environment instead):

   ```yaml
   - insert:
       - id: muse-media
         name: dsh-muse-media
         config:
           baseUrl: http://127.0.0.1:18610/v1
           apiKey: m2a_your_key_here
   ```

3. **Link it into the profile's `node_modules`** (Windows junction; on macOS/Linux a symlink works):

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-muse-media" `
     -Target "C:\absolute\path\to\dsh-muse-media"
   ```

4. **Restart DeepSeek Harness** once (the loader builds its package table at startup).

### Verify

```
plugin_manager list_plugins        → entry "include:muse-media" must show fiberPhase: "active"
```

If it shows `"failed"` or `"null"`, force a reload and read the host's own diagnostic:

```
plugin_manager set_plugin target=include:muse-media enabled=false
plugin_manager set_plugin target=include:muse-media enabled=true    → returns diagnostic
```

### Why zero dependencies matters

DSH only resolves `@deepseek-ai/*` packages for plugins that physically live inside the profile's
`node_modules`. A plugin linked from elsewhere that imports `defineTool` or `schemastery` fails at
load with `Cannot find package '@deepseek-ai/…'`, and its fiber never activates. This plugin builds
structurally valid tool definitions with plain JavaScript instead, so it can run from any linked
directory — one copy, no sync step, and `pnpm install` keeps working because the `link:` spec agrees
with the filesystem.

## Configuration

All keys are optional and passed as plain data through the loader entry (`config:` above).

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:18610/v1` | muse2api endpoint (OpenAI-style) |
| `apiKey` | `MUSE2API_KEY` env | `m2a_...`; requests fail with a clear error when missing |
| `outputDir` | `muse-output` | relative → resolved against the calling session's workspace |
| `requestTimeoutMs` | `120000` | per-request HTTP timeout |
| `videoTimeoutMs` | `420000` | polling budget for video tasks |
| `pollIntervalMs` | `4000` | video polling interval |

## Behavior notes

**`outDir` resolves against the session workspace, not the host process directory.**
Generated files land next to the project the agent is working in (`<workspace>/muse-output` by
default). Absolute paths are used as-is, and every result echoes the resolved `out_dir`.

**`duration` is advisory, not a contract.** muse2api forwards it only as prompt text
("时长严格为 N 秒"). Upstream produces 5 s or 10 s clips: request 6, 8 or 15 and you get 10; request
5 and you may still get 10. The result reports `actual_duration_s` — plan edits from that, and build
longer pieces from multiple segments.

**Protected IP characters are refused upstream.** Asking for e.g. "Iron Man"/"钢铁侠" returns a text
answer instead of media; the model itself will suggest an original look-alike. Describe an original
character design instead.

## Development

```bash
node test/smoke.mjs        # offline: no network, no generation quota
```

The smoke test stubs `fetch` and asserts that the three tool definitions register, `elapsed_s` is in
seconds, the video tool parses the real clip length out of the MP4 `mvhd` box, and a relative
`outDir` resolves against the workspace.

## License

MIT — see [LICENSE](LICENSE).
