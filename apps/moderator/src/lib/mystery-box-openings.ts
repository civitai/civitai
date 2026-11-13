import type { BoxOddsSnapshotData } from '@civitai/shared/box-odds-snapshot';

export type OpeningGroup = {
  boxVersion: number;
  tierId: number;
  /** The summed weight of the tiers the opener had anything left in, as recorded. */
  eligibleWeight: number;
  count: number;
};

export type TierStat = {
  tierId: number;
  key: string | null;
  name: string;
  observed: number;
  /** Opens where every tier was still open to the opener: only there is the tier chance known. */
  fullBoxObserved: number;
  /** Null with no snapshot for the version, or when `tiersChanged`. */
  fullBoxExpected: number | null;
};

export type VersionStat = {
  version: number;
  opens: number;
  fullBoxOpens: number | null;
  /**
   * Draws from a tier since removed: opens record a tier id but the snapshot names tiers by key, so a
   * tier re-added under the same key can't be matched. Nothing is compared rather than showing the
   * new tier as never drawn.
   */
  tiersChanged: boolean;
  tiers: TierStat[];
};

/** A tier's place in the version's draw order; tiers the snapshot doesn't name go last. */
const rankOf = (snapshot: BoxOddsSnapshotData | undefined, key: string | null) => {
  const index = snapshot?.tiers.findIndex((tier) => tier.key === key) ?? -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

/**
 * A draw records only its own tier's weight and the eligible total, so a tier's chance is known only
 * on opens where every tier was open (`eligibleWeight` equals the version's full weight sum). Only
 * those get an expected count; the rest are counted, not judged: collecting shifts the odds, so
 * comparing them with the base odds would flag a fair box.
 */
export function openingStats(
  groups: OpeningGroup[],
  snapshots: Map<number, BoxOddsSnapshotData>,
  liveTiers: { id: number; key: string; name: string }[]
): VersionStat[] {
  const liveById = new Map(liveTiers.map((tier) => [tier.id, tier]));
  const versions = [...new Set(groups.map((g) => g.boxVersion))].sort((a, b) => b - a);
  return versions.map((version) => {
    const inVersion = groups.filter((g) => g.boxVersion === version);
    const snapshot = snapshots.get(version);
    const fullWeight = snapshot?.tiers.reduce((sum, tier) => sum + tier.weight, 0);
    const fullBoxOpens =
      fullWeight === undefined
        ? null
        : inVersion
            .filter((g) => g.eligibleWeight === fullWeight)
            .reduce((sum, g) => sum + g.count, 0);

    const byTier = new Map<number, TierStat>();
    const statFor = (tierId: number) => {
      let stat = byTier.get(tierId);
      if (!stat) {
        const live = liveById.get(tierId);
        stat = {
          tierId,
          key: live?.key ?? null,
          name: live?.name ?? `Removed tier #${tierId}`,
          observed: 0,
          fullBoxObserved: 0,
          fullBoxExpected: null,
        };
        byTier.set(tierId, stat);
      }
      return stat;
    };
    for (const group of inVersion) {
      const stat = statFor(group.tierId);
      stat.observed += group.count;
      if (group.eligibleWeight === fullWeight) stat.fullBoxObserved += group.count;
    }
    // A tier that never comes up must still be listed.
    if (snapshot)
      for (const tier of liveTiers)
        if (snapshot.tiers.some((s) => s.key === tier.key)) statFor(tier.id);
    const tiersChanged = [...byTier.values()].some((stat) => stat.key === null);
    for (const stat of byTier.values()) {
      if (tiersChanged) break;
      const weight = snapshot?.tiers.find((tier) => tier.key === stat.key)?.weight;
      if (fullBoxOpens !== null && fullWeight && weight !== undefined)
        stat.fullBoxExpected = (fullBoxOpens * weight) / fullWeight;
    }
    return {
      version,
      opens: inVersion.reduce((sum, g) => sum + g.count, 0),
      fullBoxOpens,
      tiersChanged,
      tiers: [...byTier.values()].sort(
        (a, b) => rankOf(snapshot, a.key) - rankOf(snapshot, b.key) || a.tierId - b.tierId
      ),
    };
  });
}
