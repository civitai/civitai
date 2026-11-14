export type PlacementStatsRow = {
  cosmeticId: number;
  claimKey: string;
  actorId: number;
  hatPoints: number;
  points: number;
  views: number;
};

export type PlacementStats = {
  cosmeticId: number;
  claimKey: string;
  points: number;
  views: number;
};

// Per hat, the query's per-actor rows less the people the referee would not read (hidden, or a
// new account). An owner the referee hides earns nothing.
export function totalPlacementRows(
  rows: PlacementStatsRow[],
  { userId, hidden, newAccountMinId }: { userId: number; hidden: number[]; newAccountMinId: number }
) {
  const skip = new Set(hidden);
  const totals = new Map<string, PlacementStats & { hatPoints: number }>();
  if (skip.has(userId)) return totals;
  for (const r of rows) {
    if (skip.has(r.actorId) || r.actorId >= newAccountMinId) continue;
    const key = `${r.cosmeticId}:${r.claimKey}`;
    const t = totals.get(key) ?? {
      cosmeticId: r.cosmeticId,
      claimKey: r.claimKey,
      points: 0,
      views: 0,
      hatPoints: 0,
    };
    t.points += r.points;
    t.views += r.views;
    t.hatPoints += r.hatPoints;
    totals.set(key, t);
  }
  return totals;
}
