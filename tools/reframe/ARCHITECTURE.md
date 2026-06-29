# Reframe — Architecture

Reframe turns a spoken conversation into a live, self-organizing visual canvas. This document
explains how the pieces fit together. The authoritative data shapes live in
[`CONTRACT.md`](CONTRACT.md); this is the "why and how".

## 1. High-level flow

```
┌──────────────┐   bee stream / transcript    ┌───────────────────────────────────────┐
│  Bee device  │ ───────────────────────────▶ │            reframe-server.js               │
│  (wearable)  │                              │                                        │
└──────────────┘                              │  sequential input queue                │
        ▲                                     │      │                                 │
        │  (or) POST /api/reframe/inject          │      ▼                                 │
        │       POST /api/reframe/command         │  reframe-brain.js ── claude -p ──▶ JSON patch
   replay.js / typed / manual                 │      │                                 │
                                              │      ▼  apply patch (append-only)       │
                                              │  state (nodes, clusters, view, coverage)│
                                              │      │  persist board.json              │
                                              │      ▼  broadcast full state            │
                                              └──────┼─────────────────────────────────┘
                                                     │  SSE  /api/reframe/stream
                                                     ▼
                                          ┌────────────────────────┐
                                          │   board.html (canvas)  │
                                          │  board / list / mindmap│
                                          │  coverage badge, export│
                                          └────────────────────────┘
```

Every input — whether a Bee utterance, a replayed line, or a manual POST — flows through
**one path**: append to the source ledger → run the brain → apply the patch → recompute
coverage → persist → broadcast the full state over SSE. The browser is a pure renderer of
that state.

## 2. The append-only state model

State has two append-only layers (see `CONTRACT.md §1`):

- **`sources`** — the raw utterance ledger. Every spoken/typed line is recorded here, verbatim,
  forever. This is the *"never lose an idea"* guarantee at the data level.
- **`nodes`** — distilled ideas derived from sources, each tagged with a `kind`
  (`idea | action | question | decision | risk`), a `cluster`, optional `parent` (for mindmap
  nesting), and the `sourceIds` it came from.

Re-clustering and view changes are **non-destructive**: they re-label or re-arrange nodes,
never delete them. The state is persisted to `--state` (board.json) on every change and
re-loaded on boot, so a crash/restart resumes the session.

### Coverage = verification, reframed

`coverage` is computed after every patch: of the idea-bearing utterances (filler/small-talk
classified as `noise` is excluded), how many produced at least one node. `lost` is the list
of idea-bearing source ids with zero nodes. The badge **"N/N ideas captured · 0 lost"** is
the deterministic, audience-visible proof that nothing fell through — the direct analogue of
the workshop's CSS verification pass/fail.

## 3. The brain (`reframe-brain.js`)

`async processInput(state, input, opts) → patch`

1. Builds a **compact** view of current state (title, cluster labels, the last ~25 nodes) plus
   the new input, and a strict system prompt that demands a single JSON object (the patch).
2. Invokes the AI CLI as a subprocess: `cat <promptfile> | claude -p --model sonnet`
   (sonnet for low latency); `kiro-cli` is supported as a fallback. 60-second timeout.
3. Robustly extracts the JSON: strips ANSI codes and ``` fences, then takes the first balanced
   `{…}` object before `JSON.parse`.

The patch tells the server what changed: `newNodes` (with `tempId`, `clusterLabel`,
`parentTempId`, `sourceText`), `clusters`, an optional `view`, and the `intent`:

- `content` — new ideas; cluster them into a small number of meaningful themes, reusing
  existing labels when they fit.
- `view` — a pure reshape ("show as mindmap", "group by priority", "make this a list"); set
  `view.type`, usually no new nodes.
- `mixed` — both.
- `noise` — filler/acknowledgements; recorded in the ledger but excluded from coverage.

**Never-lose fallback:** if the CLI errors, times out, or returns unparseable output, the
brain returns a safe `content` patch that creates exactly one node from the raw text in an
`Unsorted` cluster. An idea is never dropped because the model hiccuped.

**`REFRAME_FAKE_BRAIN=1`** short-circuits the CLI with a deterministic patch — used by smoke tests
and offline development.

### Patch application (server side)

The server maps the brain's abstract patch onto real state: `tempId → n*` ids,
`parentTempId →` real parent, `clusterLabel →` an existing cluster (case-insensitive) or a new
one (color assigned from a palette). New nodes are appended and linked to their source.
Inputs are processed through a **sequential async queue**, so two utterances arriving close
together can't corrupt the state.

## 4. Transport: SSE

The server pushes the **entire state** on every change as a single `state` event (plus a
`hello` on connect and `status` events for the Bee/thinking indicators, and a 15s keepalive
comment). Pushing full state — rather than diffs — keeps the protocol trivial and the client
stateless: it just re-renders. State payloads are small (tens of nodes), so this is cheap and
eliminates an entire class of diff-sync bugs. The client auto-reconnects with backoff.

## 5. Bee integration

Reuses the streaming pattern from `tools/bee-annotator-solution/proxy-worker.js`:
spawn `bee stream --types update-conversation --json`; on a conversation reaching `processed`,
fetch `bee conversations transcript <id> --json` and feed each **new** utterance (deduped) into
the same queue as `/api/reframe/inject`. Bee is optional and isolated: if the binary is missing or
the stream drops, the server logs it, keeps Bee status `disconnected`, retries on a timer, and
everything else keeps working.

## 6. Views (`board.html`)

The canvas is a single self-contained file (HTML + CSS + vanilla JS + inline SVG; no build, no
CDN). A view is a **pure function of state**:

- **board** (default) — one column per cluster, sticky-note cards per node, kind tags, cluster
  color on the header.
- **list** — clusters as sections, nodes as bullets (with nesting for `parent`).
- **mindmap** — radial SVG: center = session title, ring = clusters, leaves = nodes/children,
  colored links.
- `table` / `timeline` fallbacks; unknown types fall back to board.

`state.view.type` selects the renderer; the header view-switcher also lets a human flip views,
which it does by POSTing `show as <view>` to `/api/reframe/command` (so manual and spoken control
share one path) while updating optimistically. New nodes get an enter animation so additions
are visible live on a projector. `?mock=1` renders a synthetic state with no server.

## 7. Design decisions & trade-offs

- **One input path.** Bee, replay, typed, and manual all converge on the same queue → the brain
  and coverage logic are written once and exercised identically in tests and live.
- **Append-only over edit-in-place.** The "never lose an idea" promise is structural, not a
  feature that can regress. Coverage is then a cheap, honest read on that structure.
- **Full-state SSE over diffs.** Simplicity and correctness beat micro-bandwidth at this scale.
- **Brain returns data, not prose.** The model emits a strict JSON patch the server validates
  and applies; the model never touches state directly, and a bad response degrades to the
  never-lose fallback instead of breaking the canvas.
- **Zero runtime dependencies for the server/UI.** Node built-ins + a single HTML file → trivial
  to run on any laptop at demo time; the only external moving parts are the `claude` and `bee`
  CLIs, both optional-degradable.
