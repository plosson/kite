/**
 * Whether the tab is following live changes right now: the document's in the
 * bar, the bell's in the sidebar. Both read the tab's one connection.
 *
 * Quiet while it is, because that is the normal state and needs no reading:
 * a dot, and the word where there is room for it. Saying so when it is not
 * matters more — somebody waiting for their agent's change to appear, or for
 * a colleague's reply, should know the page is reconnecting rather than wonder
 * why nothing happens.
 */

import { useLiveState, type LiveConnection, type LiveState } from '../live.js';

const SHOWN: Record<LiveState, { label: string; title: string; colour: string }> = {
  connecting: { label: 'Connecting', title: 'Connecting to live updates…', colour: 'bg-ink-3' },
  live: { label: 'Live', title: 'Changes appear here as they are made', colour: 'bg-[oklch(68%_0.15_150)]' },
  reconnecting: {
    label: 'Reconnecting',
    title: 'Not receiving changes. Reconnecting…',
    colour: 'bg-[oklch(74%_0.15_78)]',
  },
  paused: {
    label: 'Paused',
    title: 'Paused while your newer tabs follow live changes. Back when you return to this tab.',
    colour: 'bg-ink-3',
  },
  closed: { label: 'Offline', title: 'Not receiving changes', colour: 'bg-ink-3' },
};

export function LiveStatus({
  connection,
  testId = 'live-status',
  dotOnly = false,
}: {
  connection: LiveConnection | null;
  testId?: string;
  /** Just the dot, the word kept for screen readers: for a row with no room for it. */
  dotOnly?: boolean;
}) {
  const state = useLiveState(connection);
  if (state === null) return null;
  const { label, title, colour } = SHOWN[state];

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-3"
      title={title}
      role="status"
      data-testid={testId}
      data-state={state}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${colour}`} aria-hidden="true" />
      <span className={dotOnly ? 'sr-only' : 'max-md:sr-only'}>{label}</span>
    </span>
  );
}
