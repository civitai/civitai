import { settledWinner } from '~/components/Events/ScoredEvent/scored-event.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import type { EventPromo } from '~/shared/constants/nav-banner.constants';

// Entries in the strip's dismiss cookie, so the server render already knows, and closing the strip
// and the block stay independent. The first close collapses the block to a bar; the bar's close hides it.
export const eventHomeBlockCollapseId = (event: string) => `home:event:${event}:collapsed`;
export const eventHomeBlockDismissId = (event: string) => `home:event:${event}`;

export type EventHomeBlockDisplay = 'full' | 'collapsed' | 'hidden';
export function eventHomeBlockDisplay(event: string, dismissed: string[]): EventHomeBlockDisplay {
  if (dismissed.includes(eventHomeBlockDismissId(event))) return 'hidden';
  return dismissed.includes(eventHomeBlockCollapseId(event)) ? 'collapsed' : 'full';
}

type EventInfo = {
  title: string;
  startDate: Date;
  endDate: Date;
  finalAt?: Date;
  preview: boolean;
  page?: { headline?: string; headlineAccent?: string };
};
type Standings = { updatedAt: Date; teams: { team: string; rank: number; score: number }[] };
type Hat = { placedOn?: unknown; points: number };

// How many of the viewer's hats fit the block's hats column; the rest are on the event page.
export const HOME_BLOCK_HAT_TILES = 3;

export type ScoredEventHomeBlockView =
  | { state: 'ended'; winner?: string }
  | { state: 'join' }
  | {
      state: 'joined';
      team: string;
      rank?: number;
      points: number;
      shownHats: number;
      moreHats: number;
    };

/**
 * The copy is the event's promo while it is playable. Promos stop once it ends, so the ended block
 * falls back to the page headline and the event title.
 */
export function scoredEventHomeBlockCopy(data: EventInfo, promo?: EventPromo['homeBlock']) {
  return {
    eyebrow: promo?.eyebrow ?? data.title,
    title: promo?.title ?? data.page?.headline ?? data.title,
    accent: data.page?.headlineAccent,
    body: promo?.body,
    cta: promo?.cta ?? 'Open the event',
  };
}

export function scoredEventHomeBlockView({
  data,
  standings,
  team,
  hats,
  now = new Date(),
}: {
  data: EventInfo;
  standings?: Standings;
  /** Set once the viewer has joined. */
  team?: string;
  hats: Hat[];
  now?: Date;
}): ScoredEventHomeBlockView {
  if (data.endDate < now) return { state: 'ended', winner: settledWinner(data, standings, now) };
  if (!team) return { state: 'join' };
  const shownHats = Math.min(hats.length, HOME_BLOCK_HAT_TILES);
  return {
    state: 'joined',
    team,
    rank: standings?.teams.find((t) => t.team === team)?.rank,
    points: hats.reduce((sum, h) => sum + h.points, 0),
    shownHats,
    moreHats: hats.length - shownHats,
  };
}

/** The collapsed bar's one line. */
export function collapsedLine(view: ScoredEventHomeBlockView) {
  if (view.state === 'ended')
    return view.winner ? `Team ${view.winner} won` : 'Final scores are being tallied';
  if (view.state === 'join') return 'Join a team and get a free hat';
  const rank = view.rank ? ` is #${view.rank}` : '';
  const hats = view.shownHats + view.moreHats === 1 ? 'hat has' : 'hats have';
  return `Team ${view.team}${rank} · your ${hats} earned ${numberWithCommas(view.points)}`;
}
