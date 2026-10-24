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
| `update`     | `id`, `set`, `unset?` (edges: label, color, fromSide, toSide, fromEnd, toEnd) |
| `move`       | `id`, `x`, `y` (a group carries what is inside it)         |
| `resize`     | `id`, `width`, `height`                                    |
| `delete`     | `id` (a node takes its edges with it)                      |
| `connect`    | `from`, `to`, `tempId?`, `label?`, `fromSide?`, `toSide?`  |
| `disconnect` | `id`                                                       |
| `theme`      | `set` (merged into the canvas theme; `null` removes it)    |
| `addAsset`   | `svg`, `name?`, `tempId?`, `id?` (a custom SVG icon)       |
| `deleteAsset`| `id` (refused while a node shows it)                       |

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

## Look: styles, icons and theme

Everything about how a canvas looks is stored under `kite` keys, so a strict
JSON Canvas export (`format=jsoncanvas-strict`) drops it and stays a valid
JSON Canvas 1.0 file. The spec's own `color` (a preset `"1"`…`"6"` or a hex
colour) still works: it colours a node's border and tints its fill, and
colours an edge. A `kite.style` drawn on top wins.

What a node looks like is worked out in this order, each step winning over
the one before: Kite's default card → the canvas theme → the spec `color` →
the node's own `kite.style`.

**Node style** (`kite.style` on text, link, Kite and group nodes):

| Key             | Value                                              |
|-----------------|----------------------------------------------------|
| `fill`, `borderColor`, `textColor` | a colour (below)                |
| `borderWidth`   | 0 to 16 (0: no border)                             |
| `borderStyle`   | `solid`, `dashed`, `dotted`                        |
| `radius`        | 0 to 96                                            |
| `font`          | `sans`, `inter`, `grotesk`, `serif`, `mono`, `hand` |
| `fontSize`      | 8 to 96                                            |
| `fontWeight`    | 300, 400, 500, 600, 700, 800                       |
| `textAlign`     | `left`, `center`, `right`                          |
| `verticalAlign` | `top`, `middle`, `bottom`                          |
| `shadow`        | `none`, `sm`, `md`, `lg`                           |

Groups also take `labelColor`, `labelFont`, `labelSize`, `labelWeight` and
`labelBackground` for their name.

**Edge style** (`kite.style` on an edge): `width` (1 to 12), `line` (`solid`,
`dashed`, `dotted`), `curve` (`bezier`, `straight`, `step`) and the same five
`label*` keys. The colour is the spec's `color`, and the arrow ends are the
spec's `fromEnd` / `toEnd` (`none` or `arrow`).

A colour is a preset `"1"`…`"6"`, `#rgb`, `#rrggbb`, `#rrggbbaa` or
`transparent`.

An `update` with `set.kite.style` merges into the style key by key: a key set
to `null` goes back to the default, and `"style": null` removes the whole
style. Unknown keys and bad values refuse the batch.

**Fonts.** The six fonts are a fixed set. Apart from `sans` (the page's own
font), they are served by Kite itself (Inter, Space Grotesk, Source Serif 4,
JetBrains Mono, Caveat), never from a font CDN, and are only loaded on a page
that shows a canvas.

**Theme** (top-level `kite.theme`, set with the `theme` op): `background`,
`grid` (`dots`, `lines`, `cross`, `none`), `gridColor`, and default styles
`node`, `group` and `edge` (`edge` may also give a `color`, used by edges that
name none). It is merged like a style.

**Icons** (`kite.icon` on a node): `{ name, position?, size?, color? }`.

- `name` is `lucide:<icon>` for any [Lucide](https://lucide.dev) icon
  (`lucide:server`, `lucide:database`…), or `asset:<id>` for one of this
  canvas's custom SVGs. An unknown Lucide name is refused.
- `position` is `left` of the text (default) or `top`, large above it.
- `size` is 12 to 160 pixels (default 20 on the left, 32 on top).
- `color` tints a Lucide icon. A custom SVG keeps its own colours.

Setting `set.kite.icon` replaces the icon; `null` removes it. The Lucide
icons ship with Kite and are loaded only when a canvas uses one, or when the
icon picker opens.

### Custom SVG icons

A custom SVG is kept once per canvas, in the top-level `kite.assets` map
(`{ "<id>": { "type": "svg", "svg": "…", "name": "…" } }`), and any number
of nodes show it by naming `asset:<id>`. Keeping it inside the canvas
document means a version, a restore and an export carry their icons with
them, and nothing outside the canvas has to be kept in step. A strict export
drops it with the other `kite` keys.

`addAsset` adds one: `{ "op": "addAsset", "tempId": "logo", "svg": "<svg …>",
"name": "Logo" }`. Later operations in the same batch can say
`asset:logo`; the response's `ids` gives the real id. `deleteAsset` removes
one, and is refused while a node still shows it. A canvas has at most 100
assets, each at most 64 KB.

The server sanitises every SVG on every write (ops, publish, update and
restore), and the browser uses the same code for its preview, so both give
the same bytes. The sanitiser does not filter the text it was given: it
parses it with a strict XML reader and writes a new document from what it
understood.

- Only an allowlist of drawing elements is kept (shapes, paths, text,
  groups, `defs`/`use`/`symbol`, gradients, clip paths, masks, patterns,
  markers and a few filters). Everything else is removed with what is inside
  it: `script`, `style`, `foreignObject`, `image`, `a`, animation, editor
  metadata.
- Only an allowlist of presentation attributes is kept. Event handlers
  (`on*`) go. `href` and `url(…)` survive only when they point inside the
  SVG (`#id`). A `style` attribute keeps only allowlisted properties.
- A DOCTYPE with entity definitions, unknown entities and malformed XML are
  refused. So is an SVG that has nothing left to draw, one too deeply nested,
  with too many elements, or with `<use>` pointing at something that holds
  another `<use>`.

The result is only ever drawn as an image (`<img>` with a `data:` URI),
never put into the page, so even something the sanitiser missed could not run
a script or load anything.

## In the browser

The owner edits a canvas directly:

- the toolbar adds text, links, Kite documents and groups; **+ Group** with
  nodes selected wraps them;
- drag a node, or a group with everything in it; drag a corner to resize;
- drag from a side handle to another node to connect those two sides;
  double-click an edge to label or remove it;
- `Delete` removes the selection (deleting a group keeps what was inside);
- **Style** opens a panel beside the canvas. With nodes or edges selected it
  styles all of them at once (one version); with nothing selected it edits
  the canvas theme. **Icon…** opens a picker that searches the Lucide icons,
  or takes an SVG file or pasted SVG, shows what the sanitiser keeps, and
  reuses the canvas's custom icons;
- `Ctrl/Cmd+Z` undoes, `Shift+Ctrl/Cmd+Z` or `Ctrl+Y` redoes. Undo is sent to
  the server as operations and only takes back your own change; if somebody
  changed the same thing since, it says so instead of overwriting.

An open canvas follows changes as they are made. When an agent (or you, in
another tab) writes to it, the page reads the canvas again at once and keeps
anything you have not saved yet on top. New nodes that arrive this way show as
**N new nodes · Show**. Your own changes in this tab are not shown as new. A
small dot in the bar says **Live** while the page is following, and
**Reconnecting** when the connection dropped; when it is back, the page
catches up on whatever it missed.

Each tab listens on one stream, `GET /api/events?slug=…` (or `?artifact=…`),
of server-sent events that say what kind of thing changed and the version it
is now at, never the content. Anybody who may read the canvas may listen, and
that is checked again on every change and every 25-second heartbeat, so
removing a share or letting a link expire stops the stream following the
document too. The same stream keeps the comments, the title and description,
and Markdown and HTML documents up to date, and carries the signed-in
person's unread count to the bell. An HTML document keeps the reader's place
when a new version arrives.

Large canvases stay fast by drawing less: nodes off screen are not drawn;
zoomed out, cards become boxes, labels go, and on canvases with more than 300
nodes or edges the edges go too. A large canvas opens at 50% zoom or closer.

Links on a public canvas go through the "you are leaving" page, as links in a
public Markdown document do. Links on a private canvas open directly.

## Images

`GET /api/artifacts/:id/canvas/image` draws the canvas on the server, as a
PNG (the default) or an SVG, without a browser. It draws what the web app
draws: the styles and theme, the five fonts, Lucide icons and custom SVG
icons, link and Kite cards, groups with their labels, edges with their
curves, arrows, dashes and labels, and the dot, line or cross grid. The browser and
the server read the same look from `packages/shared` (`canvas-look.ts`).

| Parameter | Values | Default |
| --- | --- | --- |
| `format` | `png`, `svg` | `png` |
| `version` | a past version number (owner only) | the current one |
| `node` | a node id: that node, or a group and what is inside it | the whole canvas |
| `scale` | 1 to 3, pixels per canvas pixel | 2 |
| `padding` | 0 to 400 canvas pixels | 32 |
| `background` | `theme`, or `transparent` for no background and no grid | `theme` |
| `grid` | `true`, `false` (the theme's grid) | `true` |
| `record` | `false` to not record a token read | |

Whoever may read the canvas may have its image. A Kite card shows the title
of the document it points at only to somebody who may open that document;
anybody else sees "A document you can't open", as in the browser. A token
read is recorded as an agent read, like reading the canvas, unless
`record=false`.

The answer says where it is on the canvas: `X-Canvas-Origin: x,y` is the
canvas point at the image's top left, and one canvas pixel is `scale` image
pixels. `X-Artifact-Version` is the version drawn. The `ETag` changes when
the canvas, the options, the renderer or the Kite cards' titles change; ask
with `If-None-Match` and an unchanged image is a 304. `Content-Disposition`
names the file after the canvas title.

Limits: the canvas limits apply (5,000 nodes); a PNG is at most 8,192 pixels
on a side and 16,777,216 pixels in all, and a larger one is refused with a
message that says how big it would be (ask for a smaller scale, one group
with `node`, or an SVG, which has no pixel limit). Images have their own
hourly budget per person, or per address when signed out
(`MAX_CANVAS_IMAGES_PER_HOUR`, default 120); a 304 does not count. Two images
are drawn at a time on one server; others wait.

How it is drawn:

- Text is shaped with HarfBuzz from the same font files the web app serves,
  and wrapped as the browser wraps it (`pre-wrap` for cards, addresses
  broken anywhere, titles cut with an ellipsis). In a PNG each glyph is an
  outline; in an SVG text stays text, with just the characters it uses
  embedded as WOFF2 fonts, so it can be selected and searched.
- The `sans` font is drawn with Inter, the font the web app uses for it.
  Only the scripts those fonts cover are drawn in a PNG: emoji and Chinese,
  Japanese or Korean characters have no glyphs in them, and are left out
  with their space kept. An SVG keeps them as text, and whatever shows it
  draws them with its own fonts.
- Shadows in an SVG are blur filters. In a PNG they are put together from
  blurred corners and gradients, as Skia draws box-shadows, within 2/255 of
  a true blur.
- Custom SVG icons, already sanitised when they were added, are drawn as
  images, so they cannot style or reach the drawing around them.
- A Kite card in preview mode is drawn as a card: its title and what kind of
  document it is, not the document inside it.
- The PNG is made with resvg (`@resvg/resvg-js`), in the server process.

The web app's e2e tests compare the PNG with a screenshot of the same canvas
in Chromium, and the SVG drawn by Chromium with the PNG, pixel by pixel.

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
