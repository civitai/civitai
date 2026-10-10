import { useCallback, useEffect } from 'react';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

// The points engine pushes a hat's new total, and the event's team totals, only while someone has
// them on screen (src/server/events/points/push.ts and watch.ts). A section that shows them
// subscribes and marks its topics as watched while it is in view, and does neither once it is not.
// These apply each push to the query that screen already holds, so the number moves without a
// refetch.

// Built here rather than imported from the server's keys.ts, which pulls in Redis. Pinned to the
// server's topics by a test.
export const hatTopic = (event: string, topicId: string) =>
  `${SignalTopic.EventPoints}:${event}:hat:${topicId}` as const;
export const teamsTopic = (event: string) => `${SignalTopic.EventPoints}:${event}:teams` as const;
// The interest-set member for the team totals, and how often a mark is refreshed while in view.
// Pinned to the server's (watch.ts) by a test.
export const TEAMS_WATCH = 'teams';
export const WATCH_REFRESH_MS = 30_000;
const WATCH_BATCH = 50;

const isPoints = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A hat push for this event, or null for anything else. */
export function readHatPush(push: unknown, event: string) {
  const { event: e, topicId, points } = (push ?? {}) as Record<string, unknown>;
  if (e !== event || typeof topicId !== 'string' || !isPoints(points)) return null;
  return { topicId, points };
}

/** A team totals push for this event, keeping only numeric totals, or null for anything else. */
export function readTeamsPush(push: unknown, event: string) {
  const { event: e, teams } = (push ?? {}) as Record<string, unknown>;
  if (e !== event || !teams || typeof teams !== 'object') return null;
  return Object.fromEntries(Object.entries(teams).filter(([, v]) => isPoints(v))) as Record<
    string,
    number
  >;
}

/** The rows with the pushed total on the matching hat; the same array when nothing changed. */
export function applyHatPoints<T extends { topicId: string; points: number }>(
  rows: T[] | undefined,
  topicId: string,
  points: number
) {
  if (!rows?.some((r) => r.topicId === topicId && r.points !== points)) return rows;
  return rows.map((r) => (r.topicId === topicId ? { ...r, points } : r));
}

/** Standings with the pushed team totals, re-ranked; the same object when nothing changed. */
export function applyTeamPoints<
  T extends { teams: { team: string; score: number; rank: number }[] }
>(standings: T | undefined, totals: Record<string, number>) {
  if (!standings?.teams.some((t) => t.team in totals && totals[t.team] !== t.score))
    return standings;
  const teams = standings.teams
    .map((t) => ({ ...t, score: totals[t.team] ?? t.score }))
    .sort((a, b) => b.score - a.score)
    .map((t, i) => ({ ...t, rank: i + 1 }));
  return { ...standings, teams };
}

/** Standings with a pushed hat total on its top-hats row, re-sorted; the same object otherwise. */
export function applyTopHatPoints<
  T extends { topCosmetics: { topicId: string; points: number }[] }
>(standings: T | undefined, topicId: string, points: number) {
  const rows = applyHatPoints(standings?.topCosmetics, topicId, points);
  if (!standings || rows === standings.topCosmetics) return standings;
  return { ...standings, topCosmetics: [...rows!].sort((a, b) => b.points - a.points) };
}

/**
 * While `active`, marks `topics` (hat topic ids, or TEAMS_WATCH) as on screen now and every
 * WATCH_REFRESH_MS, so the server pushes them. Once inactive it stops, and the marks lapse.
 */
export function useWatchEventPoints(event: string, topics: string[], active: boolean) {
  const { mutate } = trpc.event.watchPoints.useMutation();
  // A stable dependency for the effect: the same topics in the same order are the same watch.
  const key = active && topics.length ? topics.join(',') : '';
  useEffect(() => {
    if (!key) return;
    const all = key.split(',');
    const mark = () => {
      for (let i = 0; i < all.length; i += WATCH_BATCH)
        mutate({ event, topics: all.slice(i, i + WATCH_BATCH) });
    };
    mark();
    const id = setInterval(mark, WATCH_REFRESH_MS);
    return () => clearInterval(id);
  }, [event, key, mutate]);
}

function HatTopic({ topic }: { topic: ReturnType<typeof hatTopic> }) {
  useSignalTopic(topic);
  return null;
}

/** While `active`: subscribed to each hat's topic and watching it. Renders nothing visible. */
function WatchedHatTopics({
  event,
  topicIds,
  active,
}: {
  event: string;
  topicIds: string[];
  active: boolean;
}) {
  useWatchEventPoints(event, topicIds, active);
  if (!active) return null;
  return (
    <>
      {topicIds.map((id) => (
        <HatTopic key={id} topic={hatTopic(event, id)} />
      ))}
    </>
  );
}

/**
 * Mounted only while a worn-hat popover is open, so a feed of hatted cards registers nothing:
 * follows that hat's total live. Renders nothing.
 */
export function WornHatLivePoints({
  event,
  entityType,
  entityId,
  topicId,
}: {
  event: string;
  entityType: CosmeticEntity;
  entityId: number;
  /** From the getWornHat row. */
  topicId: string;
}) {
  const utils = trpc.useUtils();
  const onPush = useCallback(
    (raw: unknown) => {
      const push = readHatPush(raw, event);
      if (!push || push.topicId !== topicId) return;
      // The popover's own query input: { event, ...wornOn }.
      utils.event.getWornHat.setData({ event, entityType, entityId }, (hat) =>
        hat ? applyHatPoints([hat], push.topicId, push.points)?.[0] : hat
      );
    },
    [utils, event, entityType, entityId, topicId]
  );
  useSignalConnection(SignalMessages.EventPointsHat, onPush);
  return <WatchedHatTopics event={event} topicIds={[topicId]} active />;
}

/** While "Your hats" is in view: each hat's total, live. Renders nothing visible. */
export function MyHatsLivePoints({
  event,
  topicIds,
  inView,
}: {
  event: string;
  topicIds: string[];
  inView: boolean;
}) {
  const utils = trpc.useUtils();
  const onPush = useCallback(
    (raw: unknown) => {
      const push = readHatPush(raw, event);
      if (!push) return;
      utils.event.getMyHats.setData({ event }, (rows) =>
        applyHatPoints(rows, push.topicId, push.points)
      );
    },
    [utils, event]
  );
  useSignalConnection(SignalMessages.EventPointsHat, onPush);
  return <WatchedHatTopics event={event} topicIds={topicIds} active={inView} />;
}

/** While the top hats are in view: their totals, live. Renders nothing visible. */
export function TopHatsLivePoints({
  event,
  topicIds,
  inView,
}: {
  event: string;
  topicIds: string[];
  inView: boolean;
}) {
  const utils = trpc.useUtils();
  const onPush = useCallback(
    (raw: unknown) => {
      const push = readHatPush(raw, event);
      if (!push) return;
      utils.event.getStandings.setData({ event }, (s) =>
        applyTopHatPoints(s, push.topicId, push.points)
      );
    },
    [utils, event]
  );
  useSignalConnection(SignalMessages.EventPointsHat, onPush);
  return <WatchedHatTopics event={event} topicIds={topicIds} active={inView} />;
}

/** While the team totals are in view and the event running: the team totals, live. */
export function useEventTeamsLivePoints(event: string, active: boolean) {
  const utils = trpc.useUtils();
  useSignalTopic(active ? teamsTopic(event) : undefined);
  useWatchEventPoints(event, [TEAMS_WATCH], active);
  const onPush = useCallback(
    (raw: unknown) => {
      const totals = active ? readTeamsPush(raw, event) : null;
      if (!totals) return;
      utils.event.getStandings.setData({ event }, (s) => applyTeamPoints(s, totals));
    },
    [utils, event, active]
  );
  useSignalConnection(SignalMessages.EventPointsTeams, onPush);
}
