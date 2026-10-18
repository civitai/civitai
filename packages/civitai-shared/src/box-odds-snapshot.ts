import * as z from 'zod';

/**
 * A box's tiers, weights and contents at one published version (`BoxOddsSnapshot.snapshot`). The
 * builder writes it; the odds page reads it, so both share these definitions.
 */
export const boxOddsSnapshotSchema = z.object({
  tiers: z.array(z.object({ key: z.string(), name: z.string(), weight: z.number().int() })),
  contents: z.array(z.object({ tier: z.string(), cosmeticId: z.number().int() })),
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

/** Same tiers and weights in the same order, and the same cosmetics in the same tiers. */
export function snapshotsMatch(a: BoxOddsSnapshotData, b: BoxOddsSnapshotData) {
  const tiersOf = (s: BoxOddsSnapshotData) => s.tiers.map((t) => `${t.key}:${t.name}:${t.weight}`);
  const contentsOf = (s: BoxOddsSnapshotData) =>
    s.contents.map((c) => `${c.tier}:${c.cosmeticId}`).sort();
  return (
    tiersOf(a).join('|') === tiersOf(b).join('|') &&
    contentsOf(a).join('|') === contentsOf(b).join('|')
  );
}
