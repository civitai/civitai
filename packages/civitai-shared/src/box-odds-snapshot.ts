import * as z from 'zod';

/**
 * A box's tiers, weights and contents at one published version (`BoxOddsSnapshot.snapshot`). The
 * builder writes it; the odds page reads it, so both share these definitions.
 */
export const boxOddsSnapshotSchema = z.object({
  tiers: z.array(z.object({ key: z.string(), name: z.string(), weight: z.number().int() })),
  contents: z.array(
    z.object({
      tier: z.string(),
      cosmeticId: z.number().int(),
      /** A creator box's value for this content at approval: what the price bounds were checked against. */
      value: z.number().int().optional(),
    })
  ),
  /** A creator box's price at this version. Platform boxes record none. */
  price: z.number().int().optional(),
});

export type BoxOddsSnapshotData = z.infer<typeof boxOddsSnapshotSchema>;

/**
 * The live box in snapshot form: tiers in draw order, each content under its tier's key. Callers pass
 * only enabled cosmetic contents.
 */
export function snapshotOfLiveBox(
  tiers: { id: number; key: string; name: string; weight: number; sortOrder: number }[],
  contents: { tierId: number; cosmeticId: number }[]
): BoxOddsSnapshotData {
  const ordered = [...tiers].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const keyOf = new Map(ordered.map((tier) => [tier.id, tier.key]));
  const rank = new Map(ordered.map((tier, i) => [tier.key, i]));
  return {
    tiers: ordered.map(({ key, name, weight }) => ({ key, name, weight })),
    contents: contents
      .map((content) => ({ tier: keyOf.get(content.tierId) ?? '', cosmeticId: content.cosmeticId }))
      .sort((a, b) => rank.get(a.tier)! - rank.get(b.tier)! || a.cosmeticId - b.cosmeticId),
  };
}

/**
 * Same tiers and weights in the same order, and the same cosmetics in the same tiers. Price and
 * values are left out: they don't change the odds, so a price edit is not an odds change.
 */
export function snapshotsMatch(a: BoxOddsSnapshotData, b: BoxOddsSnapshotData) {
  const tiersOf = (s: BoxOddsSnapshotData) => s.tiers.map((t) => `${t.key}:${t.name}:${t.weight}`);
  const contentsOf = (s: BoxOddsSnapshotData) =>
    s.contents.map((c) => `${c.tier}:${c.cosmeticId}`).sort();
  return (
    tiersOf(a).join('|') === tiersOf(b).join('|') &&
    contentsOf(a).join('|') === contentsOf(b).join('|')
  );
}

/** One side of `diffBoxSnapshots`: a snapshot, or a proposal whose weights may be refused (null). */
export type BoxDiffSide = {
  tiers: { key: string; name: string; weight: number | null }[];
  contents: { tier: string; cosmeticId: number }[];
  price?: number;
};

export type BoxDiff = {
  added: { cosmeticId: number; tier: string }[];
  removed: { cosmeticId: number; tier: string }[];
  moved: { cosmeticId: number; from: string; to: string }[];
  /** Tiers whose weight changed, appeared or went away; a missing side is null. */
  tiers: { key: string; name: string; before: number | null; after: number | null }[];
  price: { before: number; after: number } | null;
};

/** What an edit changes against the live version, by tier key and cosmetic. */
export function diffBoxSnapshots(live: BoxDiffSide, next: BoxDiffSide): BoxDiff {
  const liveTier = new Map(live.contents.map((c) => [c.cosmeticId, c.tier]));
  const nextTier = new Map(next.contents.map((c) => [c.cosmeticId, c.tier]));
  const byId = (a: { cosmeticId: number }, b: { cosmeticId: number }) =>
    a.cosmeticId - b.cosmeticId;

  const only = ({ cosmeticId, tier }: { cosmeticId: number; tier: string }) => ({
    cosmeticId,
    tier,
  });
  const added = next.contents
    .filter((c) => !liveTier.has(c.cosmeticId))
    .map(only)
    .sort(byId);
  const removed = live.contents
    .filter((c) => !nextTier.has(c.cosmeticId))
    .map(only)
    .sort(byId);
  const moved = next.contents
    .filter((c) => liveTier.has(c.cosmeticId) && liveTier.get(c.cosmeticId) !== c.tier)
    .map((c) => ({ cosmeticId: c.cosmeticId, from: liveTier.get(c.cosmeticId)!, to: c.tier }))
    .sort(byId);

  const liveWeights = new Map(live.tiers.map((t) => [t.key, t]));
  const nextWeights = new Map(next.tiers.map((t) => [t.key, t]));
  const keys = [...new Set([...next.tiers.map((t) => t.key), ...live.tiers.map((t) => t.key)])];
  const tiers = keys.flatMap((key) => {
    const before = liveWeights.get(key);
    const after = nextWeights.get(key);
    if (before && after && before.weight === after.weight) return [];
    return [
      {
        key,
        name: (after ?? before)!.name,
        before: before?.weight ?? null,
        after: after?.weight ?? null,
      },
    ];
  });

  const price =
    live.price !== undefined && next.price !== undefined && live.price !== next.price
      ? { before: live.price, after: next.price }
      : null;
  return { added, removed, moved, tiers, price };
}
