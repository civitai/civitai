import { dbRead } from '~/server/db/client';
import { getImageMetricsObject } from '~/server/services/image.service';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Flags } from '~/shared/utils/flags';
import {
  domainBrowsingCeiling,
  onlySelectableLevels,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import type { ColorDomain } from '~/shared/constants/domain.constants';

const MAX_SHOWCASE_IMAGES = 6;

/**
 * Viewer browsing context, used to gate which showcase images (and their
 * gen-meta) are surfaced to the block. Mirrors how the model-page image feed
 * filters by `nsfwLevel` against the viewer's allowed browsing levels
 * (see `getAllImages` in `src/server/services/image.service.ts`, which does
 * `(i."nsfwLevel" & ${browsingLevel}) != 0` after `onlySelectableLevels`).
 *
 * SECURITY: this output is posted into the third-party publisher iframe via
 * `BLOCK_INIT.context.showcaseImages` (IframeHost.tsx). Without this gate an
 * X-rated model would leak explicit image URLs + full prompts/seeds to
 * untrusted publisher code AND to viewers who opted out of NSFW (including
 * logged-out viewers). Anon viewers are forced to the platform's public (PG)
 * level server-side; the caller-supplied `browsingLevel` is never trusted to
 * widen an anon view.
 */
export interface ShowcaseViewer {
  /** The viewer's user id, or null/undefined for anonymous / logged-out. */
  userId?: number | null;
  /**
   * The viewer's requested browsing-level flags (bitwise `NsfwLevel`), as the
   * model-page gallery sends them. Ignored for anon viewers (forced to public).
   * When omitted for a logged-in viewer we fall back to SFW (safe default).
   */
  browsingLevel?: number;
  /**
   * The color domain of the block-host request (`green`/`blue`/`red`). Maps to
   * a maturity CEILING via `domainBrowsingCeiling` that the viewer's resolved
   * level is intersected against — so a logged-in viewer on a SFW domain
   * (green/blue) can't request `browsingLevel: 31` and pull mature thumbnails +
   * gen-meta into the iframe. `undefined`/unknown fails closed to SFW. This is
   * the display-surface analogue of the authoritative generation maturity
   * clamp (blocks.router `resolveBlockMaturity`); `getShowcaseImages` is a
   * public read with no token claim handy, so the request-time `ctx.domain` is
   * the authority for this read. Anon viewers are already capped to public
   * regardless, so the ceiling only ever tightens a logged-in view.
   */
  domain?: ColorDomain | null;
}

/**
 * Resolve the bitwise browsing-level flags a viewer is actually allowed to
 * see, mirroring the model-page feed's gating but fail-closed:
 *   - anonymous / logged-out  → public only (PG), regardless of what was
 *     requested. This matches the platform's anon gate (`applyDomainFeature`
 *     caps anon to `publicBrowsingLevelsFlag`), so the showcase can't surface
 *     a level the model-page gallery wouldn't show that same anon viewer.
 *     Untrusted callers (and the iframe) can't widen this.
 *   - logged-in               → the requested level, with unselectable bits
 *     (Blocked) stripped via `onlySelectableLevels`. Missing / zero falls back
 *     to SFW so a viewer with no settings yet never gets NSFW by default.
 *
 * The resolved level is then INTERSECTED with the color-domain maturity ceiling
 * (`domainBrowsingCeiling(viewer.domain)`): on a SFW domain (green/blue, or an
 * unknown/missing domain which fails closed to SFW) the result can never carry
 * mature bits even when a logged-in viewer requests `browsingLevel: 31`. On a
 * red domain the ceiling is all-levels, so it's a no-op there. (Anon is already
 * forced to public above, so the intersection only ever tightens a logged-in
 * view — `public ⊆ SFW` makes it a no-op for anon.)
 */
function resolveAllowedBrowsingLevel(viewer?: ShowcaseViewer): number {
  const ceiling = domainBrowsingCeiling(viewer?.domain);
  if (!viewer?.userId) return Flags.intersection(publicBrowsingLevelsFlag, ceiling);
  const requested = onlySelectableLevels(viewer.browsingLevel ?? 0);
  const resolved = requested > 0 ? requested : sfwBrowsingLevelsFlag;
  return Flags.intersection(resolved, ceiling);
}

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
  clipSkip: number | null;
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
 *   - nsfwLevel intersects the viewer's allowed browsing levels (see
 *     `resolveAllowedBrowsingLevel` / `ShowcaseViewer`). Anon → SFW only.
 *     Images with `nsfwLevel = 0` (unrated / pending) never intersect and are
 *     therefore excluded — the same fail-closed stance the feed takes for
 *     non-own unrated content.
 *
 * Returns an empty array when the version has no images yet — block UI
 * renders a "no preview images" state rather than crashing.
 */
export async function getModelShowcaseImages(
  modelVersionId: number,
  viewer?: ShowcaseViewer
): Promise<ShowcaseImage[]> {
  const allowedBrowsingLevel = resolveAllowedBrowsingLevel(viewer);
  // ImageResourceNew is the live table; the legacy ImageResource was fully
  // migrated and is now empty (verified 2026-05-25: 0 rows vs 417M).
  const rows = await dbRead.imageResourceNew.findMany({
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
        },
      },
    },
    // Pull a chunk slightly bigger than MAX so we can de-dupe images that
    // showed up under multiple ImageResource rows (e.g. an image that
    // used both this version's checkpoint and a LoRA from the same
    // model) before slicing. Cap at 50 to bound the query cost.
    take: 50,
  });

  // Reaction counts come from ClickHouse (the same source the image feed reads),
  // summing the four reaction kinds into a single reactionCount for sorting.
  const candidateImageIds = Array.from(
    new Set(rows.map((r) => r.image?.id).filter((id): id is number => id != null))
  );
  const reactionByImage = new Map<number, number>();
  if (candidateImageIds.length > 0) {
    const metrics = await getImageMetricsObject(candidateImageIds.map((id) => ({ id })));
    for (const id of candidateImageIds) {
      const m = metrics[id];
      const reactionCount =
        (m?.reactionLike ?? 0) +
        (m?.reactionHeart ?? 0) +
        (m?.reactionLaugh ?? 0) +
        (m?.reactionCry ?? 0);
      reactionByImage.set(id, reactionCount);
    }
  }

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
    // Browsing-level gate: drop any image whose nsfwLevel isn't in the
    // viewer's allowed levels BEFORE the MAX cap, so a wall of NSFW top
    // images doesn't starve a SFW viewer of the SFW ones further down.
    // `Flags.intersects(0, …)` is false → unrated (nsfwLevel = 0) is excluded.
    if (!Flags.intersects(img.nsfwLevel, allowedBrowsingLevel)) continue;
    const reactions = reactionByImage.get(img.id) ?? 0;
    flat.push({ img, reactions });
  }
  flat.sort((a, b) => b.reactions - a.reactions);
  const top = flat.slice(0, MAX_SHOWCASE_IMAGES);

  return top.map(({ img }) => {
    const meta = extractMeta(img.meta);
    // Prefer the meta-recorded generation dimensions over the image-file
    // dimensions when present. Many showcase images are upscaled offline
    // before upload — Image.width/Image.height reflect the post-upscale
    // file, but meta.width/meta.height reflect the actual generator output.
    // Submitting at the post-upscale dims (often 2-3x area) produces a
    // composition that diverges noticeably from the showcase even when
    // every other param matches. Falls back to file dims when meta is
    // missing them (older / non-SD-pipeline images).
    const genWidth = meta.width ?? img.width ?? 0;
    const genHeight = meta.height ?? img.height ?? 0;
    return {
      id: img.id,
      // Echo through the platform's edge-URL helper so the block gets a
      // CDN-cached URL regardless of how the source row stored it.
      url: getEdgeUrl(img.url, { width: 512 }),
      width: genWidth,
      height: genHeight,
      prompt: meta.prompt,
      negativePrompt: meta.negativePrompt,
      cfgScale: meta.cfgScale,
      steps: meta.steps,
      seed: meta.seed,
      sampler: meta.sampler,
      clipSkip: meta.clipSkip,
    };
  });
}

type ExtractedMeta = Omit<ShowcaseImage, 'id' | 'url' | 'width' | 'height'> & {
  width: number | null;
  height: number | null;
};

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
    clipSkip: null,
    width: null,
    height: null,
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
    // 'Clip skip' is the A1111 PascalCase legacy field name — matches what
    // Remix accepts in src/server/services/generation/generation.service.ts.
    clipSkip: asNumber(meta.clipSkip ?? meta['Clip skip'], { min: 0, max: 12, int: true }),
    // Generator-recorded dimensions (pre-upscale). Range bounded generously;
    // the block-side clamp scales anything above 2048 down preserving
    // aspect ratio.
    width: asNumber(meta.width ?? meta.Width, { min: 64, max: 8192, int: true }),
    height: asNumber(meta.height ?? meta.Height, { min: 64, max: 8192, int: true }),
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
