import { useCallback } from 'react';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

// The points engine pushes a hat's new total, and the event's team totals, while a screen showing
// them is open (src/server/events/points/ticker.ts). These apply each push to the query that
// screen already holds, so the number moves without a refetch.

// Built here rather than imported from the server's keys.ts, which pulls in Redis. Pinned to the
// server's topics by a test.
export const hatTopic = (event: string, topicId: string) =>
  `${SignalTopic.EventPoints}:${event}:hat:${topicId}` as const;
export const teamsTopic = (event: string) => `${SignalTopic.EventPoints}:${event}:teams` as const;

type HatPush = { event?: string; topicId?: string; points?: number };
type TeamsPush = { event?: string; teams?: Record<string, number> };

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

const isPoints = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** While the worn-hat popover is open: its hat's total, live. */
export function useWornHatLivePoints({
  event,
  entityType,
  entityId,
  topicId,
}: {
  event: string;
  entityType: CosmeticEntity;
  entityId: number;
  /** From the getWornHat row; undefined while it loads or the popover is closed. */
  topicId: string | undefined;
}) {
  const utils = trpc.useUtils();
  useSignalTopic(topicId ? hatTopic(event, topicId) : undefined);
  const onPush = useCallback(
    ({ event: e, topicId: id, points }: HatPush) => {
      if (!topicId || e !== event || id !== topicId || !isPoints(points)) return;
      utils.event.getWornHat.setData({ event, entityType, entityId }, (hat) =>
        hat && hat.topicId === id && hat.points !== points ? { ...hat, points } : hat
      );
    },
    [utils, event, entityType, entityId, topicId]
  );
  useSignalConnection(SignalMessages.EventPointsHat, onPush);
}

/** While "Your hats" is on screen: each hat's total, live. Renders nothing. */
export function MyHatsLivePoints({ event, topicIds }: { event: string; topicIds: string[] }) {
  const utils = trpc.useUtils();
  const onPush = useCallback(
    ({ event: e, topicId, points }: HatPush) => {
      if (e !== event || !topicId || !isPoints(points)) return;
      utils.event.getMyHats.setData({ event }, (rows) => applyHatPoints(rows, topicId, points));
    },
    [utils, event]
  );
  useSignalConnection(SignalMessages.EventPointsHat, onPush);
  return (
    <>
      {topicIds.map((id) => (
        <HatTopic key={id} topic={hatTopic(event, id)} />
      ))}
    </>
  );
}

function HatTopic({ topic }: { topic: ReturnType<typeof hatTopic> }) {
  useSignalTopic(topic);
  return null;
}

/** While the event page is open: the team totals, live. */
export function useEventTeamsLivePoints(event: string) {
  const utils = trpc.useUtils();
  useSignalTopic(teamsTopic(event));
  const onPush = useCallback(
    ({ event: e, teams }: TeamsPush) => {
      if (e !== event || !teams) return;
      const totals = Object.fromEntries(Object.entries(teams).filter(([, v]) => isPoints(v)));
      utils.event.getStandings.setData({ event }, (s) => applyTeamPoints(s, totals));
    },
    [utils, event]
  );
  useSignalConnection(SignalMessages.EventPointsTeams, onPush);
}
