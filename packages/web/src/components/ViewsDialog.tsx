/**
 * Who opened this document. The owner's answer to "did anybody read it?".
 *
 * The headline is everybody who opened it in a browser, the owner included:
 * an author reading what an agent produced for them is reading it. The split
 * between "you" and "others" sits right under it. Agent reads are shown apart,
 * so an agent re-reading its work all afternoon never looks like an audience.
 *
 * Loaded when opened rather than with the page: the page counts as an open, and
 * the dialog should show it, and most visits never ask.
 */

import { useEffect, useState } from 'react';
import { endpoints, type ArtifactViewsResponse, type ViewViewer } from '../api.js';
import { Dialog, RelativeTime, Spinner, Badge } from './primitives.js';

const ACCESS_LABEL: Record<string, string> = {
  owner: 'You',
  'shared-with-you': 'Invited',
  'shared-with-your-domain': 'Your domain',
  public: 'Public link',
};

export function ViewsDialog({
  artifactId,
  open,
  onClose,
}: {
  artifactId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<ArtifactViewsResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    endpoints
      .views(artifactId)
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
    <Dialog open={open} onClose={onClose} title="Views" width={520}>
      {failed && <p className="text-[12.5px] text-ink-3">Could not load the views. Try again.</p>}
      {!failed && !data && (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Spinner /> Loading
        </p>
      )}
      {!failed && data && <ViewsBody data={data} />}
    </Dialog>
  );
}

function ViewsBody({ data }: { data: ArtifactViewsResponse }) {
  const { totals } = data;
  return (
    <div className="flex flex-col gap-4" data-testid="views-panel">
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Views" value={totals.views} detail={`${totals.ownerViews} by you · ${totals.otherViews} by others`} />
        <Stat label="People" value={totals.uniqueViewers} detail={totals.otherViewers === 1 ? '1 besides you' : `${totals.otherViewers} besides you`} />
        <div>
          <dt className="text-[11px] uppercase tracking-[0.05em] text-ink-3">Last viewed</dt>
          <dd className="mt-0.5 text-[13px] text-ink">
            {data.lastViewedAt ? <RelativeTime iso={data.lastViewedAt} /> : 'Never'}
          </dd>
        </div>
      </dl>

      <p className="text-[12.5px] text-ink-2">
        {data.openedSinceLatestVersion ? (
          <>Somebody has opened version {data.version}, the current one.</>
        ) : (
          <>
            <Badge tone="warn">Unread</Badge>{' '}
            Nobody has opened version {data.version} yet
            {data.lastViewedVersion !== null ? ` (last opened: version ${data.lastViewedVersion})` : ''}.
          </>
        )}
      </p>

      {data.viewers.length > 0 ? (
        <ul className="flex flex-col">
          {data.viewers.map((viewer) => (
            <li
              key={keyOf(viewer.viewer)}
              className="flex items-center gap-3 border-b border-line-2 py-2 text-[12.5px] last:border-0"
            >
              <span className="min-w-0 flex-1 truncate text-ink">
                {viewer.isOwner ? 'You' : nameOf(viewer.viewer)}
              </span>
              <span className="shrink-0 text-ink-3">
                {viewer.isOwner ? 'Owner' : (ACCESS_LABEL[viewer.access] ?? viewer.access)}
              </span>
              <span className="shrink-0 tabular-nums text-ink-3">
                {viewer.views === 1 ? '1 view' : `${viewer.views} views`} · v{viewer.lastVersion}
              </span>
              <span className="shrink-0 tabular-nums text-ink-3">
                <RelativeTime iso={viewer.lastViewedAt} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">Nobody has opened it in a browser yet.</p>
      )}

      <p className="text-[11.5px] text-ink-3">
        Not counted as views: {plural(totals.agentFetches, 'read')} by agents. Kept for{' '}
        {data.retentionDays} days. Only you can see this.
      </p>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.05em] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[17px] tabular-nums text-ink">{value}</dd>
      {detail && <dd className="text-[11px] tabular-nums text-ink-3">{detail}</dd>}
    </div>
  );
}

function nameOf(viewer: ViewViewer): string {
  if (viewer.kind === 'user') return viewer.displayName ? `${viewer.displayName} (${viewer.email})` : viewer.email;
  return `Anonymous ${viewer.id}`;
}

function keyOf(viewer: ViewViewer): string {
  return viewer.kind === 'user' ? `u:${viewer.email}` : `a:${viewer.id}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
