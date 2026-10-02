/**
 * The dashboard.
 *
 * The same workspaces the sidebar holds, given room: Inbox first, then each
 * workspace in order. A list rather than cards, because these are documents
 * and a list is how you scan documents.
 */

import { type ArtifactSummary, type SharedArtifact, type WorkspaceSummary } from '../api.js';
import { Link } from '../router.jsx';
import { useAccount } from '../App.jsx';
import { Badge, EmptyState, RelativeTime } from '../components/primitives.js';
import { SetupGuide } from '../components/SetupGuide.js';
import { INBOX_ID, groupByWorkspace } from '../workspaces.js';
import { Timeline } from '../components/Timeline.js';
import { useState } from 'react';

type View = 'list' | 'timeline';
const VIEW_PREFERENCE = 'kite.home.view';

/** List or timeline, remembered in this browser. Private browsing forgets it, which is fine. */
function useView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_PREFERENCE) === 'timeline' ? 'timeline' : 'list';
    } catch {
      return 'list';
    }
  });
  function choose(next: View) {
    setView(next);
    try {
      localStorage.setItem(VIEW_PREFERENCE, next);
    } catch {
      // Not remembering is a small loss.
    }
  }
  return [view, choose];
}

export function Home({
  mine,
  shared,
  workspaces,
  loading,
  failed,
  onRetry,
}: {
  mine: ArtifactSummary[];
  shared: SharedArtifact[];
  workspaces: WorkspaceSummary[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { user } = useAccount();
  const notConnected = user.connectedApps.length === 0;
  const groups = groupByWorkspace(workspaces, mine, shared);
  const [view, setView] = useView();
  const descriptions = new Map([...mine, ...shared].map((artifact) => [artifact.id, artifact.description]));

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-9 max-md:px-4 max-md:py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[17px]">Artifacts</h1>
        <div role="group" aria-label="View" className="flex rounded-[--radius] border border-line p-0.5">
          {(['list', 'timeline'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`rounded-[--radius-sm] px-2.5 py-1 text-[12px] capitalize transition-colors ${
                view === option ? 'bg-sunken text-ink' : 'text-ink-3 hover:text-ink'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {view === 'timeline' && <Timeline descriptions={descriptions} />}

      {failed && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onRetry}
            className="text-[12.5px] text-accent hover:underline"
          >
            Could not load your artifacts. Try again.
          </button>
        </div>
      )}

      {view === 'list' && groups.map(({ workspace, artifacts }) => (
        <Group key={workspace.id} title={workspace.name}>
          {workspace.id === INBOX_ID && loading && mine.length === 0 && <LoadingRows />}
          {/* Somebody who has not connected an assistant gets the setup guide in
              place of an empty state: a person a document was shared with lands here
              signed in, and this is where they learn how to publish their own. Once
              connected, they see the ordinary empty state instead. */}
          {workspace.id === INBOX_ID && !loading && mine.length === 0 && notConnected && (
            <div className="mt-2">
              <SetupGuide
                instance={typeof window !== 'undefined' ? window.location.origin : ''}
                heading="Publish your own — paste this into your assistant"
                intro="You have not published anything yet. Copy this into Claude, Cursor, Codex or whatever you use, and it sets itself up."
              />
            </div>
          )}
          {workspace.id === INBOX_ID && !loading && mine.length === 0 && shared.length === 0 && !notConnected && (
            <EmptyState title="Nothing published yet">
              You are set up. Ask your assistant to publish a document, and it appears here.
            </EmptyState>
          )}
          {workspace.id !== INBOX_ID && artifacts.length === 0 && (
            <p className="py-2 text-[12.5px] text-ink-3">Nothing here yet. Drag a kite onto it in the sidebar.</p>
          )}
          {artifacts.map((artifact, index) => (
            <Row
              key={artifact.id}
              slug={artifact.slug}
              title={artifact.title}
              description={artifact.description}
              type={artifact.type}
              updatedAt={artifact.updatedAt}
              byline={artifact.ownerId === user.id ? undefined : (artifact.ownerName ?? artifact.ownerEmail ?? undefined)}
              trailing={artifact.isPublic === 1 ? <Badge tone="accent">Public</Badge> : null}
              index={index}
            />
          ))}
        </Group>
      ))}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
        {title}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Row({
  slug,
  title,
  description,
  type,
  updatedAt,
  byline,
  trailing,
  index,
}: {
  slug: string;
  title: string;
  /** One line from its publisher, shown under the title. Null on older documents. */
  description: string | null;
  type: 'markdown' | 'html';
  updatedAt: string;
  byline?: string;
  trailing?: React.ReactNode;
  index: number;
}) {
  return (
    <li
      className="oa-rise border-b border-line-2 last:border-0"
      // Rows land a beat apart, so a list reads as a list rather than appearing
      // all at once. Capped, or a long list would crawl in.
      style={{ animationDelay: `${Math.min(index, 6) * 25}ms` }}
    >
      <Link
        to={`/a/${slug}`}
        className="group flex items-center gap-3 rounded-[--radius-sm] px-1.5 py-2.5 transition-colors hover:bg-sunken"
      >
        <span
          aria-hidden="true"
          className="grid size-[18px] shrink-0 place-items-center rounded-[4px] border border-line text-[8px] font-bold uppercase text-ink-3"
        >
          {type === 'markdown' ? 'M' : 'H'}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink group-hover:text-accent">
            {title}
          </span>
          {description && (
            <span className="block truncate text-[12px] text-ink-3" title={description}>
              {description}
            </span>
          )}
          {byline && <span className="block truncate text-[11.5px] text-ink-3">{byline}</span>}
        </span>

        {trailing}

        <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">
          <RelativeTime iso={updatedAt} />
        </span>
      </Link>
    </li>
  );
}

/**
 * Placeholder rows, sized like the real thing.
 *
 * A spinner would say "wait". These say "a list is coming, roughly this shape",
 * and the page does not jump when the real rows replace them.
 */
function LoadingRows() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <li key={row} aria-hidden="true" className="border-b border-line-2 px-1.5 py-2.5">
          <span className="oa-breathe block h-[13px] w-48 rounded bg-line" />
        </li>
      ))}
    </>
  );
}

