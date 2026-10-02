/**
 * The dashboard's second view: when everything was published and edited, down
 * a vertical line at one scale, with each long quiet spell cut out and marked.
 * The layout itself is worked out in ../timeline.ts, which is where the rules
 * are and where they are tested.
 */

import { useEffect, useState } from 'react';
import { endpoints, type TimelineEvent } from '../api.js';
import { Link } from '../router.jsx';
import { EmptyState, Spinner } from './primitives.js';
import { describeGap, layoutTimeline } from '../timeline.js';
import { useNarrowScreen } from '../viewport.js';

/** Where the line runs, from the left edge. The time labels sit to its left. */
const LINE_X = 92;
const LINE_X_PHONE = 76;

export function Timeline({ descriptions }: { descriptions: Map<string, string | null> }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const narrow = useNarrowScreen();

  useEffect(() => {
    let live = true;
    setFailed(false);
    endpoints.timeline().then(
      (response) => live && setEvents(response.events),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (failed) {
    return (
      <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-6 text-[12.5px] text-accent hover:underline">
        Could not load the timeline. Try again.
      </button>
    );
  }
  if (events === null) {
    return (
      <p className="mt-6 flex items-center gap-2 text-[12.5px] text-ink-3">
        <Spinner /> Loading the timeline
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <div className="mt-6">
        <EmptyState title="Nothing has happened yet">Publish a document and it starts the timeline.</EmptyState>
      </div>
    );
  }

  const lineX = narrow ? LINE_X_PHONE : LINE_X;
  const layout = layoutTimeline(events);
  let previousDay: string | null = null;

  return (
    <ol className="relative mt-6" style={{ height: layout.height }} aria-label="Timeline">
      <span aria-hidden="true" className="absolute top-2 bottom-2 w-px bg-line" style={{ left: lineX }} />

      {layout.items.map((item, index) => {
        if (item.kind === 'gap') {
          return (
            <li
              key={`gap-${index}`}
              className="absolute right-0 left-0 flex items-center"
              style={{ top: item.y, height: 44 }}
              aria-label={`${describeGap(item.ms)} with nothing`}
            >
              <span className="text-right text-[11px] whitespace-nowrap text-ink-3 tabular-nums" style={{ width: lineX - 14 }}>
                {describeGap(item.ms)}
              </span>
              {/* The page background over the line is what cuts it. */}
              <span
                aria-hidden="true"
                className="absolute grid place-items-center bg-canvas text-[17px] leading-[0.5] text-ink-3"
                style={{ left: lineX - 6, width: 13, top: 4, bottom: 4 }}
              >
                ⋮
              </span>
            </li>
          );
        }

        const { event } = item;
        const when = new Date(event.at);
        const day = when.toDateString();
        const showDay = item.startsCluster || day !== previousDay;
        previousDay = day;
        const description = descriptions.get(event.artifactId) ?? null;

        return (
          <li key={`${event.artifactId}-${event.version}`} className="absolute right-0 left-0 flex h-10 items-start" style={{ top: item.y }}>
            <span
              className="shrink-0 pt-0.5 text-right text-[11px] leading-tight whitespace-nowrap tabular-nums text-ink-3"
              style={{ width: lineX - 14 }}
            >
              {showDay && <span className="block text-ink-2">{formatDay(when, narrow)}</span>}
              <time dateTime={event.at} title={when.toLocaleString()}>
                {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              </time>
            </span>

            <span
              aria-hidden="true"
              className={`absolute top-1.5 size-[9px] rounded-full border-[1.5px] ${
                event.kind === 'published' ? 'border-accent bg-accent' : 'border-ink-3 bg-canvas'
              }`}
              style={{ left: lineX - 4 }}
            />

            <Link
              to={`/a/${event.slug}`}
              className="group absolute right-0 min-w-0 rounded-[--radius-sm] px-1.5"
              style={{ left: lineX + 14 }}
              title={description ?? undefined}
            >
              <span className="block truncate text-[13px] font-medium leading-tight text-ink group-hover:text-accent">
                {event.title}
              </span>
              <span className="block truncate text-[11.5px] leading-tight text-ink-3">
                {event.kind === 'published' ? 'Published' : `Edited · version ${event.version}`}
                {/* A phone has no room for it; the list view shows it there. */}
                {description && !narrow && <span> · {description}</span>}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

/** "Thu, Oct 1"; on a phone, just "Oct 1". The year only when it is not this one. */
function formatDay(when: Date, narrow: boolean): string {
  const sameYear = when.getFullYear() === new Date().getFullYear();
  return when.toLocaleDateString(undefined, {
    ...(narrow ? {} : { weekday: 'short' as const }),
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
