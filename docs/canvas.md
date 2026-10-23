# Canvases

A canvas is a Kite document of type `canvas`. Its content is a
[JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) document: `nodes` and
`edges`. Kite keeps its own extras under `kite` keys, so any JSON Canvas tool
can still read the file.

Canvases are on the HTTP API and in the browser. They are **not** on MCP: the
MCP tools only publish and edit Markdown and HTML, and refuse a canvas.

## Node types

| Type    | What it is                                        |
|---------|---------------------------------------------------|
| `text`  | Plain text. Shown as text, not Markdown.          |
| `link`  | A web address.                                    |
| `group` | A labelled box. Nodes inside it belong to it.     |
| `file`  | Kept as stored; JSON Canvas files from elsewhere. |

A **Kite node** is a `link` node with `kite: { kind: "kite", ref, view }`.
It shows another Kite document: `view: "card"` shows its title and
description, `view: "preview"` shows the document itself (Markdown styled
like the reading page, HTML in a sandbox).

Membership is geometric: a node belongs to the smallest group whose box holds
it. There is no list of members to keep in step.

## Reading

- `GET /api/artifacts/:id/canvas` returns the document with a top-level
  `kite: { docId, version }`. `format=jsoncanvas-strict` removes every `kite` key.
- `GET /api/artifacts/:id/canvas/outline` returns a short map: `counts`,
  `bounds`, a `tree` (groups nested, one `summary` line per node) and a
  `freeSlot`. `frame=<group id>` limits it to one group; `depth=N` stops
  nesting after N levels and says how many nodes are hidden. Read this
  first on a large canvas; it is much smaller than the document.
- Versions: `GET /api/artifacts/:id/versions/:n`. Pass `record=false` when you
  only compare against a version, so it is not counted as read.

## Changing

`POST /api/artifacts/:id/canvas/ops` with `{ baseVersion, ops, dryRun? }`.
Owner only. Up to 500 operations. All or nothing. One batch is one new version.

| Op           | Fields                                                     |
|--------------|------------------------------------------------------------|
| `add`        | `node`, `tempId?`, `id?`, `in?`, `near?`, `side?`          |
| `update`     | `id`, `set`, `unset?` (edges: label, color, fromSide, toSide) |
| `move`       | `id`, `x`, `y` (a group carries what is inside it)         |
| `resize`     | `id`, `width`, `height`                                    |
| `delete`     | `id` (a node takes its edges with it)                      |
| `connect`    | `from`, `to`, `tempId?`, `label?`, `fromSide?`, `toSide?`  |
| `disconnect` | `id`                                                       |

Later operations may name an earlier one by its `tempId`. The response has
`version`, `ids` (tempId → id) and `touched`.

**Placement.** An `add` without `x`/`y` is placed for you, always clear of
other nodes:

- `in: "<group id>"` puts it inside that group;
- `near: "<node id>"` with `side` (`right` by default, or `left`, `top`,
  `bottom`) puts it beside that node;
- with neither, it goes beside the node changed most recently, which is
  usually where the owner is looking.

**Conflicts.** A batch based on an old version is refused with 409
`version_conflict`, with `details.currentVersion`. Read the canvas again,
check your operations still make sense, and send them with the new version.

### Example

```sh
curl -s -X POST "$KITE/api/artifacts/$ID/canvas/ops" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseVersion": 7, "ops": [
        {"op": "add", "tempId": "q", "near": "n1", "side": "bottom",
         "node": {"type": "text", "text": "Open question"}},
        {"op": "connect", "from": "n1", "to": "q", "label": "asks"}]}'
```

## In the browser

The owner edits a canvas directly:

- the toolbar adds text, links, Kite documents and groups; **+ Group** with
  nodes selected wraps them;
- drag a node, or a group with everything in it; drag a corner to resize;
- drag from a side handle to another node to connect those two sides;
  double-click an edge to label or remove it;
- `Delete` removes the selection (deleting a group keeps what was inside);
- `Ctrl/Cmd+Z` undoes, `Shift+Ctrl/Cmd+Z` or `Ctrl+Y` redoes. Undo is sent to
  the server as operations and only takes back your own change; if somebody
  changed the same thing since, it says so instead of overwriting.

While the canvas is open, the page checks for changes every 10 seconds. Nodes
an agent added show as **N new nodes · Show**.

Large canvases stay fast by drawing less: nodes off screen are not drawn;
zoomed out, cards become boxes, labels go, and on canvases with more than 300
nodes or edges the edges go too. A large canvas opens at 50% zoom or closer.

Links on a public canvas go through the "you are leaving" page, as links in a
public Markdown document do. Links on a private canvas open directly.

## Comments

Select a node and press **Comment**. The node shows a marker with the number
of open threads. If the node is edited after the comment, the marker turns
orange (the comment may be out of date). If the node is deleted, the canvas
says how many comments lost their node, and the thread says so too.

## History

Past versions open as a read-only canvas. **Changes** draws what the version
changed on the canvas (added in green, changed dashed orange, removed as
faded red ghosts) and lists each change. **Restore this version** sends the
operations that make the current canvas match the old one: a new version, so
nothing is lost.
