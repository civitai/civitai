import { useCallback } from 'react';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

// The points engine pushes a hat's new total, and the event's team totals, while a screen showing
// them is open (src/server/events/points/push.ts). These apply each push to the query that
// screen already holds, so the number moves without a refetch.

// Built here rather than imported from the server's keys.ts, which pulls in Redis. Pinned to the
// server's topics by a test.
export const hatTopic = (event: string, topicId: string) =>
  `${SignalTopic.EventPoints}:${event}:hat:${topicId}` as const;
export const teamsTopic = (event: string) => `${SignalTopic.EventPoints}:${event}:teams` as const;

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
export function applyHatPoints<T extends { topicId: string | null; points: number }>(
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
  useSignalTopic(hatTopic(event, topicId));
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
  return null;
}

/** While "Your hats" is on screen: each hat's total, live. Renders nothing. */
export function MyHatsLivePoints({ event, topicIds }: { event: string; topicIds: string[] }) {
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

/** While the event page is open and the event running: the team totals, live. */
export function useEventTeamsLivePoints(event: string, enabled: boolean) {
  const utils = trpc.useUtils();
  useSignalTopic(enabled ? teamsTopic(event) : undefined);
  const onPush = useCallback(
    (raw: unknown) => {
      const totals = enabled ? readTeamsPush(raw, event) : null;
      if (!totals) return;
      utils.event.getStandings.setData({ event }, (s) => applyTeamPoints(s, totals));
    },
    [utils, event, enabled]
  );
  useSignalConnection(SignalMessages.EventPointsTeams, onPush);
}
