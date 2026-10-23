/**
 * How many live streams may be open, and what happens past that.
 *
 * Every open stream is a connection held open for as long as a tab is, so the
 * number is worth bounding three ways:
 *
 *   per person    one stream per tab, so this is how many tabs one person (or
 *                 one agent's token) may follow at once
 *   per document  how many may follow one document, signed in or not
 *   in total      a ceiling for the process, whatever the mix
 *
 * The two kinds of limit are answered differently, on purpose.
 *
 * A person over their own limit gets their oldest stream closed to make room.
 * Theirs is the only one that goes, so nobody else can be pushed off this way,
 * and the tab that just opened is the one they are looking at; the oldest is
 * most likely a tab left behind somewhere. That stream is told it was replaced
 * and does not reconnect by itself, so two tabs cannot take turns knocking each
 * other off.
 *
 * Past the document's limit or the total, the new stream is refused (429, with
 * Retry-After) and nothing already open is touched. Making room there would
 * mean closing somebody else's stream, and a public document's readers include
 * anybody: letting one of them close everybody else's by opening enough tabs
 * would make the limit the attack. A refused browser waits and tries again,
 * as it does for any temporary refusal.
 */

export interface StreamLimits {
  perUser: number;
  perArtifact: number;
  total: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = { perUser: 20, perArtifact: 250, total: 2_000 };

/** The limits as the operator configured them (see config.ts). */
export function streamLimits(limits: {
  liveStreamsPerUser: number;
  liveStreamsPerArtifact: number;
  liveStreams: number;
}): StreamLimits {
  return { perUser: limits.liveStreamsPerUser, perArtifact: limits.liveStreamsPerArtifact, total: limits.liveStreams };
}

export interface StreamTicket {
  /** Who it is for, when anybody: counted against their limit. */
  userId: string | null;
  /** The document it follows, when one: counted against that document's limit. */
  artifactId: string | null;
  /** Ends the stream because its owner opened one too many. Must not throw. */
  replace(): void;
}

export type Admission =
  | { admitted: true; release: () => void }
  | { admitted: false; full: 'artifact' | 'total' };

export class OpenStreams {
  readonly limits: StreamLimits;
  /** In the order they opened, so the first of somebody's is their oldest. */
  private readonly open = new Set<StreamTicket>();

  constructor(limits: StreamLimits = DEFAULT_STREAM_LIMITS) {
    this.limits = limits;
  }

  admit(ticket: StreamTicket): Admission {
    // Decided as if the stream that would make room had already gone, and
    // nothing is closed until the new one is sure to be let in: being refused
    // must never also cost somebody a stream they had.
    const victim = ticket.userId === null ? null : this.oldestOverLimit(ticket.userId);
    const others = [...this.open].filter((stream) => stream !== victim);

    if (others.length >= this.limits.total) return { admitted: false, full: 'total' };
    if (
      ticket.artifactId !== null &&
      others.filter((stream) => stream.artifactId === ticket.artifactId).length >= this.limits.perArtifact
    ) {
      return { admitted: false, full: 'artifact' };
    }

    if (victim) {
      this.open.delete(victim);
      victim.replace();
    }
    this.open.add(ticket);
    return { admitted: true, release: () => this.open.delete(ticket) };
  }

  /** How many are open, for somebody, for a document, or at all. */
  count(filter: { userId?: string; artifactId?: string } = {}): number {
    let total = 0;
    for (const stream of this.open) {
      if (filter.userId !== undefined && stream.userId !== filter.userId) continue;
      if (filter.artifactId !== undefined && stream.artifactId !== filter.artifactId) continue;
      total += 1;
    }
    return total;
  }

  /** Somebody's oldest stream, when they already have as many as they may. */
  private oldestOverLimit(userId: string): StreamTicket | null {
    const theirs = [...this.open].filter((stream) => stream.userId === userId);
    return theirs.length >= this.limits.perUser ? theirs[0]! : null;
  }
}
