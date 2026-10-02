/**
 * The sidebar, and the frame around every signed-in screen.
 *
 * It holds what you published and what other people shared with you, so moving
 * between documents never needs a trip back to a dashboard.
 *
 * It collapses to a thin rail when an artifact is open, because somebody who
 * followed a link came to read one document, not to browse. The rail is still a
 * target: one click brings the sidebar back. That choice is remembered per
 * person, so somebody who prefers it open keeps it open.
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '../router.jsx';
import { useAccount } from '../App.jsx';
import { type ArtifactSummary, type SharedArtifact, type WorkspaceSummary } from '../api.js';
import { Spinner } from './primitives.js';
import { NotificationsButton, NotificationsPanel } from './Notifications.js';
import { endpoints } from '../api.js';
import { useStars } from '../stars.js';
import { ThemeControl } from './ThemeControl.js';
import { groupByWorkspace, INBOX_ID, type ListedArtifact } from '../workspaces.js';
import { WorkspaceDialog, MoveDialog } from './WorkspaceDialogs.js';
import { useNarrowScreen } from '../viewport.js';
import { SlidingTitle } from './SlidingTitle.js';
import { KITE_VERSION } from '../version.js';

const COLLAPSE_PREFERENCE = 'oa.sidebar.collapsed';
const DRAG_TYPE = 'application/x-kite-artifact';

export interface SidebarData {
  mine: ArtifactSummary[];
  shared: SharedArtifact[];
  workspaces: WorkspaceSummary[];
  loading: boolean;
  /** Moves a kite into a workspace, or back to "inbox". Optimistic. */
  onMove: (artifactId: string, workspaceId: string) => void;
  /** After a workspace is created, changed or deleted. */
  onWorkspacesChanged: () => void;
  /** Set when the server refused the last move. */
  moveError: string | null;
  onDismissMoveError: () => void;
}

export function AppFrame({
  data,
  children,
  /** True on an artifact page, where the sidebar starts collapsed. */
  focusMode = false,
}: {
  data: SidebarData;
  children: React.ReactNode;
  focusMode?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(focusMode));
  const narrow = useNarrowScreen();
  // On a phone the sidebar is a drawer over the page, never beside it: there is
  // no room for both. It starts closed every time and is not remembered, so the
  // desktop preference is left alone.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { path } = useRouter();

  // Choosing somewhere to go is the end of what the drawer was opened for.
  useEffect(() => setDrawerOpen(false), [path]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  // Following a link into an artifact collapses the sidebar; going back to the
  // dashboard opens it again. Somebody who has set a preference keeps it.
  useEffect(() => {
    if (readPreference() !== null) return;
    setCollapsed(focusMode);
  }, [focusMode]);

  function toggle() {
    setCollapsed((wasCollapsed) => {
      const next = !wasCollapsed;
      try {
        localStorage.setItem(COLLAPSE_PREFERENCE, String(next));
      } catch {
        // Private browsing refuses this. Not remembering is a small loss.
      }
      return next;
    });
  }

  // One tree for both widths, with the page always in the same place in it, so
  // crossing the breakpoint — turning a tablet — does not remount the page and
  // throw away whatever was being typed into it.
  return (
    <DrawerContext.Provider value={narrow ? () => setDrawerOpen(true) : null}>
      <div className="flex min-h-dvh">
        {!narrow && <Sidebar data={data} collapsed={collapsed} onToggle={toggle} />}
        <div className="min-w-0 flex-1">
          {/* An artifact has its own bar to carry the menu button. Every other
              screen gets this one on a phone, or there would be no way in. */}
          {narrow && !focusMode && (
            <header className="flex h-11 items-center gap-1 border-b border-line px-2">
              <SidebarButton />
              <Link to="/" className="px-1.5 py-1 text-[13px] font-semibold tracking-[-0.02em] text-ink">
                Kite
              </Link>
            </header>
          )}
          {children}
        </div>
      </div>

      {narrow && drawerOpen && (
        <div className="fixed inset-0 z-40">
          <div
            aria-hidden="true"
            className="oa-fade absolute inset-0 bg-black/25"
            onClick={() => setDrawerOpen(false)}
          />
          <Sidebar data={data} collapsed={false} onToggle={() => setDrawerOpen(false)} drawer />
        </div>
      )}
    </DrawerContext.Provider>
  );
}

/** Opens the drawer on a phone. Null anywhere the drawer is not in play. */
const DrawerContext = createContext<(() => void) | null>(null);

/**
 * The way into the sidebar on a phone, for a screen's own header to carry. It
 * draws nothing on a wider screen, or outside the signed-in frame, where the
 * sidebar is already there or does not exist.
 */
export function SidebarButton() {
  const openDrawer = useContext(DrawerContext);
  if (!openDrawer) return null;

  return (
    <button
      type="button"
      onClick={openDrawer}
      aria-label="Show sidebar"
      aria-expanded={false}
      className="grid size-8 shrink-0 place-items-center rounded-[--radius-sm] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
    >
      <PanelIcon />
    </button>
  );
}

function initialCollapsed(focusMode: boolean): boolean {
  return readPreference() ?? focusMode;
}

function readPreference(): boolean | null {
  try {
    const stored = localStorage.getItem(COLLAPSE_PREFERENCE);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

function Sidebar({
  data,
  collapsed,
  onToggle,
  drawer = false,
}: {
  data: SidebarData;
  collapsed: boolean;
  onToggle: () => void;
  /** Drawn over the page from the left edge, on a phone. */
  drawer?: boolean;
}) {
  const { path } = useRouter();
  const { user } = useAccount();
  const stars = useStars();
  const [collapsedWorkspaces, toggleWorkspace] = useCollapsedWorkspaces();
  const [editing, setEditing] = useState<{ workspace: WorkspaceSummary | null } | null>(null);
  const [moving, setMoving] = useState<ListedArtifact | null>(null);
  const groups = groupByWorkspace(data.workspaces, data.mine, data.shared);
  // Only somebody who has not connected an assistant yet gets the nudge.
  const notConnected = user.connectedApps.length === 0;

  // The starred section draws from both lists: you can star what you own and
  // what was shared with you. Shown only when something is starred, so somebody
  // who never stars is not given an empty header to wonder about. A shared
  // artifact keeps its owner subtitle here too, so it reads the same as below.
  const starred = [
    ...data.mine.map((artifact) => ({ artifact, subtitle: undefined as string | undefined })),
    ...data.shared.map((artifact) => ({
      artifact,
      subtitle: artifact.ownerName ?? artifact.ownerEmail ?? undefined,
    })),
  ].filter((entry) => stars.isStarred(entry.artifact.id));

  if (collapsed) {
    return (
      <aside className="sticky top-0 z-10 flex h-dvh w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Show sidebar"
          aria-expanded={false}
          className="grid size-7 place-items-center rounded-[--radius-sm] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
        >
          <PanelIcon />
        </button>
      </aside>
    );
  }

  return (
    // z-10: the notifications panel pops out of this sidebar over the content
    // area. Without an explicit order on the aside, a content row that happens
    // to sit under the panel can win the paint order and swallow its clicks —
    // found when a taller setup guide pushed a row under "Mark all read".
    <aside
      className={[
        'oa-fade flex h-dvh shrink-0 flex-col border-r border-line bg-canvas',
        drawer
          ? 'absolute left-0 top-0 w-[min(300px,85vw)] shadow-[--shadow-dialog]'
          : 'sticky top-0 z-10 w-[228px]',
      ].join(' ')}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 px-2.5">
        <div className="flex min-w-0 items-baseline gap-1">
          <Link
            to="/"
            className="rounded-[--radius-sm] px-1.5 py-1 text-[13px] font-semibold tracking-[-0.02em] text-ink transition-colors hover:bg-sunken"
          >
            Kite
          </Link>
          {/* Quiet on purpose: there for whoever needs to say which Kite they are on. */}
          <span className="text-[10.5px] tabular-nums text-ink-3 opacity-70 select-none" title={`Kite ${KITE_VERSION}`}>
            v{KITE_VERSION}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Hide sidebar"
          aria-expanded
          className="grid size-7 place-items-center rounded-[--radius-sm] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
        >
          <PanelIcon />
        </button>
      </div>

      <nav className="oa-scroll flex-1 overflow-y-auto px-2 pb-3">
        {/* An obvious way in for somebody who has not connected an assistant yet
            — usually a person a document was shared with. Styled to catch the eye
            the way a "new feature" highlight does, and it goes to the setup guide.
            Gone the moment they connect one. */}
        {notConnected && <PublishHighlight />}

        {starred.length > 0 && (
          <Section title="Starred" count={starred.length} loading={false}>
            {starred.map(({ artifact, subtitle }) => (
              <ArtifactLink
                key={artifact.id}
                to={`/a/${artifact.slug}`}
                title={artifact.title}
                subtitle={subtitle}
                active={path === `/a/${artifact.slug}`}
                type={artifact.type}
                starred
                onToggleStar={() => stars.toggle(artifact.id)}
              />
            ))}
          </Section>
        )}

        {groups.map(({ workspace, artifacts }) => (
          <WorkspaceSection
            key={workspace.id}
            workspace={workspace}
            collapsed={collapsedWorkspaces.has(workspace.id)}
            onToggle={() => toggleWorkspace(workspace.id)}
            onDropArtifact={(artifactId) => {
              const current = [...data.mine, ...data.shared].find((a) => a.id === artifactId);
              if ((current?.workspaceId ?? INBOX_ID) !== workspace.id) data.onMove(artifactId, workspace.id);
            }}
            onEdit={workspace.id === INBOX_ID ? undefined : () => setEditing({ workspace })}
            loading={workspace.id === INBOX_ID && data.loading}
          >
            {artifacts.map((artifact) => (
              <ArtifactLink
                key={artifact.id}
                artifactId={artifact.id}
                to={`/a/${artifact.slug}`}
                title={artifact.title}
                subtitle={artifact.ownerId === user.id ? undefined : (artifact.ownerName ?? artifact.ownerEmail ?? undefined)}
                active={path === `/a/${artifact.slug}`}
                type={artifact.type}
                starred={stars.isStarred(artifact.id)}
                onToggleStar={() => stars.toggle(artifact.id)}
                onRequestMove={() => setMoving(artifact)}
              />
            ))}
            {!data.loading && artifacts.length === 0 && (
              <Nothing>
                {workspace.id === INBOX_ID && data.mine.length === 0 && data.shared.length === 0
                  ? 'Nothing published yet'
                  : 'Drop a kite here'}
              </Nothing>
            )}
          </WorkspaceSection>
        ))}

        <button
          type="button"
          onClick={() => setEditing({ workspace: null })}
          className="mt-3 flex w-full items-center gap-1.5 rounded-[--radius-sm] px-1.5 py-1 text-[12px] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
        >
          <span aria-hidden="true">+</span> New workspace
        </button>

        {data.moveError && (
          <p role="alert" className="mt-2 px-1.5 text-[12px] text-danger">
            {data.moveError}{' '}
            <button type="button" className="underline" onClick={data.onDismissMoveError}>
              Dismiss
            </button>
          </p>
        )}
      </nav>

      <AccountRow />

      <WorkspaceDialog
        open={editing !== null}
        workspace={editing?.workspace ?? null}
        onClose={() => setEditing(null)}
        onSaved={data.onWorkspacesChanged}
      />
      <MoveDialog
        artifact={moving}
        workspaces={groups.map((group) => group.workspace)}
        onClose={() => setMoving(null)}
        onMove={data.onMove}
      />
    </aside>
  );
}

function Section({
  title,
  count,
  loading,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-3 first:mt-1">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          {title}
        </h2>
        {loading ? (
          <Spinner className="text-ink-3" />
        ) : (
          count > 0 && <span className="text-[11px] tabular-nums text-ink-3">{count}</span>
        )}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

const WORKSPACES_COLLAPSED = 'oa.sidebar.workspaces.collapsed';

/** The ids of the workspace sections this person has folded, remembered across visits. */
function useCollapsedWorkspaces(): [Set<string>, (id: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(WORKSPACES_COLLAPSED);
      return new Set(stored ? (JSON.parse(stored) as string[]) : []);
    } catch {
      return new Set();
    }
  });

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(WORKSPACES_COLLAPSED, JSON.stringify([...next]));
      } catch {
        // Private browsing refuses this. Not remembering is a small loss.
      }
      return next;
    });
  }

  return [collapsed, toggle];
}

/**
 * One workspace in the sidebar, and a place to drop a kite.
 *
 * The whole section is the drop target, header included, so a kite can be
 * dropped on a folded workspace as easily as an open one.
 */
function WorkspaceSection({
  workspace,
  collapsed,
  onToggle,
  onDropArtifact,
  onEdit,
  loading = false,
  children,
}: {
  workspace: WorkspaceSummary;
  collapsed: boolean;
  onToggle: () => void;
  onDropArtifact: (artifactId: string) => void;
  /** Left out for Inbox, which cannot be edited. */
  onEdit?: () => void;
  loading?: boolean;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);

  return (
    <section
      data-workspace-id={workspace.id}
      className={[
        'mt-3 rounded-[--radius-sm] transition-colors first:mt-1',
        over ? 'bg-sunken ring-1 ring-line' : '',
      ].join(' ')}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(event) => {
        // Leaving for a child is not leaving the section.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        const artifactId = event.dataTransfer.getData(DRAG_TYPE);
        if (!artifactId) return;
        event.preventDefault();
        onDropArtifact(artifactId);
      }}
    >
      <div className="group/header flex items-center gap-1 px-1.5 py-1">
        {/* The heading for screen readers wraps the toggle, rather than sitting
            inside it: a heading inside a button is not a heading at all, since
            an interactive descendant has no accessible role of its own there. */}
        <h2 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={workspace.description || undefined}
            className="flex w-full items-center gap-1.5 text-left"
          >
            <Chevron open={!collapsed} />
            <span className="truncate">{workspace.name}</span>
            {loading ? (
              <Spinner className="text-ink-3" />
            ) : (
              workspace.count > 0 && <span className="tabular-nums">{workspace.count}</span>
            )}
          </button>
        </h2>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit workspace ${workspace.name}`}
            className="grid size-5 shrink-0 place-items-center rounded-[--radius-xs] pointer-coarse:size-8 text-ink-3 opacity-0 transition hover:text-ink focus-visible:opacity-100 group-hover/header:opacity-100 pointer-coarse:opacity-100"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="12.5" cy="8" r="1.2" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && <div className="flex flex-col">{children}</div>}
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 10 10"
      aria-hidden="true"
      className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ArtifactLink({
  to,
  title,
  subtitle,
  active,
  type,
  starred = false,
  onToggleStar,
  artifactId,
  onRequestMove,
}: {
  to: string;
  title: string;
  subtitle?: string;
  active: boolean;
  type: 'markdown' | 'html';
  starred?: boolean;
  /** Left out for a row that has no star control, like a loading placeholder. */
  onToggleStar?: () => void;
  /** Left out for a row that cannot be dragged, like a starred placeholder. */
  artifactId?: string;
  /** Left out where there is no dialog to open, such as the Starred section. */
  onRequestMove?: () => void;
}) {
  return (
    <Link
      to={to}
      data-artifact-id={artifactId}
      draggable={artifactId !== undefined}
      onDragStart={(event: React.DragEvent) => {
        if (!artifactId) return;
        event.dataTransfer.setData(DRAG_TYPE, artifactId);
        event.dataTransfer.effectAllowed = 'move';
      }}
      className={[
        'group flex items-center gap-2 rounded-[--radius-sm] px-1.5 py-[5px] transition-colors pointer-coarse:py-1',
        active ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <TypeIcon type={type} />
      <span className="min-w-0 flex-1">
        <SlidingTitle text={title} className="text-[12.5px] leading-[1.35]" />
        {subtitle && <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>}
      </span>
      {onRequestMove && <MoveButton title={title} onClick={onRequestMove} />}
      {onToggleStar && <StarToggle starred={starred} onToggle={onToggleStar} />}
    </Link>
  );
}

/**
 * Moving without dragging, for a phone or a keyboard. Like the star, it sits in
 * the row's link, so the click is stopped before the link follows it; and it
 * only opens the dialog, which is drawn outside every row so its own clicks
 * never reach a link.
 */
function MoveButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Move “${title}”`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className="grid size-5 shrink-0 place-items-center rounded-[--radius-xs] pointer-coarse:size-8 text-ink-3 opacity-0 transition hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M6.5 9.25h4M8.75 7.5l1.75 1.75-1.75 1.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/**
 * The star on a sidebar row. It lives inside the row's link, so a click on it
 * must not also follow the link — hence stopping the event before the anchor
 * sees it. A set star is always shown; an unset one appears on hover, so a row
 * stays quiet until you reach for it.
 */
function StarToggle({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={starred ? 'Remove star' : 'Star this'}
      aria-pressed={starred}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={[
        'grid size-5 shrink-0 place-items-center rounded-[--radius-xs] pointer-coarse:size-8 transition',
        starred
          ? 'opacity-100'
          : 'text-ink-3 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100',
      ].join(' ')}
      style={starred ? { color: 'oklch(74% 0.15 78)' } : undefined}
    >
      <StarIcon filled={starred} />
    </button>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      aria-hidden="true"
    >
      <path
        d="M8 1.8l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 10.79l-3.52 1.85.67-3.92L2.3 5.94l3.94-.57L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[12px] text-ink-3">{children}</p>;
}

/** The catch-the-eye "get started" card at the top of the sidebar. */
function PublishHighlight() {
  return (
    <Link
      to="/"
      className="oa-rise mx-0.5 mb-2 mt-1 flex items-start gap-2 rounded-[--radius] bg-accent-wash px-2.5 py-2 text-accent transition-opacity hover:opacity-85"
    >
      <SparkIcon />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-ink">Publish your own</span>
        <span className="block text-[11px] leading-snug text-ink-2">
          Set up your assistant in a minute →
        </span>
      </span>
    </Link>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-[3px] shrink-0">
      <path
        d="M8 1.3l1.5 4 4 1.5-4 1.5L8 12.3 6.5 8.3l-4-1.5 4-1.5z"
        fill="currentColor"
      />
    </svg>
  );
}

function AccountRow() {
  const { user, signOut } = useAccount();
  const { navigate, path } = useRouter();
  const [bellOpen, setBellOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Polled rather than pushed. A live connection for a count that changes a few
  // times a day is a lot of moving parts to keep working; a request every half
  // minute is not.
  useEffect(() => {
    let alive = true;

    const check = () => {
      endpoints
        .notifications()
        .then((response) => alive && setUnread(response.unread))
        .catch(() => undefined);
    };

    check();
    const timer = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bellOpen]);

  // The settings menu closes when you click away from it or press Escape, the
  // way a menu is expected to. Bound only while it is open.
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="relative shrink-0 border-t border-line p-2">
      <NotificationsButton
        unread={unread}
        open={bellOpen}
        onToggle={() => setBellOpen((wasOpen) => !wasOpen)}
      />

      {bellOpen && (
        <NotificationsPanel
          onCountChanged={setUnread}
          onClose={() => setBellOpen(false)}
          onOpenArtifact={(slug, threadId) => {
            navigate(threadId ? `/a/${slug}?thread=${threadId}` : `/a/${slug}`);
          }}
        />
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigate('/settings/sessions')}
          className={[
            'flex min-w-0 flex-1 items-center gap-2 rounded-[--radius-sm] px-1.5 py-1.5 text-left transition-colors',
            path.startsWith('/settings') ? 'bg-sunken' : 'hover:bg-sunken',
          ].join(' ')}
        >
          <Avatar email={user.email} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
            {user.displayName ?? user.email}
          </span>
        </button>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={[
              'grid size-7 place-items-center rounded-[--radius-sm] transition-colors',
              menuOpen ? 'bg-sunken text-ink' : 'text-ink-3 hover:bg-sunken hover:text-ink',
            ].join(' ')}
          >
            <GearIcon />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="oa-pop absolute bottom-[calc(100%+6px)] right-0 z-20 w-44 overflow-hidden rounded-[--radius] border border-line bg-surface py-1 shadow-[--shadow-pop]"
            >
              {/* Not a menu item: it is a setting you change in place. Pressing
                  one of the three should not also close what you are standing
                  in, so this row is left out of the menu's own semantics. */}
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="text-[12.5px] text-ink-2">Theme</span>
                <ThemeControl />
              </div>
              <div className="my-1 border-t border-line-2" />

              <a
                role="menuitem"
                href="https://github.com/plosson/kite/issues"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              >
                <MailIcon />
                Support
              </a>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              >
                <SignOutIcon />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.4 4.6L8 8.6l5.6-4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.25 2.75H3.75A1.25 1.25 0 0 0 2.5 4v8a1.25 1.25 0 0 0 1.25 1.25h2.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path d="M9.5 5.5L12.5 8l-3 2.5M12.25 8H6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Initials on a colour derived from the address, so the same person is the same
 * colour on every machine without anybody uploading a picture.
 */
export function Avatar({ email, size = 20 }: { email: string; size?: number }) {
  let hash = 0;
  for (const character of email) hash = (hash * 31 + character.charCodeAt(0)) % 360;

  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `oklch(58% 0.12 ${hash})`,
      }}
    >
      {email.slice(0, 1).toUpperCase()}
    </span>
  );
}

function TypeIcon({ type }: { type: 'markdown' | 'html' }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded-[3px] border border-line text-[7px] font-bold uppercase tracking-tight text-ink-3"
    >
      {type === 'markdown' ? 'M' : 'H'}
    </span>
  );
}

/** A window with a pane down one side: the side the panel it toggles sits on. */
export function PanelIcon({ side = 'left' }: { side?: 'left' | 'right' }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d={side === 'left' ? 'M6.25 2.75v10.5' : 'M9.75 2.75v10.5'}
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}
