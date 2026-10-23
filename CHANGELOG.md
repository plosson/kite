<!--
  This file is published as a public artifact:
  https://open-artifact.com/a/JzsDBQxEomM8N5F2BKm0yjVU

  To update the published page after editing this file:
    open-artifact publish CHANGELOG.md --id art_jS8W4fL4w8amDjGg

  Publishing without --id would create a second changelog on a new URL, and
  the one people have bookmarked would quietly stop being the current one.

  House style for this file:
  - Write each change as a user story: As a ROLE, I want GOAL, so that BENEFIT.
  - Use Simplified Technical English. Short sentences. Active voice. One idea
    per sentence. No idioms.
  - Diagrams are plain text in code fences. Images cannot be used: the renderer
    removes data: URLs and the page policy blocks remote images.
  - Keep diagrams narrower than 44 characters. Wider than that and the
    right-hand side is cut off in the reading column, and the reader has
    to scroll a code block sideways to find the label.

  Raw HTML is stripped when Markdown is rendered, so this note is invisible on
  the published page and visible to whoever edits the file. That is the point.
-->

# Changelog

This page lists the changes to Open Artifact. The newest change is first. Each
date is the day the change became available on open-artifact.com.

---

## Unreleased

### Edit a canvas in the browser

> **As an author,** I want to change my canvas on the page,
> **so that** I do not need an agent for small changes.

Open a canvas that you own. A toolbar is at the top left. Use it to add text,
links, Kite documents and groups. Drag a node to move it. Drag a group, and
the nodes inside it move with it. Drag a corner to resize a node. Drag from a
side of a node to another node to connect them. Double-click a line to label
it or to remove it. Press Delete to remove what you selected.

Press Ctrl+Z (Cmd+Z on a Mac) to undo. Undo takes back only your own change.
If an agent changed the same thing after you, Kite tells you and does not
undo.

### See what your agent adds

> **As an author,** I want to see the nodes that my agent adds,
> **so that** I do not need to search for them.

Your agent can now ask Kite to put a node next to another node. If it does
not ask, Kite puts the node next to the last thing that changed. When new
nodes arrive while you look at the canvas, Kite shows "1 new node · Show".
Click Show to go to them.

### See changes as they happen

> **As an author,** I want my open document to show my agent's changes at once,
> **so that** I do not need to reload the page.

An open document now follows changes as they are made. When your agent
changes a canvas, the new nodes are there at once, with "1 new node · Show".
New comments, a new title and new versions of Markdown and HTML documents
also arrive without a reload. Your own changes in the same tab are not shown
as new. A dot in the bar says "Live". When the connection drops, it says
"Reconnecting", and the page catches up when it is back. When the owner
removes your access, the page tells you that the document is not there.

When a new version of an HTML document arrives, the page stays where you
were reading. It does not go back to the top.

### See notifications as they arrive

> **As a reader,** I want the bell to show a new notification at once,
> **so that** I can answer a colleague without waiting.

The bell count changes when the notification arrives. If the panel is open,
the new notification appears in the list. A dot next to the bell shows that
the bell is live. When you read a notification in one tab, the count changes
in your other tabs too.

### Limits on open tabs

> **As an operator,** I want to limit how many live connections are open,
> **so that** one person cannot use all of the server.

Each open tab uses one live connection. Three settings limit them: per
person (`MAX_LIVE_STREAMS_PER_USER`, 20), per document
(`MAX_LIVE_STREAMS_PER_ARTIFACT`, 250) and in total (`MAX_LIVE_STREAMS`,
2000). When a person opens too many tabs, their oldest tab stops. That tab
says "Paused" and starts again when you go back to it. When a document or the
server is full, a new tab waits and tries again later.

### Comment on a node

> **As a reader,** I want to comment on one card of a canvas,
> **so that** my comment is about that card.

Select a node and click Comment. A marker on the node shows the number of
comments. The marker turns orange when the node changes after the comment.
When the node is deleted, the canvas tells you that the comment lost its
node.

### See and restore old versions of a canvas

> **As an author,** I want to see an old version of my canvas as a canvas,
> **so that** I can see what it looked like.

In History, an old version of a canvas now shows as a canvas. Click Changes
to see what changed: new nodes are green, changed nodes are orange and
removed nodes are faded red. Click "Restore this version" to make the old
version current again. Kite saves this as a new version, so you lose
nothing.

### Large canvases stay fast

> **As an author,** I want a canvas with thousands of nodes to move smoothly,
> **so that** I can work on a large map.

Kite does not draw nodes that are off the screen. When you zoom out, cards
become simple boxes and labels go. On large canvases, lines go too. A large
canvas opens close enough that only part of it is drawn.

---

## 23 October 2026 (1.3.0)

### See every version of a document

> **As an author,** I want to see the earlier versions of my document,
> **so that** I know what changed and when.

Open one of your documents and click **History**. The panel shows each
version. The newest version is first. For each version, it shows:

- The version number and the title at that time.
- When the version was written.
- How many times people opened that version. Your opens are included.

Click a version to read it. A banner tells you which version you see:

```
You're viewing version 1 of 3.
[Document] [Changes] [Back to latest]
```

- **Document** shows the version as readers saw it. You cannot edit it.
- **Changes** shows the lines that were added and removed since the
  version before it.
- **Back to latest** shows the current version again.

Only you can see the earlier versions. People you share the document with
see only the current version. An earlier version can contain text that you
removed on purpose.

When you open an earlier version, it counts as a view of that version.

### Agents can read earlier versions

> **As an author,** I want my agent to read the earlier versions,
> **so that** it can compare them or bring back old text.

The API has two new endpoints. They work only for the owner:

- `GET /api/artifacts/:id/versions` lists the versions.
- `GET /api/artifacts/:id/versions/:version` gives one version with its
  content.

Connected assistants have two new tools: `list_artifact_versions` and
`get_artifact_version`. They work on the documents that the assistant
published.

---

## 23 October 2026 (1.2.1)

### Your own opens count as views

> **As an author,** I want my own opens to count as views, **so that** I know
> how many times I read a document that an agent made for me.

Before, Views did not count your own opens. Now each time you open your
document in a browser, it is a view.

- The count in your list includes your opens.
- The Views panel shows your row as "You". It shows how many views are yours
  and how many are from other people.
- "Unread" goes away when anybody opens the newest version. This includes you.

Reads by agents are still not views. The panel still shows them separately.

Opens that you made before this change are already in the count.

---

## 23 October 2026

### See who opened a document

> **As an author,** I want to see who opened my document, **so that** I know
> if the people I sent it to read it.

Open one of your documents and click **Views**. The panel shows:

- How many times other people opened it.
- How many different people that was.
- Each person who opened it, how they got in, and the last version they saw.
- If nobody has opened the current version yet.

Your list of documents shows the count next to each one. "Unread" means that
nobody opened the newest version.

```
  Launch plan          3 views  2 hours ago
  Board notes  Unread  1 view   yesterday
```

Some opens are not counted as views:

- Your own opens.
- Reads by agents, for example agentio or a connected assistant.

The panel shows these two numbers separately.

A person who is not signed in shows as "Anonymous" with a short id. Open
Artifact does not store their IP address. Only you can see this information.
Open Artifact deletes it after 180 days. The operator can change this period.

---

## 31 August 2026

### Edit a block as you read it

> **As an author,** I want to edit a block and see the result as I type, **so
> that** I do not need to know Markdown syntax to correct a sentence.

Before, a click opened a box of Markdown source. Now a click opens rich text.

```
  BEFORE — you read the syntax
  ┌───────────────────────┐
  │ ## Q3 review          │
  │                       │
  │ Revenue is **up 18%** │
  │ on the quarter.       │
  └───────────────────────┘

  NOW — you read the text
  ┌───────────────────────┐
  │ Q3 review             │ <- large
  │                       │
  │ Revenue is up 18%     │ <- bold
  │ on the quarter.       │
  └───────────────────────┘
```

What you can do:

- Select text. A small toolbar appears. Use it for bold, italic, code and
  links.
- Type `/` at the start of a line. A menu shows the block types by name. Choose
  a heading, a list, a quote, a table or a code block.
- Edit a table as a grid. You do not type pipe characters.

Some blocks stay as Markdown. These blocks hold footnotes, reference links or
raw HTML. The rich editor cannot show these correctly. Open Artifact keeps them
as source text so that your document does not lose them.

Open Artifact rewrites only the block that you click. The rest of the document
stays the same, byte for byte.

```
  document.md
  ┌─────────────────────┐
  │ block 1  unchanged  │
  │ block 2  YOU EDIT   │ <- only this
  │ block 3  unchanged  │    one is
  │ block 4  unchanged  │    written
  └─────────────────────┘
```

### Keep your place when you save

> **As an author,** I want the page to stay still when I save, **so that** I do
> not lose my position in a long document.

Before, a save cleared the page and drew it again. The page returned to the
top. If you corrected a word near the end, you had to scroll back down.

Now the document stays on the screen while Open Artifact loads the new version.
Your position does not change.

### See what a link points to

> **As a person who receives a link,** I want the preview to tell me what the
> document is, **so that** I know whether to open it.

Before, every artifact link showed the same preview card. Now the card
describes the document.

```
  PUBLIC
  ┌────────────────────────┐
  │ Q3 review              │
  │ Revenue is up 18% on   │
  │ the quarter.           │
  └────────────────────────┘
   the title and first line

  PRIVATE
  ┌────────────────────────┐
  │ A private artifact     │
  │ Sign in to open it.    │
  └────────────────────────┘
   nothing about the document

  EXPIRED
  ┌────────────────────────┐
  │ This link has expired  │
  │ Ask for a new one.     │
  └────────────────────────┘
```

A private artifact shows no title and no content. Link previews are made by
services that are not signed in. Anything the card shows is shown to every
person who can see the message.

---

## 14 August 2026

> **As a new user,** I want to know what I agree to, **so that** I can decide
> before I sign in.

- The sign-in page states the terms.
- The project logo is available in the sizes that app directories require.

---

## 13 August 2026

> **As a Claude Code user,** I want to install the skill as a plugin, **so that**
> I do not have to install it by hand.

- Claude Code installs the Open Artifact skill as a plugin.
- Each MCP tool states what it will do before it does it.
- Each instance states what it does with your information.

---

## 7 August 2026

> **As a person who shares a document,** I want the link to stop working after a
> date, **so that** access does not continue after the work is finished.

- Set an expiry date on a shared link.
- A person who opens an expired link sees a clear message and a way to ask for
  a new link.
- A change to the date does not move the date while another person is choosing
  one.

---

## 5 August 2026

> **As an author,** I want the editor to keep my text, **so that** I do not lose
> my work.

- The editor no longer loses text that you type.
- The editor no longer puts the text of one block into another block.

---

## 4 August 2026

> **As an author,** I want to correct a document on the page, **so that** I do
> not have to publish the file again to fix one word.

- Edit a Markdown artifact on the page, one block at a time.
- The edit control is in the top bar. The reading area stays clear.

---

## 1 August 2026

> **As an author,** I want my assistant to read the comments, **so that** it can
> correct the document for me.

```
  reader       agent       document
    │            │             │
    │ comments   │             │
    ├───────────>│             │
    │            │ reads them  │
    │            ├────────────>│
    │            │ publishes   │
    │            ├────────────>│
```

- An assistant reads the comments on a document and publishes a new version.
- The page stays still while you read it.
- When you open a comment, the page moves to the text that the comment is
  about.

---

## 29 July 2026

> **As an agent,** I want to read an artifact, **so that** I can revise a
> document that I published before.

- An agent reads an artifact. Before, an agent could only publish one.

---

## 26 July 2026

> **As a reader,** I want to choose light or dark, **so that** the page suits the
> room that I am in.

- Choose light or dark. Before, the page used the setting of your computer.

---

## 24 July 2026

> **As a new user,** I want instructions for the tool that I use, **so that** I
> can start quickly.

- The home page is a setup guide. Choose your tool and follow the steps.
- A free Cloud plan is available. You do not have to run a server.
- `/llms.txt` describes the product to a language model.
- Link previews show an image.

---

## 23 July 2026

> **As a person who uses an assistant in a browser,** I want to connect it
> without a terminal, **so that** I can publish from the tool that I already
> use.

```
  terminal assistant ─┐
   (command line)     │
                      ├──> Open Artifact
  browser assistant  ─┘
   (MCP + OAuth)
```

- Connect a browser assistant with the hosted MCP endpoint and OAuth.
- Mention a person by email in a comment. Open Artifact tells you what the
  mention did.
- Add a star to an artifact. Starred artifacts have their own list in the
  sidebar.
- Sign in from the terminal with a code that you receive by email.
- Make Open Artifact the default for documents. The setup asks you first.
- The command line tells you when a new version is available.
- The address is now open-artifact.com. Old links continue to work.

---

## 22 July 2026 — first release

> **As a person who works with an AI assistant,** I want to give its work a URL,
> **so that** other people can read it and comment on it.

```
  your assistant
        │ publishes
        v
    artifact ──share──> reader
        ^                  │
        └─────revises──────┘
             (comments)
```

- Publish HTML and Markdown from the command line. Update what you published.
- Share with one person, with everybody at a company domain, or with a public
  link.
- Add a comment to a passage. The comment stays with that passage when the
  document changes. If the passage is removed, the comment says that it lost
  its position. It does not move to different text without telling you.
- Mention a person. That person receives a notification.
- Delete your account and everything in it.
- Sign in on the web. See your documents. Remove access from a computer that
  you no longer use.
- A public artifact shows a caution to a reader who is not the author.
- A link that leaves a public artifact shows a warning page first.
