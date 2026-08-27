import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import {
  COSMETIC_SIMILARITY_CLOSE_RATIO,
  COSMETIC_SIMILARITY_LIMIT,
} from '~/shared/constants/cosmetic-shop.constants';
import type { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

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
 * and matching starts using the new lane as each row lands. All three fields move
 * together — `hexLength` is the one that fails quietly, since a stale value pads
 * every new hash to the wrong width and `hammingDistanceHex` then throws on a
 * comparison the panel reports as an error rather than a distance.
 *
 * Why 256 rather than the 64 this ran at until 2026-08-27: width was the whole
 * problem. Over the 1,719 hashable cosmetics, the two badges reported as
 * imitations of official artwork ranked 7th and 116th of their corpus at 64 bits,
 * against a 1st percentile of 18 — inside the noise. At 256 the same two rank 1st
 * and 5th. `perceptualDct` is also 64 bits and does not help.
 */
export const COSMETIC_PHASH_LANE = {
  version: 'perceptualDct256/256',
  hashType: 'perceptualDct256',
  // The orchestrator may return a hash without leading zeros; every stored hash
  // is padded to this so a distance is never computed across two widths.
  hexLength: 64,
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
  const legacy = legacyBigIntHash(normalized, COSMETIC_PHASH_LANE.hashType);
  await dbWrite.cosmetic.update({
    where: { id },
    data: {
      pHash: legacy,
      pHashHex: normalized,
      pHashUrl: url,
      pHashVersion: COSMETIC_PHASH_LANE.version,
      // Cleared, never stamped. `pHashFailedAt` suppresses re-attempts for a day,
      // and a row that just succeeded must not be suppressed — a lane change makes
      // every recently-hashed row due for re-hashing immediately.
      pHashFailedAt: null,
    },
  });
}

/**
 * Record that hashing FAILED, without touching the hash itself. Artwork whose url
 * no longer resolves can never be hashed, and without this it matches the sweep's
 * predicate on every tick forever, ahead of rows that would have succeeded.
 */
export async function markCosmeticHashFailed(id: number) {
  await dbWrite.cosmetic.update({ where: { id }, data: { pHashFailedAt: new Date() } });
}

/**
 * The value for the legacy `Cosmetic.pHash` BIGINT, or `null` to leave it unset.
 *
 * Gated on the LANE, not the width — and that distinction is the whole point.
 * `perceptualDct` is also 64 bits, so a width test would happily write DCT values
 * into `pHash` beside the existing `perceptual` ones. `pHash` carries no version
 * column of its own, so nothing downstream could ever tell them apart: it is the
 * exact cross-lane mixing the rest of this file exists to prevent.
 *
 * Extracted rather than inlined so it can be tested at a lane we do not currently
 * run. Inline, both the correct and the incorrect form behave identically today,
 * and the difference only appears after a lane bump — when nobody is looking.
 */
export function legacyBigIntHash(normalizedHex: string, hashType: string) {
  if (hashType !== 'perceptual' || normalizedHex.length !== 16) return null;
  return BigInt.asIntN(64, BigInt(`0x${normalizedHex}`));
}

/**
 * Lowercase and left-pad to the lane's width. A hash returned without its leading
 * zeros is the same number and a different string, and only the string is ever
 * compared — `hammingDistanceHex` refuses mismatched widths rather than silently
 * returning a distance computed against a shorter hash.
 */
export function normalizeCosmeticHashHex(hex: string) {
  // Padding is safe in one direction only. A hash WIDER than the lane cannot be
  // padded down, and `padStart` returns it unchanged rather than failing — so it
  // would be stored at full width stamped with the current version, accepted as a
  // comparison TARGET and then excluded from every candidate set by the length
  // filter. That reads as "nothing was close" forever, on a row that looks
  // correctly hashed. The lane's own docblock covers the stale-`hexLength`
  // direction; this is the other one.
  if (hex.length > COSMETIC_PHASH_LANE.hexLength)
    throw new Error(
      `Hash is wider than lane ${COSMETIC_PHASH_LANE.version}: ${hex.length} > ${COSMETIC_PHASH_LANE.hexLength}`
    );
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
        // Deliberately NOT stamped as a failure. `getPerceptualHash` returns
        // undefined both for a real failure and for a workflow still running when
        // the 30s wait elapses, and the two are indistinguishable here — stamping
        // would put a merely-slow submission behind the sweep's 24h backoff, when
        // the panel tells the moderator it will be picked up in about 15 minutes.
        // The sweep re-tries it on its next tick and stamps only if it fails there.
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

export const COSMETIC_SIMILARITY_CLOSE_RATIO_KEY = 'cosmetic-similarity-close-ratio';

/**
 * The near-identical threshold, as a fraction of the hash width.
 *
 * Tunable from the `KeyValue` row so a moderator's threshold can be moved without
 * a deploy — read per call rather than memoised, because a TTL would delay the
 * change by the length of the TTL, which is the entire thing the row exists to
 * avoid.
 *
 * ── FAIL DIRECTION ────────────────────────────────────────────────────────
 *
 * Falls back to the code default on anything unusable, where `client-ip`'s list
 * splitter throws. The difference is what the value gates. Those lists are
 * enforcement controls, and a control that silently switches itself off cannot be
 * detected downstream. This is a REVIEW SIGNAL: it only decides whether a match
 * already on screen is badged "near-identical" or shown as a raw distance. A
 * throw would take out the whole panel — including the ranking, which is the part
 * mods actually use — to fix a badge. The default is measured and known-good, so
 * degrading to it costs a label and keeps the lookup.
 *
 * Out-of-range values are rejected rather than clamped. `1.5` and `-0.2` are
 * typos, not intentions, and clamping 1.5 to 1 would badge every single match as
 * near-identical, which reads as a working threshold rather than a rejected one.
 */
// `0` is allowed and means "only an exact match counts as near-identical", which
// is a coherent thing for an operator to want. `1` is not: it badges every match
// in the list, which is the same degenerate outcome the docblock rejects `1.5`
// for. Rejecting 0 while accepting 1 would fail in the loosening direction on the
// stricter of the two typos.
const closeRatioSchema = z.number().min(0).lt(1);

export async function getCosmeticSimilarityCloseRatio(): Promise<number> {
  let value: unknown;

  // The READ is guarded, not only the value it returns. This is awaited inside
  // `getSimilarCosmetics` AFTER the candidates are ranked, so an escaping
  // rejection discards a completed ranking — and the card renders that as "this
  // artwork was not compared against anything", which is false and is precisely
  // the confusion the card exists to remove.
  try {
    const row = await dbRead.keyValue.findUnique({
      where: { key: COSMETIC_SIMILARITY_CLOSE_RATIO_KEY },
    });
    value = row?.value;
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'cosmetic-phash',
      message: `Could not read KeyValue '${COSMETIC_SIMILARITY_CLOSE_RATIO_KEY}'; using the built-in ${COSMETIC_SIMILARITY_CLOSE_RATIO}.`,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => null);
    return COSMETIC_SIMILARITY_CLOSE_RATIO;
  }

  // An absent row is the ordinary "not configured" state, not a malformed one.
  if (value === null || value === undefined) return COSMETIC_SIMILARITY_CLOSE_RATIO;

  if (!closeRatioSchema.safeParse(value).success) {
    logToAxiom({
      type: 'warning',
      name: 'cosmetic-phash',
      message: `KeyValue '${COSMETIC_SIMILARITY_CLOSE_RATIO_KEY}' is not a fraction between 0 and 1 (got ${JSON.stringify(
        value
      )}); using the built-in ${COSMETIC_SIMILARITY_CLOSE_RATIO}.`,
    }).catch(() => null);
    return COSMETIC_SIMILARITY_CLOSE_RATIO;
  }

  return value as number;
}

export type SimilarCosmetic = {
  id: number;
  name: string;
  type: CosmeticType;
  url: string | undefined;
  distance: number;
  bits: number;
  // Decided here, not in the component. The threshold is operator-tunable at
  // runtime, and a client that recomputes it from a bundled constant silently
  // disagrees with the server until every tab reloads.
  close: boolean;
  createdById: number | null;
  createdByUsername: string | null;
  // `null` = never listed in a shop at all, which is what every official cosmetic
  // looks like. Distinct from a listing that exists and is not live.
  shopStatus: CosmeticShopItemStatus | null;
};

// A cosmetic can carry several listings (cross-listing, resale), so the panel
// needs one label. What a moderator is deciding is whether the thing they are
// looking at is already on sale, so a live listing outranks everything; below
// that, the further through review a listing got, the more it says.
const SHOP_STATUS_PRECEDENCE: CosmeticShopItemStatus[] = [
  'Published',
  'PendingReview',
  'RequestedChanges',
  'Rejected',
  'Archived',
  'Draft',
];

function summariseShopStatus(statuses: CosmeticShopItemStatus[]) {
  return SHOP_STATUS_PRECEDENCE.find((s) => statuses.includes(s)) ?? null;
}

export type CosmeticSimilarityResult =
  | { status: 'unavailable'; reason: 'no-hash' | 'stale-hash' | 'flat-artwork' | 'no-corpus' }
  | { status: 'ok'; comparedAgainst: number; bits: number; matches: SimilarCosmetic[] };

export function hammingDistanceHex(a: string, b: string) {
  // Same-lane hashes are the same width by construction, and the candidate query
  // filters on length as well, so this should be unreachable. It throws anyway:
  // a distance between two widths is a meaningless number that looks like a
  // meaningful one, and nothing downstream could tell.
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
      AND length("pHashHex") = ${targetHex.length}
      AND id != ${cosmeticId}
  `;

  const nearest = candidates
    .map(({ id, pHashHex }) => ({ id, distance: hammingDistanceHex(targetHex, pHashHex) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

  // "Nothing was close" and "there was nothing to be close to" are the same empty
  // list and completely different verdicts. Right after a lane bump the candidate
  // set is empty by construction while the sweep drains, so an `ok` here would
  // hand a moderator a green all-clear built on zero comparisons — a check that
  // cannot fail, which is the failure this whole panel exists to remove.
  if (!candidates.length) return { status: 'unavailable', reason: 'no-corpus' };

  if (!nearest.length)
    return { status: 'ok', comparedAgainst: candidates.length, bits, matches: [] };

  const closeRatio = await getCosmeticSimilarityCloseRatio();
  const closeAtOrUnder = bits * closeRatio;
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
      cosmeticShopItems: { select: { status: true } },
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
      close: (distanceById.get(cosmetic.id) as number) <= closeAtOrUnder,
      createdById: cosmetic.createdById,
      createdByUsername: cosmetic.creator?.username ?? null,
      shopStatus: summariseShopStatus(cosmetic.cosmeticShopItems.map((i) => i.status)),
    }))
    .sort((a, b) => a.distance - b.distance);

  return { status: 'ok', comparedAgainst: candidates.length, bits, matches };
}
