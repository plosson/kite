# Workspaces

Date: 2026-10-01
Status: approved design, awaiting spec review

## Goal

Let a person sort kites into one level of personal workspaces, and move a kite
between them by dragging it in the sidebar. When an assistant publishes a new
kite over MCP, it must choose a workspace from the workspace descriptions, or
ask the person.

## Decisions

| Question | Decision |
|---|---|
| Who owns a workspace? | One person. A workspace sorts that person's view only. Sharing stays per kite and does not change. |
| Can shared kites be placed? | Yes. Each person places a kite independently. The owner's placement and a reader's placement do not affect each other. |
| Can a kite be outside all workspaces? | No. Every person has a built-in **Inbox**. A kite with no placement is in Inbox. |
| Sidebar sections | Starred (unchanged), then Inbox, then workspaces. "Yours" and "Shared with you" are removed. |
| Can the model create workspaces? | Yes, but only after the person agrees to the name and description. |
| Order | Inbox first, then workspaces in alphabetical order (case-insensitive). No manual order. |
| Storage | A placement table. Inbox is the absence of a placement. |
| Channels | Web app and MCP. The CLI, the skill and the setup page do not change. |

## Data

New migration `packages/server/migrations/0013_workspaces.sql`, and matching
Drizzle definitions in `packages/server/src/db/schema.ts`.

### `workspaces`

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | `ws_` prefix, made the same way as other ids in `ids.ts` |
| `user_id` | text, not null | References `users.id`, on delete cascade |
| `name` | text, not null | 1 to 60 characters after trimming |
| `description` | text, not null | 1 to 500 characters after trimming |
| `created_at` | text, not null | |
| `updated_at` | text, not null | |

Index: unique on (`user_id`, `lower(name)`).

### `workspace_placements`

| Column | Type | Notes |
|---|---|---|
| `id` | text, primary key | |
| `user_id` | text, not null | References `users.id`, on delete cascade |
| `artifact_id` | text, not null | References `artifacts.id`, on delete cascade |
| `workspace_id` | text, not null | References `workspaces.id`, on delete cascade |
| `created_at` | text, not null | |

Indexes: unique on (`user_id`, `artifact_id`); index on `workspace_id`.

The cascades give these results with no extra code:

- Deleting a workspace deletes its placements. Its kites are then in Inbox.
- Deleting a kite deletes the placements that point at it.

Closing an account does not delete the `users` row
(`packages/server/src/auth/account-deletion.ts` keeps it, without identifying
data, so comments survive). The cascade from `users` therefore never runs.
Account deletion must delete the person's workspaces and placements explicitly,
in its existing transaction.

### Inbox

Inbox is not a row. Its id is the literal `inbox`, its name is `Inbox`, and its
description is fixed:

> Kites that are not sorted into a workspace yet.

The name `Inbox` is reserved. A workspace cannot be created or renamed to any
case variant of it.

### Lost access

A reader can lose access to a shared kite (unshare, expiry, deletion). The
placement row can stay. The listings only return kites the person can see, so a
kite they cannot see never shows in a workspace, and counts only include visible
kites.

## Server

### `WorkspaceService`

New file `packages/server/src/workspaces/service.ts`. The HTTP routes and the
MCP tools both use it. It does these things:

- `list(userId)` returns Inbox, then the workspaces in alphabetical order. Each
  entry has `id`, `name`, `description` and `count`. The count is the number of
  kites in the workspace that the person can see.
- `create(userId, { name, description })`
- `update(userId, workspaceId, { name?, description? })`
- `delete(userId, workspaceId)`
- `place(userId, artifactId, workspaceId)`. The id `inbox` deletes the
  placement. Any other id must be a workspace that the person owns.
- `resolve(userId, idOrName)` finds a workspace by id, or by name with case
  ignored. `inbox` and `Inbox` resolve to Inbox. MCP uses it.
- `placementsFor(userId)` returns a map from artifact id to workspace id, for the
  listings.

Validation errors:

| Case | Status | Message |
|---|---|---|
| Name or description empty or too long | 400 | Says which field and the limit |
| Name is a case variant of `Inbox` | 409 | `"Inbox" is built in. Choose another name.` |
| Name already used by this person, case ignored | 409 | `You already have a workspace called "<name>".` |
| Workspace id unknown, or owned by somebody else | 404 | Same message for both, so ids of other people's workspaces cannot be probed |
| Edit or delete of `inbox` | 400 | `Inbox is built in and cannot be changed.` |

### HTTP API

All routes need a signed-in user (`requireUser`).

| Method and path | Body | Result |
|---|---|---|
| `GET /api/workspaces` | | `{ workspaces: [{ id, name, description, count }] }`, Inbox first |
| `POST /api/workspaces` | `{ name, description }` | The new workspace |
| `PATCH /api/workspaces/:id` | `{ name?, description? }` | The changed workspace |
| `DELETE /api/workspaces/:id` | | `{ ok: true }` |
| `PUT /api/artifacts/:id/workspace` | `{ workspaceId }` | `{ workspaceId }` |

`PUT /api/artifacts/:id/workspace` needs only that the person can see the
artifact, the same rule as `PUT /api/artifacts/:id/star`.

`POST /api/artifacts` takes an optional `workspaceId`. When it is given, the new
kite is placed for its owner in the same transaction. An unknown id fails the
whole publish with 404, so no kite is created in the wrong place.

`PUT /api/artifacts/:id` (update) never changes a placement.

The two listings, `GET /api/artifacts` and `GET /api/shared-with-me`, add
`workspaceId` to each kite: the workspace id, or `inbox`. This follows the
`starred` field, which these listings already carry. The CLI also reads
`GET /api/artifacts` and ignores the extra field.

Shared types go in `packages/shared/src/api-types.ts`: `WorkspaceSummary`,
`ListWorkspacesResponse`, and the optional `workspaceId` on `ArtifactSummary`.
`packages/server/src/http/openapi.ts` documents the new routes.

## MCP

Changes in `packages/server/src/mcp/tools.ts`.

### `list_workspaces` (new)

Read-only. No arguments. Returns one line for each workspace, Inbox first:
id, name, kite count and description.

### `create_workspace` (new)

Arguments: `name` and `description`, both required. Not destructive, and not
idempotent. The description says:

> Create a workspace to sort kites into. Only call this after the user has
> agreed to the name and the description. The description is what you and other
> assistants read later to decide which kites belong in it, so write what goes
> in it, not what it is called.

### `publish_artifact` (changed)

New optional argument `workspace`: a workspace id or name, case ignored. `inbox`
is valid.

The description gains:

> Before publishing, call list_workspaces. Choose the workspace whose description
> fits this document. If none fits, or more than one could, ask the user and name
> the candidates. You can offer to create a new workspace, but only create it if
> they agree. Pass "inbox" when the user does not want it sorted. Tell the user
> which workspace you used.

The server enforces the choice:

- If the person has at least one workspace and `workspace` is missing, the call
  fails. The error repeats the instruction above and lists every workspace with
  its id, name and description.
- If the person has no workspaces, `workspace` is optional and the kite goes to
  Inbox.
- If `workspace` does not resolve, the call fails and lists the workspaces. No
  kite is created.

The success text adds a line: `workspace: <name>`.

### `list_artifacts` (changed)

Each kite line adds its workspace name, so the model can answer questions such as
"what is in my Research workspace?".

### Unchanged

`update_artifact` never moves a kite. There is no move tool. Moving is done in
the web app.

## Web app

### Sidebar (`packages/web/src/components/Sidebar.tsx`)

Order of sections:

1. Starred, unchanged.
2. Inbox.
3. Workspaces in alphabetical order.
4. A "New workspace" button.

Each workspace section:

- Can collapse. The collapsed set is kept in localStorage, in a try/catch, as the
  sidebar's own collapse state is.
- Shows its count.
- Lists the person's own kites and shared kites together, ordered as the listings
  order them today. A shared kite keeps its owner as the subtitle.
- Has a "…" menu on its header, except Inbox, with Edit and Delete.

The "Yours" and "Shared with you" sections are removed.

### Creating and editing

One dialog, built on the `Dialog` primitive, serves both create and edit. It has:

- A name field.
- A description field, required, with this hint: "Your assistant reads this to
  decide which new kites go here."

Server errors (duplicate name, reserved name) show under the field they concern.

### Deleting

A confirmation dialog: "Delete <name>? Its N kites move to Inbox. No kite is
deleted."

### Moving

- **Drag.** A kite row is draggable with native HTML drag and drop. Dropping it
  on a workspace header or in a workspace's list moves it. The target section is
  highlighted while a kite is over it. Dropping it on its own workspace does
  nothing.
- **Menu.** Each row has a "Move to…" control next to the star, shown on hover
  and on keyboard focus. It lists Inbox and the workspaces. This is the way to
  move on a phone or with a keyboard, where native drag does not work.
- Both are optimistic. The row moves at once. If the server refuses, it moves
  back and an error shows.

No new dependency.

### Dashboard (`packages/web/src/pages/Home.tsx`)

Shows the same grouping as the sidebar (Inbox, then workspaces) instead of
"Yours" and "Shared with you". It does not offer drag or the menu, which stay in
the sidebar.

### Data loading

The app loads `GET /api/workspaces` with the two listings, and refreshes it after
a create, an edit, a delete or a move. Grouping is done in the client from each
kite's `workspaceId`.

## Testing

Adversarial tests. None of them only checks the normal path.

### Server (`packages/server/test/workspaces.test.ts`)

- A person cannot place a kite they cannot see.
- A person cannot place a kite into another person's workspace. The status is
  404, the same as for an unknown id.
- A person cannot read, edit or delete another person's workspace.
- `Inbox`, `inbox` and `INBOX` are refused as names, on create and on rename.
- A duplicate name with different case is refused.
- An empty or too long name or description is refused.
- Deleting a workspace moves its kites to Inbox and deletes no kite.
- A reader's placement does not change the owner's, and the reverse.
- When a reader loses access to a shared kite, it no longer shows in their
  workspace and is not counted.
- Publishing with an unknown `workspaceId` creates no kite.
- Updating a kite does not change its placement.
- Deleting an account deletes its workspaces and placements.

### MCP (`packages/server/test/mcp-workspaces.test.ts`)

- `publish_artifact` without `workspace` fails when workspaces exist, and the
  error lists them with their descriptions.
- `publish_artifact` without `workspace` succeeds when there are none.
- An unknown workspace name fails and creates no kite.
- The name match ignores case.
- `create_workspace` refuses a duplicate name and the reserved name.

### Browser (`packages/e2e/tests/workspaces.spec.ts`)

- Dragging a kite to another workspace moves it, and the move survives a reload.
- The "Move to…" menu moves a kite without dragging.
- Deleting a workspace puts its kites in Inbox.
- A refused move puts the row back.

## Out of scope

- Nested workspaces.
- Workspaces shared with other people.
- Manual order of workspaces.
- CLI commands, skill text and setup page changes. The HTTP API accepts
  `workspaceId`, so the CLI can be added later.
- A move tool for MCP.
