# Reframe — Roadmap

Where the live thinking canvas goes next. The shipped v1 is intentionally a zero-dependency,
single-file, runs-anywhere surface (the de-risked demo). The headline next step turns it from
"pick a view" into "generate the view."

## v2 — Generative UI (the agent composes the interface)

**Today:** the AI brain selects from a *fixed* palette of renderers (`board`, `list`,
`mindmap`, `table`, `timeline`). The ceiling is the set of views we pre-coded — so "I need a
new view → reframe" really means "one of our existing views appears."

**Next:** the agent no longer *chooses* a view, it **composes** one. "Show these ideas as an
impact/effort 2×2", "make it a RICE table", "draw the dependency graph", "a swimlane per
sprint" — the surface renders what the agent decided, **including a layout we never hand-coded.**
This is the literal realization of the project's premise: *say you need a new view, and it
appears* — any view, generated.

### Why CopilotKit

[CopilotKit](https://copilotkit.ai) provides the three primitives this needs:

| Primitive | What it unlocks |
|---|---|
| **Generative UI** — `useCopilotAction` with a `render` function | The agent emits a React component (with streamed props) into the surface. Reframe exposes building-block primitives (grid, axes, swimlane, node-graph, card cluster) + a `spec → layout` renderer; the agent composes them on the fly. |
| **CoAgents / shared state** | The append-only canvas state *becomes* the agent's shared state, bidirectionally. Typed copilot chat and Bee voice drive one canvas. |
| **Human-in-the-loop + frontend actions** | "Merge these two", "move that to Risks", "recolor by priority" — the agent acts on the canvas and the human approves. This is the "comment and the AI adapts live" loop. |

### What changes architecturally

- **Frontend:** the vanilla single-file `board.html` → a React surface wrapped in
  `<CopilotKit>`. Keep the vanilla canvas as a lightweight/offline fallback (the demo safety net).
- **Backend:** the brain's "return a patch" idea persists, recast as either a **Copilot Runtime**
  (Anthropic adapter → Claude) exposing actions, or a **LangGraph CoAgent**. The existing SSE
  state bridge feeds CopilotKit's shared state.
- **Model:** `view.type` (an enum) generalizes to a generative `render({ component, props })`
  decision.

### Incremental, low-risk migration path

1. Keep the Node brain + SSE state as the source of truth.
2. Add a React surface that reads the *same* state; wrap with CopilotKit; re-implement the
   current three views as `render` components (parity, no behavior change).
3. Add a generic spec-renderer + 2–3 new component primitives; the brain emits
   `render({ component, props })` instead of `view.type`.
4. Add frontend actions (merge / move / recolor) + human-in-the-loop approval.
5. (Optional) migrate the brain to a CoAgent for shared-state + streaming.

### Trade-off

The cost is trading today's zero-dependency, single-file, can't-fail-on-stage surface for
React + CopilotKit (+ possibly LangGraph) and a Runtime service. So v1 stays the demo of record;
generative UI lands once the concept is proven live.

## Other directions

- **Auto-structuring passes** — periodic "re-cluster the whole board" / "what's missing?"
  critic that suggests structure the live stream hasn't surfaced yet.
- **Multi-modal capture** — combine Bee audio with a photo of a physical post-it wall
  (Nova Act / vision) so a real whiteboard seeds the digital one.
- **Export targets** — beyond markdown: push to Miro / FigJam / a Kanban / a doc, one click.
- **Session memory** — carry clusters/decisions across sessions so a recurring planning meeting
  resumes where it left off.
