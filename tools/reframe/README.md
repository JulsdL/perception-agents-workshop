# Reframe — Live Thinking Canvas

> **Talk. The canvas rebuilds itself. Nothing is ever lost.**
>
> Say *"show this as a mindmap"* → **Reframe**, the view morphs.

Reframe is a live "thinking canvas" for brainstorm / planning / structuring sessions.
You talk near a [Bee](https://bee.computer/) wearable; spoken ideas are distilled into
nodes, auto-clustered into themes, and rendered live on a projected canvas. Comment on
what you want and the AI re-shapes the canvas — board, list, mindmap — in real time.
The underlying model is **append-only**, so an idea once captured is **never lost** — a
coverage badge proves it ("N/N ideas captured · 0 lost").

This is the contest entry for the [perception-agents workshop](../../WORKSHOP.md). It reuses
the workshop's two perception primitives, **reframed**:

| Workshop primitive | Reframe reframing |
|---|---|
| **Annotation** (perception of DOM clicks) | Perception of **speech** via Bee — you talk instead of clicking |
| **Verification** (each CSS rule vs an expected value) | **Coverage** verification — each spoken utterance maps to a node (0 lost) |

## Screenshots

| Board | Mindmap | List |
|---|---|---|
| ![Board view](screenshots/board-view.png) | ![Mindmap view](screenshots/mindmap-view.png) | ![List view](screenshots/list-view.png) |

## Quick start

```bash
# 1. Start the canvas server (serves the UI + the live SSE stream)
node tools/reframe/reframe-server.js --port 9998 --state tools/reframe/.tmp/board.json

# 2. Open the canvas
open http://localhost:9998          # projector-friendly dark UI

# 3a. LIVE voice — click "🎙 Listen" in the canvas and just talk (Chrome; no Bee needed), or
# 3b. REHEARSAL — replay a canned session through the real AI brain:
node tools/reframe/replay.js --port 9998 --delay 2500
```

Three ways to feed the canvas, all through the same pipeline:
**browser voice** (the 🎙 Listen button — Chrome's Web Speech API, no account/hardware),
a **Bee wearable** (optional, see below), or **replay** for a scripted rehearsal.

The AI "brain" shells out to the `claude` CLI (auto-detected; falls back to `kiro-cli`).
No Python and no extra dependencies — the server uses only Node.js built-ins.

### Demo without the AI (deterministic)

```bash
REFRAME_FAKE_BRAIN=1 node tools/reframe/reframe-server.js --port 9998 --state tools/reframe/.tmp/board.json
```

`REFRAME_FAKE_BRAIN=1` returns a deterministic patch without calling the CLI — handy for smoke
tests and offline UI work. The UI also has a no-server mock mode: open
`board.html?mock=1` directly in a browser.

## Voice input

**Browser (recommended — no account, no hardware):** open the canvas in Chrome, click
**🎙 Listen**, allow the microphone, and talk. Recognized speech POSTs to `/api/reframe/inject`,
so the canvas builds itself live. Spoken view commands ("show this as a mindmap") work too, since
the brain reads intent from the same path. Uses the Web Speech API (Chrome; needs internet).

**Bee wearable (optional, hands-free):**

```bash
npm install -g @beeai/cli
bee login                 # your Bee account
bee status                # confirm connected
```

The server spawns `bee stream --types new-utterance,update-conversation --json`; `new-utterance`
streams each spoken phrase in real time (debounced into one node), and `update-conversation`
reconciles the full transcript as a fallback — both feed the same `/api/reframe/inject` pipeline.
If `bee` is not installed the server still runs (Bee status `disconnected`); browser voice and
replay still work. Override the binary location with `BEE_CLI_PATH`.

## Suggested live demo flow (90 seconds)

1. Open the empty canvas on the projector.
2. The team brainstorms out loud. Sticky notes appear and **auto-cluster** into themes live.
3. Someone says **"Can we see this as a mindmap?"** → the canvas morphs into a radial mindmap.
4. Someone says **"Group these by priority."** → the clusters reorganize.
5. End on the **coverage badge**: *N/N ideas captured · 0 lost* — click **Export** for a
   ready-to-share markdown of the whole session.

## CLI reference

**`reframe-server.js`**

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `9998` | HTTP + SSE port |
| `--state` | `tools/reframe/.tmp/board.json` | append-only board state (persisted every change, loaded on boot) |
| `--cli` | auto (`claude` → `kiro-cli`) | AI CLI used by the brain |
| env `REFRAME_FAKE_BRAIN=1` | — | deterministic patches, no CLI call |
| env `BEE_CLI_PATH` | `bee` | Bee binary location |

**`replay.js`** — `node replay.js [--port 9998] [--delay 2500] [--file sample-session.json]`
POSTs each utterance from `sample-session.json` to `/api/reframe/inject` (or `/api/reframe/command`
for view commands).

## Files

| File | Role |
|---|---|
| [`CONTRACT.md`](CONTRACT.md) | Shared data / SSE / endpoint / brain-patch contract — the single source of truth |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How it works: data model, SSE, brain, Bee, views, design decisions |
| `reframe-server.js` | Dependency-free Node HTTP/SSE server; append-only state; Bee streaming; export |
| `reframe-brain.js` | `processInput(state, input)` → JSON patch via the AI CLI; never-lose fallback |
| `board.html` | Self-contained canvas SPA (board / list / mindmap), SSE client, coverage badge |
| `sample-session.json` | 14-utterance rehearsal transcript |
| `replay.js` | Replays a transcript into a running server |
| `screenshots/` | UI screenshots used in this README |
