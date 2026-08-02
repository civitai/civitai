import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';

// Deliberately kept out of cosmetic.service, which reaches ~/server/search-index
// and so meilisearch/client — a module that builds pLimit and prom collectors at
// import. Callers here only need to hash artwork, and shouldn't take that graph on.

export function getCosmeticArtworkUrl(data: Prisma.JsonValue | undefined) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const url = (data as { url?: unknown }).url;
  return typeof url === 'string' && url.length ? url : undefined;
}

/**
 * Fire-and-forget: a cosmetic must land whether or not the orchestrator answers,
 * so this never blocks the write and never throws. Rows left NULL are picked up
 * by scripts/oneoffs/backfill-cosmetic-phash.ts.
 */
export function queueCosmeticPerceptualHash({ id, url }: { id: number; url: string }) {
  getPerceptualHash(url)
    .then(async (pHash) => {
      // `0n` is a real hash (solid-colour artwork), not a miss.
      if (pHash === undefined) {
        await logToAxiom({
          type: 'warning',
          name: 'cosmetic-phash',
          message: `No perceptual hash returned for cosmetic ${id} (${url})`,
        }).catch(() => null);
        return;
      }
      // pHashUrl records what was actually hashed. Paths that swap `data.url`
      // without going through here leave the two disagreeing, which is what the
      // backfill re-sweeps on — a stale hash is worse than no hash.
      await dbWrite.cosmetic.update({ where: { id }, data: { pHash, pHashUrl: url } });
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
