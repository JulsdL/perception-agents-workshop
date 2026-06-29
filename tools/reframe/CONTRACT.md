# Reframe — Shared Contract (single source of truth)

> **Reframe** = a live "thinking canvas". You talk during a brainstorm/planning session,
> spoken ideas are distilled into nodes, auto-clustered, and rendered live on a
> projected canvas. Say "show this as a mindmap" → **Reframe**, the view morphs.
> Append-only: an idea once captured is **never lost** (the "0 ideas lost" badge).
>
> Reuses the workshop's two perception primitives, reframed:
> - **Annotation** → perception of *speech* via Bee (instead of DOM clicks)
> - **Verification** → *coverage* check: every spoken utterance maps to a node (0 lost)
>
> ALL user-facing text, code comments, identifiers, and exports are in **English**.

---

## 1. State model (`board.json`, returned by `GET /api/reframe/state`)

```jsonc
{
  "sessionId": "string",
  "title": "string",                 // AI-inferred session title, may update over time
  "sources": [                       // APPEND-ONLY ledger of raw utterances (the "never lose" guarantee)
    { "id": "s1", "speaker": "string|null", "text": "string", "ts": 1730000000000, "nodeIds": ["n3"] }
  ],
  "nodes": [                         // distilled ideas (append-only; text may be refined, never deleted)
    { "id": "n1", "text": "string", "kind": "idea|action|question|decision|risk",
      "cluster": "c1", "parent": "n0|null", "sourceIds": ["s1"], "ts": 1730000000000 }
  ],
  "clusters": [
    { "id": "c1", "label": "string", "color": "#5A969E" }
  ],
  "view": { "type": "board|list|mindmap|table|timeline", "spec": {} },
  "coverage": { "total": 12, "covered": 11, "lost": ["s7"] }  // lost = source ids with no node
}
```

Rules:
- `sources` and `nodes` are **append-only**. Re-clustering or view changes never drop a node.
- `coverage.total` = sources considered "idea-bearing"; `covered` = those with >=1 node; `lost` = uncovered ids.
- Default `view.type` = `"board"`.

## 2. SSE stream (`GET /api/reframe/stream`, `Content-Type: text/event-stream`)

Server pushes **full state** on every change (simple + robust; payload is small).

```
data: {"type":"hello","state":{...full state...}}
data: {"type":"state","state":{...full state...}}
data: {"type":"status","bee":"connected|connecting|disconnected","thinking":true}
```

Frontend re-renders from `state` on every `hello`/`state` event. `status` only updates the
connection dot and the "thinking…" indicator.

## 3. HTTP endpoints (server listens on `--port`, default `9998`)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/` | — | `board.html` (the canvas SPA) |
| GET | `/api/reframe/stream` | — | SSE (see §2) |
| GET | `/api/reframe/state` | — | full state JSON (§1) |
| POST | `/api/reframe/inject` | `{ "speaker"?: string, "text": string }` | `{ok:true}` — adds a source utterance, runs the brain |
| POST | `/api/reframe/command` | `{ "text": string }` | `{ok:true}` — explicit view/transform command, runs the brain with `isCommand=true` |
| POST | `/api/reframe/reset` | — | `{ok:true}` — clears state |
| GET | `/api/reframe/export` | — | `text/markdown` rendering of the board (title, clusters, nodes, coverage) |
| GET | `/api/reframe/status` | — | `{ bee, thinking, sources, nodes, clusters }` |

All `/api/*` responses include `Access-Control-Allow-Origin: *` and handle `OPTIONS` preflight.

## 4. Brain contract (`reframe-brain.js`)

`async function processInput(state, input) -> patch`
- `input = { text: string, speaker: string|null, isCommand: boolean }`
- Calls the AI CLI (`claude -p`, binary auto-detected) with a strict-JSON system prompt.
- Returns a **patch** (strict JSON; parser strips ``` fences and leading prose):

```jsonc
{
  "intent": "content|view|mixed|noise",
  "title": "string|null",                       // optional session-title update
  "newNodes": [
    { "tempId": "t1", "text": "concise idea", "kind": "idea",
      "clusterLabel": "Theme A", "parentTempId": null, "sourceText": "original phrase that produced this" }
  ],
  "clusters": [ { "label": "Theme A", "color": "#5A969E" } ],
  "view": { "type": "mindmap", "spec": {} },     // or null when the view shouldn't change
  "coveredSourceText": ["phrases from the input that became nodes"]
}
```

Server responsibilities when applying a patch:
- Map `tempId` → real `n*` id; `parentTempId` → real parent id (within same patch) or existing node id.
- Resolve `clusterLabel` → existing cluster id (case-insensitive match) or create a new cluster (assign a color from a palette).
- Append `newNodes`; set their `sourceIds` to the triggering source.
- `intent:"view"` → update `state.view`, generally **no** new nodes (a pure transform).
- `intent:"noise"` → ignore (small talk, filler); the source still goes in the ledger but counts as non-idea-bearing (excluded from `coverage.total`).
- Recompute `coverage` after applying.

## 5. Views (frontend `board.html`)

Pure functions of state. Must support at least: `board` (columns per cluster, sticky-note cards),
`list` (grouped bullet list), `mindmap` (radial SVG tree: title → clusters → nodes/children).
Smooth enter animations for new cards (projector "wow"). Big, high-contrast, dark theme
(palette accent `#5A969E`). Persistent header: session title, connection dot, **thinking…** pulse,
**coverage badge** ("N/N ideas captured · 0 lost"), a view switcher, an **Export** button
(links `GET /api/reframe/export`). Frontend supports `?mock=1` to render synthetic state with no server.

## 6. Inputs / Bee integration

- Primary: `bee stream --types update-conversation --json` subprocess; on `state==processed`,
  fetch `bee conversations transcript <id> --json`, feed each new utterance to the brain via the
  same path as `/api/reframe/inject`. (Reuse the streaming code from `tools/bee-annotator-solution/proxy-worker.js`.)
- `bee` binary path overridable via `BEE_CLI_PATH`. If `bee` is missing, the server still runs
  (Bee status = `disconnected`) and `/api/reframe/inject` + `/api/reframe/command` + replay still work.
- A canned replay transcript (`tools/reframe/sample-session.json`, an array of `{speaker,text}`) and a
  `replay` helper let us rehearse without speaking. (Demo runs live on Bee; replay is for dev/rehearsal.)
