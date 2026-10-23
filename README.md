# Kite

> **Kite is a modified version of [Open Artifact](https://github.com/iBala/open-artifact).**
> It is not the original product and is not endorsed by its authors. Kite is
> distributed free of charge, for non-commercial purposes, under the same
> [Sustainable Use License](LICENSE) as Open Artifact. It is source-available
> (fair-code), not OSI-approved open source. The changes made to it are recorded
> in this repository's git history.

Your coding agent writes a report, a design doc, a dashboard. Right now that
lands as a file on your laptop that nobody else can see.

Kite gives it a URL. The agent publishes, you get a link, you share it
with the people who need to read it. They comment on the exact paragraph they
are reacting to, and the agent reads those comments back and revises. You host
all of it yourself.

- **Publish from the agent.** With [agentio](https://github.com/plosson/agentio)
  from a terminal, or over MCP from Claude on the web or ChatGPT.
- **HTML and Markdown.** HTML runs in a sandbox with no access to your session.
  Markdown is rendered with headings, tables and syntax highlighting.
- **Share deliberately.** Private by default. Open it to named people, to
  everyone at your email domain, or to anyone with the link.
- **Comment on a specific line, or a specific element.** A Markdown comment
  holds the passage you selected; an HTML comment holds the element you selected,
  even though the page runs sandboxed. Both keep their position when the document
  is republished, and say so plainly when what they pointed at is gone.
- **Feedback loop.** The agent reads the comments back with the passage quoted —
  and for an HTML page, the element's own source and line numbers, so it changes
  the right bytes rather than guessing which part you meant.
- **Light and dark.** Follows your system by default, or pick one and it sticks.
  Readers with no account can change it too, from the bar above the document.

![A shared document with a line comment and a tagged reply](docs/comment-thread.png)

## Try it in two minutes

```bash
git clone https://github.com/plosson/kite.git
cd kite
pnpm install
pnpm --filter @open-artifact/server dev
```

Open http://localhost:3000. With no mail server configured, sign-in codes are
printed to the terminal, so you can sign in and click around without setting up
anything else.

## Run it for real

Everything you need is in `deploy/`.

```bash
cp deploy/env.example .env      # then fill in BASE_URL, SESSION_SECRET, SMTP
docker compose -f deploy/docker-compose.yml up -d
```

Two things to know before you go live:

**Put a reverse proxy in front of it.** The container binds to localhost only,
on purpose. Terminate TLS with Caddy, nginx or Traefik and forward to it.
Open documents follow changes over a long-lived stream
(`/api/artifacts/:id/events`, server-sent events with a heartbeat every 25
seconds). Caddy and Traefik pass it through as it is; nginx does too, because
the response says `X-Accel-Buffering: no`. Keep the proxy's read timeout above
a minute. Changes are announced inside the one server process, which is what
the single SQLite file already asks for: run one instance, not several.

**You need a mail server.** Sign-in codes and share notifications go out over
SMTP. Amazon SES, Postmark, Fastmail, your own — anything that speaks SMTP.
Without it, nobody can sign in.

Then prove the install works:

```bash
./deploy/smoke.sh https://artifacts.example.com
```

That signs in, publishes, checks the sandbox headers are really being sent,
shares, comments, republishes and confirms the comment kept its place. If it
passes, the instance is good.

### Who can sign up

`SIGNUP_MODE` decides. `invite-only` is the default: an account is created only
for someone an artifact was shared with. `domain-allowlist` opens it to listed
email domains. `open` lets anyone in. Every setting is explained in
`deploy/env.example`, and the server refuses to boot with a clear message if
something is missing or contradictory.

### Who opened it

The owner of a document can see who opened it: a count next to each of their
documents in the list, and a **Views** panel on the document itself. It answers
"did anybody read what I sent?", and it is careful about what it counts:

- A **view** is anybody opening the document in a browser, the owner included:
  reading what an agent produced for you is reading it. The panel and the API
  split views into yours and everybody else's, and show your own row as "You".
  A signed-in reader is shown by email. A signed-out reader of a public link is
  an anonymous id, a keyed hash of address and browser: the address itself is
  never stored.
- A document counts as read once anybody, you included, has opened its current
  version in a browser.
- Reads by agents (a command-line token or a connected assistant) are recorded
  beside the count, never inside it.
- The same reader opening the same version again within 30 minutes is one view.
- Records are deleted after `VIEW_RETENTION_DAYS` (180 by default), and with the
  document. Nobody but the owner can read them, and nothing leaves the instance.

Agents read the same numbers from `GET /api/artifacts/:id/views` (one document,
with each reader) and `GET /api/views` (every document, including which ones
have a current version nobody has opened). Both are documented at `/api/docs`.

### Version history

Every publish and every edit keeps the version before it. The owner of a
document can read them all back: click **History** on the document to list
every version, with when it was written and how often it was opened. Choose
one to read it as it was, under a banner that says "You're viewing version N
of M", with a **Changes** tab that shows the source diff against the version
before it and a **Back to latest** button. Nothing in history can be edited
or restored from the page; to bring an old version back, publish it again.

Past versions are the owner's alone. Somebody a document is shared with sees
the current version and nothing before it, because an old version may hold
exactly what the owner took out on purpose. Opening an old version counts as
a view of that version, by the same rules as above.

Agents use `GET /api/artifacts/:id/versions` (the list, without content) and
`GET /api/artifacts/:id/versions/:version` (one version, shaped like
`GET /api/artifacts/:id`), with the owner's token. agentio has
`agentio kite versions`, and the MCP endpoint has `list_artifact_versions` and
`get_artifact_version` for what the connection published.

## Connect your agent

Two ways in, depending on the assistant.

**Any terminal** (Claude Code, Codex, Cursor, and friends) — the command line
is [agentio](https://github.com/plosson/agentio). Hand your assistant one
sentence and let it set itself up:

> Set up Kite for me: read `https://kite.example.com/setup.md` and follow it.

Every instance serves its own `/setup.md`, pointing at itself. That page walks
the assistant through installing agentio, signing you in with
`agentio kite profile add`, and saving the skill `agentio skill kite` prints.

**No terminal** (Claude on the web, ChatGPT) — the hosted MCP endpoint. Add
`https://artifacts.example.com/mcp` as a custom connector in the app's
settings; the instance walks the connector through OAuth and shows a consent
page. A connection can publish, update and share its own documents and read
their comments — and deliberately cannot delete anything, make anything
public, or read documents other people shared with you. `MCP_DESIGN.md` has
the reasoning. Header-capable tools can skip OAuth: click your name at the
bottom of the sidebar to open "Where you are signed in", mint a token under
"Connect an assistant", and send it as `Authorization: Bearer …`.

## How the pieces fit

| Folder | What it is |
| --- | --- |
| `packages/server` | Hono API, SQLite via Drizzle, auth, sharing, comments |
| `packages/web` | React and Vite front end |
| `packages/shared` | Types and validation both sides use |
| `packages/e2e` | Playwright tests against a real browser |
| `deploy/` | Compose file, environment template, smoke test |

The database is one SQLite file. Back that file up and you have backed up the
whole instance. The compose file includes a nightly backup that uses SQLite's
own `.backup` command, not a file copy, because copying a live database gives
you a corrupt one.

## Working on it

```bash
pnpm install
pnpm test          # unit and integration
pnpm lint
pnpm typecheck
pnpm --filter @open-artifact/e2e test    # browser tests
```

Tests come first here. If you are adding behaviour, the test that describes it
should exist before the code that satisfies it.

## Found a bug, or want something?

Open an issue on GitHub: **[github.com/plosson/kite/issues](https://github.com/plosson/kite/issues)**.
Bug reports, feature requests and rough ideas are all welcome — that's where we
track what to build next.

## Licence

Kite is **fair-code**, under the [Sustainable Use License](LICENSE) it inherits
from Open Artifact — the same licence n8n uses. You can self-host and modify it
for free, including inside a company. You cannot sell it or run it as a
commercial hosted service. A commercial licence can only come from Open
Artifact's authors, at [hello@open-artifact.com](mailto:hello@open-artifact.com).
