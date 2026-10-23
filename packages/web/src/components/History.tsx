/**
 * A document's version history, for its owner.
 *
 * Two pieces. The dialog lists every version, newest first, with when it was
 * written and how often it was opened. Choosing one hands it to the page,
 * which swaps the document for `PastVersion`: that version, read-only, under a
 * banner that says which version this is and offers the way back, with a tab
 * for what changed since the version before it.
 *
 * Opening a version is reading it, so its fetch is counted against that
 * version, like any other open. The version before it is fetched only to
 * diff against, and says so (`record: false`), so comparing is never counted
 * as having read the older one.
 *
 * Nothing here edits. Restoring a version is a new publish, and is left to the
 * owner's agent: read the version, publish it again.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  endpoints,
  type ArtifactVersionDetail,
  type ArtifactVersionsResponse,
  type ArtifactVersionSummary,
} from '../api.js';
import { Badge, Button, Dialog, RelativeTime, Spinner } from './primitives.js';
import { diffLines, foldUnchanged, type DiffRow } from '../diff.js';
import { drawDiagrams } from '../diagrams.js';
import { useTheme } from '../theme.jsx';

export function HistoryDialog({
  artifactId,
  open,
  viewing,
  onClose,
  onChoose,
}: {
  artifactId: string;
  open: boolean;
  /** The version on screen now, or null for the current one. */
  viewing: number | null;
  onClose: () => void;
  onChoose: (version: number) => void;
}) {
  const [data, setData] = useState<ArtifactVersionsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    endpoints
      .versions(artifactId)
      .then((response) => {
        if (current) setData(response);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [artifactId, open]);

  return (
    <Dialog open={open} onClose={onClose} title="History" width={560}>
      {failed && <p className="text-[12.5px] text-ink-3">Could not load the history. Try again.</p>}
      {!failed && !data && (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Spinner /> Loading
        </p>
      )}
      {!failed && data && (
        <div className="flex flex-col gap-3" data-testid="history-panel">
          <ul className="flex max-h-[60vh] flex-col overflow-y-auto">
            {data.versions.map((version) => (
              <VersionRow
                key={version.version}
                version={version}
                selected={(viewing ?? data.currentVersion) === version.version}
                onChoose={() => onChoose(version.version)}
              />
            ))}
          </ul>
          <p className="text-[11.5px] text-ink-3">
            {data.versions.length === 1 ? '1 version' : `${data.versions.length} versions`}. Views per version
            cover the last {data.retentionDays} days. Only you can see past versions.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function VersionRow({
  version,
  selected,
  onChoose,
}: {
  version: ArtifactVersionSummary;
  selected: boolean;
  onChoose: () => void;
}) {
  const { views } = version.views;
  return (
    <li className="border-b border-line-2 last:border-0">
      <button
        type="button"
        onClick={onChoose}
        aria-current={selected ? 'true' : undefined}
        className={`flex w-full items-center gap-3 rounded-[--radius-sm] px-1.5 py-2 text-left text-[12.5px] transition-colors hover:bg-sunken ${selected ? 'bg-sunken' : ''}`}
      >
        <span className="w-9 shrink-0 tabular-nums font-medium text-ink">v{version.version}</span>
        <span className="min-w-0 flex-1 truncate text-ink">
          {version.title}
          {version.isCurrent && (
            <>
              {' '}
              <Badge tone="accent">Current</Badge>
            </>
          )}
        </span>
        <span className="shrink-0 tabular-nums text-ink-3" title={`${version.views.ownerViews} by you · ${version.views.otherViews} by others`}>
          {views === 1 ? '1 view' : `${views} views`}
        </span>
        <span className="w-20 shrink-0 text-right tabular-nums text-ink-3">
          <RelativeTime iso={version.createdAt} />
        </span>
      </button>
    </li>
  );
}

/**
 * One version, read-only, in place of the document. The banner is the point:
 * nobody should mistake an old version for what readers see now.
 */
export function PastVersion({
  slug,
  artifactId,
  version,
  onBack,
  onOpenHistory,
}: {
  slug: string;
  artifactId: string;
  version: number;
  onBack: () => void;
  onOpenHistory: () => void;
}) {
  const [detail, setDetail] = useState<ArtifactVersionDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<'document' | 'changes'>('document');

  useEffect(() => {
    let current = true;
    setDetail(null);
    setFailed(false);
    // This fetch is the open, counted against this version.
    endpoints
      .version(artifactId, version)
      .then((response) => {
        if (current) setDetail(response);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [artifactId, version]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="status"
        data-testid="version-banner"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-accent-wash px-4 py-2 text-[12.5px] text-ink"
      >
        <span className="min-w-0 flex-1">
          {detail ? (
            detail.isCurrent ? (
              <>You’re viewing version {detail.version} of {detail.currentVersion}, the current one.</>
            ) : (
              <>
                You’re viewing version {detail.version} of {detail.currentVersion}, from{' '}
                <RelativeTime iso={detail.updatedAt} />. Readers see version {detail.currentVersion}.
              </>
            )
          ) : (
            <>You’re viewing version {version}.</>
          )}
        </span>
        <div className="flex items-center gap-1" role="tablist" aria-label="What to show">
          <Button size="sm" tone={tab === 'document' ? 'default' : 'ghost'} aria-pressed={tab === 'document'} onClick={() => setTab('document')}>
            Document
          </Button>
          <Button
            size="sm"
            tone={tab === 'changes' ? 'default' : 'ghost'}
            aria-pressed={tab === 'changes'}
            onClick={() => setTab('changes')}
          >
            Changes
          </Button>
          <Button size="sm" tone="ghost" onClick={onOpenHistory}>
            All versions
          </Button>
          <Button size="sm" tone="primary" onClick={onBack}>
            Back to latest
          </Button>
        </div>
      </div>

      <div className="oa-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {failed && <p className="mx-auto max-w-[720px] px-6 py-10 text-[13px] text-ink-3">Could not load version {version}.</p>}
        {!failed && !detail && (
          <p className="mx-auto flex max-w-[720px] items-center gap-2 px-6 py-10 text-[13px] text-ink-3">
            <Spinner /> Loading version {version}
          </p>
        )}
        {!failed && detail && tab === 'document' && <VersionDocument slug={slug} detail={detail} />}
        {!failed && detail && tab === 'changes' && <VersionChanges artifactId={artifactId} detail={detail} />}
      </div>
    </div>
  );
}

/**
 * The version as a reader saw it. Markdown comes rendered and sanitised by the
 * server, as the current one does. HTML is the publisher's own script, so it
 * goes in the same opaque-origin sandbox as the current version, never the page.
 */
function VersionDocument({ slug, detail }: { slug: string; detail: ArtifactVersionDetail }) {
  const source = `/a/${encodeURIComponent(slug)}/content?version=${detail.version}`;
  const [html, setHtml] = useState<string | null>(null);
  const article = useRef<HTMLElement>(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (detail.type !== 'markdown') return;
    let current = true;
    setHtml(null);
    fetch(source, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : ''))
      .then((body) => {
        if (current) setHtml(body);
      })
      .catch(() => {
        if (current) setHtml('');
      });
    return () => {
      current = false;
    };
  }, [source, detail.type]);

  useEffect(() => {
    const element = article.current;
    if (!element || html === null) return;
    return drawDiagrams(element, theme === 'dark');
  }, [html, theme]);

  if (detail.type === 'html') {
    return (
      <iframe
        title={`${detail.title}, version ${detail.version}`}
        src={source}
        // Exactly the current version's sandbox. Do not add to it.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="w-full flex-1 border-0 bg-white"
      />
    );
  }

  if (html === null) {
    return (
      <p className="mx-auto flex max-w-[720px] items-center gap-2 px-6 py-10 text-[13px] text-ink-3">
        <Spinner /> Loading
      </p>
    );
  }

  return (
    <article
      ref={article}
      data-testid="version-document"
      className="prose oa-fade mx-auto w-full max-w-[720px] px-6 py-10 max-md:px-4 max-md:py-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** What this version changed, as a source diff against the version before it. */
function VersionChanges({ artifactId, detail }: { artifactId: string; detail: ArtifactVersionDetail }) {
  const [previous, setPrevious] = useState<ArtifactVersionDetail | null | 'none'>(detail.version === 1 ? 'none' : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (detail.version === 1) {
      setPrevious('none');
      return;
    }
    let current = true;
    setPrevious(null);
    setFailed(false);
    // Fetched only to compare against: not counted as reading it.
    endpoints
      .version(artifactId, detail.version - 1, { record: false })
      .then((response) => {
        if (current) setPrevious(response);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [artifactId, detail.version]);

  const before = previous === 'none' ? '' : (previous?.content ?? null);
  const diff = useMemo(() => (before === null ? null : diffLines(before, detail.content)), [before, detail.content]);
  const rows = useMemo(() => (diff ? foldUnchanged(diff.lines) : []), [diff]);

  if (failed) return <p className="mx-auto max-w-[720px] px-6 py-10 text-[13px] text-ink-3">Could not load version {detail.version - 1} to compare.</p>;
  if (!diff) {
    return (
      <p className="mx-auto flex max-w-[720px] items-center gap-2 px-6 py-10 text-[13px] text-ink-3">
        <Spinner /> Comparing
      </p>
    );
  }

  const titleChanged = previous !== 'none' && previous !== null && previous.title !== detail.title;
  const typeChanged = previous !== 'none' && previous !== null && previous.type !== detail.type;

  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-6 max-md:px-3" data-testid="version-changes">
      <p className="mb-3 text-[12.5px] text-ink-2">
        {detail.version === 1 ? (
          <>Version 1 is the first one: everything in it was added.</>
        ) : (
          <>
            Changes from version {detail.version - 1} to version {detail.version}:{' '}
            <span className="text-positive">+{diff.added}</span>{' '}
            <span className="text-danger">−{diff.removed}</span> lines
            {diff.added === 0 && diff.removed === 0 ? ' (the content is the same)' : ''}.
          </>
        )}
        {titleChanged && <> Title was “{(previous as ArtifactVersionDetail).title}”.</>}
        {typeChanged && <> Format changed from {(previous as ArtifactVersionDetail).type} to {detail.type}.</>}
        {diff.approximate && <> The versions are too different to line up, so the whole text is shown as replaced.</>}
      </p>
      <DiffTable rows={rows} />
    </div>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-[--radius-md] border border-line bg-surface">
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody>
          {rows.map((row, index) => {
            if (row.kind === 'fold') {
              return (
                <tr key={index} className="bg-sunken text-ink-3">
                  <td colSpan={3} className="px-3 py-1 text-[11.5px]">
                    ⋯ {row.count === 1 ? '1 unchanged line' : `${row.count} unchanged lines`}
                  </td>
                </tr>
              );
            }
            return (
              <tr
                key={index}
                className={row.kind === 'removed' ? 'bg-danger-wash' : ''}
                style={row.kind === 'added' ? { background: 'color-mix(in oklch, var(--color-positive) 12%, transparent)' } : undefined}
                data-diff={row.kind}
              >
                <td className="w-10 select-none px-2 text-right align-top tabular-nums text-ink-3">
                  {row.kind === 'added' ? '' : row.oldLine}
                </td>
                <td className="w-10 select-none px-2 text-right align-top tabular-nums text-ink-3">
                  {row.kind === 'removed' ? '' : row.newLine}
                </td>
                <td className="whitespace-pre-wrap break-words px-2 align-top text-ink">
                  <span className="select-none text-ink-3">{row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '− ' : '  '}</span>
                  {row.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
