import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { COSMETIC_SIMILARITY_LIMIT } from '~/shared/constants/cosmetic-shop.constants';
import type { CosmeticType } from '~/shared/utils/prisma/enums';

// Deliberately kept out of cosmetic.service, which reaches ~/server/search-index
// and so meilisearch/client — a module that builds pLimit and prom collectors at
// import. Callers here only need to hash artwork, and shouldn't take that graph on.

/**
 * The hash lane this app currently asks for, recorded on every row it writes.
 *
 * Hashes from different algorithms are statistically independent — comparing
 * across them produces noise, with nothing to signal it — so a row is only ever
 * compared against rows carrying this exact string, and the sweep job re-hashes
 * anything that does not.
 *
 * **Raising this is the upgrade path.** When the orchestrator offers a wider
 * hash, change this constant; the sweep drains the corpus on its own schedule
 * and matching starts using the new lane as each row lands.
 *
 * Measured 2026-08-14, and the reason a wider lane is wanted: at 64 bits the two
 * badges reported as imitations of official artwork sit at Hamming 17 and 22
 * against a corpus whose 1st percentile is 17. `perceptualDct` is also 64 bits
 * and does not help (14 and 24 on the same pair).
 */
export const COSMETIC_PHASH_LANE = {
  version: 'perceptual/64',
  hashType: 'perceptual',
  // The orchestrator may return a hash without leading zeros; every stored hash
  // is padded to this so a distance is never computed across two widths.
  hexLength: 16,
} as const;

export const COSMETIC_PHASH_VERSION = COSMETIC_PHASH_LANE.version;

export function getCosmeticArtworkUrl(data: Prisma.JsonValue | undefined) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const url = (data as { url?: unknown }).url;
  return typeof url === 'string' && url.length ? url : undefined;
}

/**
 * Persist a freshly-computed hash for a cosmetic.
 *
 * `pHashUrl` records what was actually hashed and `pHashVersion` records how:
 * paths that swap `data.url` with a raw UPDATE leave the first disagreeing, and
 * a lane change leaves the second. Both are how the sweep finds work, and both
 * are why a lookup can trust what it compares.
 *
 * `pHash` (BIGINT) is still written while the lane is 64 bits so the legacy
 * column stays usable; it is left null once a wider hash makes it unrepresentable.
 */
export async function storeCosmeticPerceptualHash({
  id,
  url,
  hex,
}: {
  id: number;
  url: string;
  hex: string;
}) {
  const normalized = normalizeCosmeticHashHex(hex);
  const legacy = normalized.length === 16 ? BigInt.asIntN(64, BigInt(`0x${normalized}`)) : null;
  await dbWrite.cosmetic.update({
    where: { id },
    data: {
      pHash: legacy,
      pHashHex: normalized,
      pHashUrl: url,
      pHashVersion: COSMETIC_PHASH_LANE.version,
      pHashCheckedAt: new Date(),
    },
  });
}

/**
 * Record that hashing was ATTEMPTED and produced nothing, without touching the
 * hash itself. Artwork whose url no longer resolves can never be hashed, and
 * without this it matches the sweep's predicate on every tick forever, ahead of
 * rows that would have succeeded.
 */
export async function markCosmeticHashAttempted(id: number) {
  await dbWrite.cosmetic.update({ where: { id }, data: { pHashCheckedAt: new Date() } });
}

/**
 * Lowercase and left-pad to the lane's width. A hash returned without its leading
 * zeros is the same number and a different string, and only the string is ever
 * compared — `hammingDistanceHex` refuses mismatched widths rather than silently
 * returning a distance computed against a shorter hash.
 */
export function normalizeCosmeticHashHex(hex: string) {
  return hex.toLowerCase().padStart(COSMETIC_PHASH_LANE.hexLength, '0');
}

/**
 * Fire-and-forget: a cosmetic must land whether or not the orchestrator answers,
 * so this never blocks the write and never throws. Rows left unhashed are picked
 * up by the `cosmetic-phash-sweep` job.
 */
export function queueCosmeticPerceptualHash({ id, url }: { id: number; url: string }) {
  getPerceptualHash(url, COSMETIC_PHASH_LANE.hashType)
    .then(async (hex) => {
      if (hex === undefined) {
        await markCosmeticHashAttempted(id).catch(() => null);
        await logToAxiom({
          type: 'warning',
          name: 'cosmetic-phash',
          message: `No perceptual hash returned for cosmetic ${id} (${url})`,
        }).catch(() => null);
        return;
      }
      await storeCosmeticPerceptualHash({ id, url, hex });
    })
    .catch((error) =>
      logToAxiom({
        type: 'error',
        name: 'cosmetic-phash',
        message: `Perceptual hash failed for cosmetic ${id} (${url})`,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => null)
    );
}

export type SimilarCosmetic = {
  id: number;
  name: string;
  type: CosmeticType;
  url: string | undefined;
  distance: number;
  bits: number;
  createdById: number | null;
  createdByUsername: string | null;
};

export type CosmeticSimilarityResult =
  | { status: 'unavailable'; reason: 'no-hash' | 'stale-hash' | 'flat-artwork' }
  | { status: 'ok'; comparedAgainst: number; bits: number; matches: SimilarCosmetic[] };

export function hammingDistanceHex(a: string, b: string) {
  // Same-lane hashes are the same width by construction; a mismatch means the
  // caller compared across lanes, which yields a meaningless number rather than
  // an error unless it is refused here.
  if (a.length !== b.length) throw new Error(`Hash width mismatch: ${a.length} vs ${b.length}`);
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let nibble = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (nibble) {
      nibble &= nibble - 1;
      bits++;
    }
  }
  return bits;
}

// Mostly-transparent artwork (avatar decorations especially) flattens to a
// uniform image and hashes to all-zero. That is a legitimate hash of a near-empty
// picture, not a fingerprint: 19 unrelated cosmetics share it today, so matching
// on it means nothing and would bury every real result.
const isDegenerateHash = (hex: string) => /^0+$/.test(hex);

/**
 * Nearest perceptually-similar cosmetics to `cosmeticId`, closest first.
 *
 * Both sides are gated on `pHashUrl = data->>'url'` and on the current hash
 * version: a hash that describes artwork the cosmetic no longer uses, or that
 * came from a different algorithm, compares against something nobody can see.
 *
 * The `unavailable` result is not an empty match list, and callers must not
 * render it as one. "We compared this against 950 cosmetics and none were close"
 * and "this artwork was never hashed" look identical as a blank panel, and one of
 * them is a reason to look harder.
 */
export async function getSimilarCosmetics({
  cosmeticId,
  limit = COSMETIC_SIMILARITY_LIMIT,
}: {
  cosmeticId: number;
  limit?: number;
}): Promise<CosmeticSimilarityResult> {
  const target = await dbRead.cosmetic.findUnique({
    where: { id: cosmeticId },
    select: { pHashHex: true, pHashUrl: true, pHashVersion: true, data: true },
  });

  if (!target?.pHashHex || target.pHashVersion !== COSMETIC_PHASH_LANE.version)
    return { status: 'unavailable', reason: 'no-hash' };
  if (target.pHashUrl !== getCosmeticArtworkUrl(target.data))
    return { status: 'unavailable', reason: 'stale-hash' };
  if (isDegenerateHash(target.pHashHex)) return { status: 'unavailable', reason: 'flat-artwork' };

  const targetHex = target.pHashHex;
  const bits = targetHex.length * 4;

  const candidates = await dbRead.$queryRaw<Array<{ id: number; pHashHex: string }>>`
    SELECT id, "pHashHex"
    FROM "Cosmetic"
    WHERE "pHashHex" IS NOT NULL
      AND "pHashVersion" = ${COSMETIC_PHASH_LANE.version}
      AND "pHashUrl" = data->>'url'
      AND "pHashHex" !~ '^0+$'
      AND id != ${cosmeticId}
  `;

  const nearest = candidates
    .map(({ id, pHashHex }) => ({ id, distance: hammingDistanceHex(targetHex, pHashHex) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

  if (!nearest.length)
    return { status: 'ok', comparedAgainst: candidates.length, bits, matches: [] };

  const distanceById = new Map(nearest.map((n) => [n.id, n.distance]));
  const details = await dbRead.cosmetic.findMany({
    where: { id: { in: nearest.map((n) => n.id) } },
    select: {
      id: true,
      name: true,
      type: true,
      data: true,
      createdById: true,
      creator: { select: { username: true } },
    },
  });

  const matches = details
    .map((cosmetic) => ({
      id: cosmetic.id,
      name: cosmetic.name,
      type: cosmetic.type,
      url: getCosmeticArtworkUrl(cosmetic.data),
      distance: distanceById.get(cosmetic.id) as number,
      bits,
      createdById: cosmetic.createdById,
      createdByUsername: cosmetic.creator?.username ?? null,
    }))
    .sort((a, b) => a.distance - b.distance);

  return { status: 'ok', comparedAgainst: candidates.length, bits, matches };
}
