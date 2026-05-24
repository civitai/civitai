import { dbRead } from '~/server/db/client';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

const MAX_SHOWCASE_IMAGES = 6;

/**
 * Bounded, public-safe view of a showcase image the block displays to
 * populate its prompt input from. Only fields the block UI uses get
 * surfaced — `meta` is a wide JSONB on the source row and we cherry-pick
 * the standard gen params, dropping any unrecognized keys.
 *
 * `null` on a meta field means "the source image didn't have this set" or
 * "the value was malformed". Block reads null as "leave this field on its
 * current value."
 */
export interface ShowcaseImage {
  id: number;
  url: string;
  width: number;
  height: number;
  prompt: string | null;
  negativePrompt: string | null;
  cfgScale: number | null;
  steps: number | null;
  seed: number | null;
  sampler: string | null;
}

/**
 * Fetch up to N images for a model version, ordered by all-time reaction
 * count. The query goes through ImageResource (the M:N join) so we only
 * pull images that were actually generated using this specific version.
 *
 * Filters:
 *   - ingestion: Scanned (the moderation gate the rest of the platform
 *     already enforces; unmoderated images are never surfaced).
 *   - tosViolation: false (defense in depth — Scanned alone is supposed
 *     to drop these, but enforce here too).
 *   - postId IS NOT NULL (orphaned images shouldn't show up).
 *
 * Returns an empty array when the version has no images yet — block UI
 * renders a "no preview images" state rather than crashing.
 */
export async function getModelShowcaseImages(modelVersionId: number): Promise<ShowcaseImage[]> {
  const rows = await dbRead.imageResource.findMany({
    where: {
      modelVersionId,
      image: {
        ingestion: 'Scanned',
        tosViolation: false,
        postId: { not: null },
      },
    },
    select: {
      image: {
        select: {
          id: true,
          url: true,
          width: true,
          height: true,
          meta: true,
          nsfwLevel: true,
          metrics: {
            where: { timeframe: 'AllTime' },
            select: { reactionCount: true },
            take: 1,
          },
        },
      },
    },
    // Pull a chunk slightly bigger than MAX so we can de-dupe images that
    // showed up under multiple ImageResource rows (e.g. an image that
    // used both this version's checkpoint and a LoRA from the same
    // model) before slicing. Cap at 50 to bound the query cost.
    take: 50,
  });

  // De-dupe (one Image can have multiple ImageResource rows) + sort by
  // reactionCount desc. Doing this in JS instead of via Prisma's
  // orderBy-through-relation lets us avoid Prisma's 1:many orderBy
  // restriction; the upstream cap of 50 makes this cheap.
  const seen = new Set<number>();
  const flat: Array<{ img: (typeof rows)[number]['image']; reactions: number }> = [];
  for (const row of rows) {
    const img = row.image;
    if (!img || seen.has(img.id)) continue;
    seen.add(img.id);
    const reactions = img.metrics[0]?.reactionCount ?? 0;
    flat.push({ img, reactions });
  }
  flat.sort((a, b) => b.reactions - a.reactions);
  const top = flat.slice(0, MAX_SHOWCASE_IMAGES);

  return top.map(({ img }) => {
    const meta = extractMeta(img.meta);
    return {
      id: img.id,
      // Echo through the platform's edge-URL helper so the block gets a
      // CDN-cached URL regardless of how the source row stored it.
      url: getEdgeUrl(img.url, { width: 512 }),
      width: img.width ?? 0,
      height: img.height ?? 0,
      prompt: meta.prompt,
      negativePrompt: meta.negativePrompt,
      cfgScale: meta.cfgScale,
      steps: meta.steps,
      seed: meta.seed,
      sampler: meta.sampler,
    };
  });
}

type ExtractedMeta = Omit<ShowcaseImage, 'id' | 'url' | 'width' | 'height'>;

/**
 * Best-effort extraction of standard gen params from Image.meta. The
 * JSONB has no schema enforcement — different generators historically
 * wrote different shapes — so each field gets defensive runtime checks.
 * Unrecognized / malformed values become null; the block treats null as
 * "keep current value" so a partial meta doesn't trash the user's edits.
 */
function extractMeta(rawMeta: unknown): ExtractedMeta {
  const empty: ExtractedMeta = {
    prompt: null,
    negativePrompt: null,
    cfgScale: null,
    steps: null,
    seed: null,
    sampler: null,
  };
  if (!rawMeta || typeof rawMeta !== 'object') return empty;
  const meta = rawMeta as Record<string, unknown>;
  return {
    prompt: asTrimmedString(meta.prompt),
    // Two historical field names; prefer the camelCase one.
    negativePrompt: asTrimmedString(meta.negativePrompt ?? meta['Negative prompt']),
    cfgScale: asNumber(meta.cfgScale ?? meta['CFG scale'] ?? meta.cfg_scale, { min: 1, max: 30 }),
    steps: asNumber(meta.steps ?? meta.Steps, { min: 1, max: 200, int: true }),
    seed: asNumber(meta.seed ?? meta.Seed, { min: 0, int: true }),
    sampler: asTrimmedString(meta.sampler ?? meta.Sampler),
  };
}

function asTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(v: unknown, opts: { min?: number; max?: number; int?: boolean }): number | null {
  // Accept numeric strings too — older generators sometimes stamped
  // metadata as strings in the JSON.
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (opts.int && !Number.isInteger(n)) return null;
  if (opts.min != null && n < opts.min) return null;
  if (opts.max != null && n > opts.max) return null;
  return n;
}
