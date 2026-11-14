import { FLAG_HAT_MAX } from '~/server/schema/turf.schema';

/** The single team with the most hats, or null when none or tied. */
export function flagLeader(hatsByTeam: Record<string, number>) {
  const entries = Object.entries(hatsByTeam).filter(([, n]) => n > 0);
  const most = Math.max(0, ...entries.map(([, n]) => n));
  const leaders = entries.filter(([, n]) => n === most);
  return leaders.length === 1 ? leaders[0][0] : null;
}

/**
 * The viewer's team's hats against the best other team: ahead (positive) when it holds the flag,
 * otherwise behind the leader. Null when the viewer has no team or the flag has no hats.
 */
export function flagGap(hatsByTeam: Record<string, number>, team: string | null | undefined) {
  if (!team) return null;
  const counts = Object.values(hatsByTeam);
  if (!counts.some((n) => n > 0)) return null;
  const mine = hatsByTeam[team] ?? 0;
  const others = Object.entries(hatsByTeam)
    .filter(([t]) => t !== team)
    .map(([, n]) => n);
  return mine - Math.max(0, ...others);
}

/**
 * What the flag hat picker offers a player with `available` hats: 1, 5 and FLAG_HAT_MAX, each capped
 * at what they have, without repeats. 8 hats gives 1, 5, 8; 4 gives 1, 4; none gives nothing.
 */
export function flagHatChoices(available: number) {
  const have = Math.floor(available);
  return [...new Set([1, 5, FLAG_HAT_MAX].map((n) => Math.min(n, have)))].filter((n) => n > 0);
}

const FINAL_HOUR_MS = 60 * 60 * 1000;

/** When a flag day's final hour starts: an hour before it closes. */
export const finalHourAt = (closesAt: Date | string | number) =>
  new Date(new Date(closesAt).getTime() - FINAL_HOUR_MS);

/**
 * Cut, but not yet paid: the freeze runs at the first hourly settle after the cut. A summary cached
 * before `frozen` existed has no field and reads as paid, as it did then.
 */
export const flagCounting = (summary: { closed: boolean; frozen?: boolean }) =>
  summary.closed && summary.frozen === false;

/**
 * Where a flag day's race stands for its clocks. The cut is a secret moment in the final hour, so the
 * clock counts to the start of that hour, then the race "could end any moment" until it closes.
 */
export function flagClock(nowMs: number, closesAt: Date | string, closed: boolean) {
  if (closed) return { phase: 'closed' as const, secondsLeft: 0 };
  const finalAt = finalHourAt(closesAt).getTime();
  if (nowMs >= finalAt) return { phase: 'final' as const, secondsLeft: 0 };
  return { phase: 'counting' as const, secondsLeft: Math.ceil((finalAt - nowMs) / 1000) };
}
