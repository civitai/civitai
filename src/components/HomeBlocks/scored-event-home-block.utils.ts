import { settledWinner } from '~/components/Events/ScoredEvent/scored-event.utils';
import type { EventPromo } from '~/shared/constants/nav-banner.constants';

/** Its own entry in the strip's dismiss cookie, so closing the strip leaves the block and back. */
export const eventHomeBlockDismissId = (event: string) => `home:event:${event}`;

type EventInfo = {
  title: string;
  startDate: Date;
  endDate: Date;
  finalAt?: Date;
  preview: boolean;
  joinable: boolean;
  page?: { headline?: string };
};
type Standings = { updatedAt: Date; teams: { team: string; rank: number; score: number }[] };
type Hat = { placedOn?: unknown };

export type ScoredEventHomeBlockView =
  | { state: 'ended'; winner?: string }
  | { state: 'join' }
  | {
      state: 'joined';
      team: string;
      rank?: number;
      hatsPlaced: number;
      hatsOwned: number;
      nextHatIndex: number;
    };

/**
 * The copy is the event's promo while it is playable. Promos stop once it ends, so the ended block
 * falls back to the page headline and the event title.
 */
export function scoredEventHomeBlockCopy(data: EventInfo, promo?: EventPromo['homeBlock']) {
  return {
    eyebrow: promo?.eyebrow ?? (data.preview ? 'Preview: testers and mods' : undefined),
    title: promo?.title ?? data.page?.headline ?? data.title,
    body: promo?.body,
    cta: promo?.cta ?? 'See the event',
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
  return {
    state: 'joined',
    team,
    rank: standings?.teams.find((t) => t.team === team)?.rank,
    hatsPlaced: hats.filter((h) => !!h.placedOn).length,
    hatsOwned: hats.length,
    nextHatIndex: hats.findIndex((h) => !h.placedOn),
  };
}
