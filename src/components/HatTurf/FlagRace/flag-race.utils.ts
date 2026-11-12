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
