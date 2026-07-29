import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import { baseModelRecords, ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  getComparisonLoraCountKeys,
  getConfigEcosystemKeys,
  getEcosystemSeoConfig,
  type EcosystemSeoConfig,
} from '~/shared/constants/ecosystem-seo.constants';

const TTL = CacheTTL.day; // 24h — see docs/features/ecosystem-seo-pages.md
// Bump when the cached EcosystemSeoData shape changes, so stale entries are ignored instead of
// deserialized into the new shape (e.g. examples gained `type`; stats gained the media fallback).
const CACHE_VERSION = 'v4';
/** PG-only. Model.nsfw flag alone isn't enough; nsfwLevel catches SFW-flagged models with R+ imagery. */
const SFW_MAX_NSFW_LEVEL = 1;
const LORA_TYPES = ['LORA', 'LoCon', 'DoRA'];

export type EcosystemSeoStats = {
  modelCount: number;
  loraCount: number;
  generationCount: number;
};

export type EcosystemSeoLora = {
  modelId: number;
  versionId: number;
  name: string;
  downloadCount: number;
  generationCount: number;
  /** SFW cover url. Undefined if the LoRA has no PG-rated showcase media at all. */
  imageUrl?: string;
  /** Media type of `imageUrl` — a video LoRA's showcase is often a still, so it can differ from the page. */
  imageType?: 'image' | 'video';
};

export type EcosystemSeoFeaturedModel = {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  note?: string;
  /** SFW thumbnail url (Cloudflare image key). Undefined if the curated image failed the NSFW re-check. */
  imageUrl?: string;
  /** All-time metrics (0 for hosted/engine models with no ModelMetric usage). */
  downloadCount: number;
  generationCount: number;
  /**
   * False for a curated Checkpoint that isn't in `EcosystemCheckpoints` (only generatable if it
   * wins an auction slot). The card links to the model page instead of offering a dead Generate.
   */
  generatable: boolean;
};

export type EcosystemSeoExample = {
  imageId: number;
  url: string;
  width: number | null;
  height: number | null;
  prompt: string;
  settings: string;
  type: 'image' | 'video';
};

export type EcosystemSeoData = {
  stats: EcosystemSeoStats;
  topLoras: EcosystemSeoLora[];
  featuredModels: EcosystemSeoFeaturedModel[];
  featuredExamples: EcosystemSeoExample[];
  /**
   * Live LoRA counts keyed by ecosystem SEO key, for the `{loras:Key}` tokens in the comparison
   * table. Same query as the hero stat, so a peer's number reads the same on every page that
   * mentions it.
   */
  loraCounts: Record<string, number>;
};

/**
 * `baseModel` strings for a single ecosystem key's OWN records (matched by `ecosystemId`) —
 * no `familyId` or `parentEcosystemId` expansion. A page's scope is the union of this over its
 * declared keys (`key` + `additionalEcosystemKeys`), so counts and the "Browse models" deep-link
 * never bleed into siblings/children that own their own page: Stable Diffusion (SD1) excludes
 * SDXL despite the shared family, and SDXL excludes its Pony/Illustrious/NoobAI children. Pages
 * that genuinely cover a variant (Flux → Krea/Kontext, Flux.2 → Klein) declare it explicitly.
 * Values are exact DB casing (e.g. `Flux.1 D`); the /models search matches `baseModel IN (...)`
 * case-sensitively.
 */
export function getEcosystemOwnBaseModels(key: string): string[] {
  const ecosystem = ecosystemByKey.get(key);
  if (!ecosystem) return [];
  return baseModelRecords.filter((r) => r.ecosystemId === ecosystem.id).map((r) => r.name);
}

/** Showcase media type for a page — video ecosystems (Wan, etc.) render clips, not stills. */
function mediaTypeForConfig(config: EcosystemSeoConfig): 'image' | 'video' {
  return config.modality === 'video' ? 'video' : 'image';
}

async function computeEcosystemSeoData(config: EcosystemSeoConfig): Promise<EcosystemSeoData> {
  // Scope to the page's own declared ecosystems (key + additionalEcosystemKeys) — no family bleed.
  const scopedBaseModels = [
    ...new Set(getConfigEcosystemKeys(config).flatMap((key) => getEcosystemOwnBaseModels(key))),
  ];
  const baseModelIn =
    scopedBaseModels.length > 0 ? Prisma.join(scopedBaseModels) : Prisma.sql`NULL`;

  const mediaType = mediaTypeForConfig(config);
  const featuredModelIds = config.featuredModels.map((m) => m.modelId);
  const [stats, topLoras, featuredModels, featuredExamples, peerLoraCounts] = await Promise.all([
    getStats(baseModelIn),
    getTopLoras(baseModelIn, featuredModelIds, mediaType),
    resolveFeaturedModels(config, mediaType),
    resolveFeaturedExamples(config),
    getPeerLoraCounts(config),
  ]);

  return {
    stats,
    topLoras,
    featuredModels,
    featuredExamples,
    loraCounts: { ...peerLoraCounts, [config.key]: stats.loraCount },
  };
}

/**
 * LoRA counts for the other ecosystems this page's comparison table cites (`{loras:Key}` tokens),
 * using the same definition as the hero stat. Hand-written numbers drifted apart across pages —
 * Illustrious read 187K/290K/294K depending on which page you were on.
 */
async function getPeerLoraCounts(config: EcosystemSeoConfig): Promise<Record<string, number>> {
  const keys = getComparisonLoraCountKeys(config).filter((key) => key !== config.key);
  const counts = await Promise.all(
    keys.map(async (key) => {
      const peer = getEcosystemSeoConfig(key);
      if (!peer) return [key, 0] as const;
      const baseModels = [
        ...new Set(getConfigEcosystemKeys(peer).flatMap((k) => getEcosystemOwnBaseModels(k))),
      ];
      if (baseModels.length === 0) return [key, 0] as const;
      return [key, await getLoraCount(Prisma.join(baseModels))] as const;
    })
  );
  return Object.fromEntries(counts);
}

async function getLoraCount(baseModelIn: Prisma.Sql): Promise<number> {
  const rows = await dbRead.$queryRaw<{ lora_count: bigint }[]>(Prisma.sql`
    SELECT count(DISTINCT m.id)::bigint AS lora_count
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    WHERE mv."baseModel" IN (${baseModelIn})
      AND m.status = 'Published' AND m.nsfw = false
      AND m.type::text IN (${Prisma.join(LORA_TYPES)})
  `);
  return Number(rows[0]?.lora_count ?? 0);
}

async function getStats(baseModelIn: Prisma.Sql): Promise<EcosystemSeoStats> {
  const rows = await dbRead.$queryRaw<
    { model_count: bigint; lora_count: bigint; generation_count: bigint }[]
  >(Prisma.sql`
    WITH eco_models AS (
      SELECT DISTINCT m.id, m.type
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id
      WHERE mv."baseModel" IN (${baseModelIn})
        AND m.status = 'Published' AND m.nsfw = false
    )
    SELECT
      count(*)::bigint AS model_count,
      count(*) FILTER (WHERE type IN ('LORA','LoCon','DoRA'))::bigint AS lora_count,
      COALESCE(sum(mm."generationCount"), 0)::bigint AS generation_count
    FROM eco_models em
    LEFT JOIN "ModelMetric" mm ON mm."modelId" = em.id
  `);
  const row = rows[0];
  let generationCount = Number(row?.generation_count ?? 0);
  // Engine/API ecosystems (Kling, Grok, Seedance, …) don't accrue ModelMetric.generationCount:
  // generations run through the hosted engine, not a community checkpoint, so nothing increments
  // the model's metric. Fall back to the count of media actually created with the ecosystem
  // on-site (via resource links) so the "generated" stat reflects real usage instead of 0.
  if (generationCount === 0) {
    const mediaRows = await dbRead.$queryRaw<{ media_count: bigint }[]>(Prisma.sql`
      SELECT count(DISTINCT ir."imageId")::bigint AS media_count
      FROM "ImageResourceNew" ir
      JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
      WHERE mv."baseModel" IN (${baseModelIn})
    `);
    generationCount = Number(mediaRows[0]?.media_count ?? 0);
  }
  return {
    modelCount: Number(row?.model_count ?? 0),
    loraCount: Number(row?.lora_count ?? 0),
    generationCount,
  };
}

async function getTopLoras(
  baseModelIn: Prisma.Sql,
  excludedModelIds: number[],
  mediaType: 'image' | 'video'
): Promise<EcosystemSeoLora[]> {
  // Don't repeat LoRAs already shown in the curated "Featured models" section.
  const excludeSql =
    excludedModelIds.length > 0
      ? Prisma.sql`AND m.id NOT IN (${Prisma.join(excludedModelIds)})`
      : Prisma.empty;
  const rows = await dbRead.$queryRaw<
    {
      model_id: number;
      version_id: number;
      name: string;
      download_count: number;
      generation_count: number;
    }[]
  >(Prisma.sql`
    WITH eco_loras AS (
      SELECT m.id, m.name, max(mv.id) AS version_id
      FROM "Model" m
      JOIN "ModelVersion" mv ON mv."modelId" = m.id
      WHERE mv."baseModel" IN (${baseModelIn})
        AND mv.status = 'Published'
        AND m.status = 'Published' AND m.nsfw = false AND m."minor" = false
        AND m.type::text IN (${Prisma.join(LORA_TYPES)})
        ${excludeSql}
      GROUP BY m.id, m.name
    )
    SELECT el.id AS model_id, el.version_id, el.name,
      mm."downloadCount" AS download_count, mm."generationCount" AS generation_count
    FROM eco_loras el
    JOIN "ModelMetric" mm ON mm."modelId" = el.id
    WHERE mm."nsfwLevel" <= ${SFW_MAX_NSFW_LEVEL}
    ORDER BY mm."downloadCount" DESC NULLS LAST
    LIMIT 12
  `);

  const loras = rows.map((r) => ({
    modelId: r.model_id,
    versionId: r.version_id,
    name: r.name,
    downloadCount: Number(r.download_count ?? 0),
    generationCount: Number(r.generation_count ?? 0),
  }));

  // Cover media via the shared per-version cache (day TTL) — no per-model scan.
  // Prefer the page's media type, but fall back to any PG-rated showcase item: a video LoRA
  // whose showcase is a still would otherwise render as a coverless card. Over-fetch and drop
  // the ones with no usable cover so the row is always full.
  const imagesByVersion = await imagesForModelVersionsCache.fetch(loras.map((l) => l.versionId));
  return loras
    .map((l): EcosystemSeoLora | null => {
      const candidates = (imagesByVersion[l.versionId]?.images ?? []).filter(
        (img) => img.nsfwLevel > 0 && img.nsfwLevel <= SFW_MAX_NSFW_LEVEL
      );
      const cover = candidates.find((img) => img.type === mediaType) ?? candidates[0];
      if (!cover) return null;
      return { ...l, imageUrl: cover.url, imageType: cover.type as 'image' | 'video' };
    })
    .filter((l): l is EcosystemSeoLora => l !== null)
    .slice(0, 6);
}

/** Fetch SFW (PG-only) media of a given type by id, keyed by id. NSFW/under-review is simply absent. */
async function fetchSfwMedia(ids: number[], mediaType: 'image' | 'video') {
  if (ids.length === 0)
    return new Map<number, { url: string; width: number | null; height: number | null }>();
  const images = await dbRead.image.findMany({
    where: {
      id: { in: ids },
      type: mediaType,
      nsfwLevel: { lte: SFW_MAX_NSFW_LEVEL, gt: 0 },
      needsReview: null,
    },
    select: { id: true, url: true, width: true, height: true },
  });
  return new Map(images.map((i) => [i.id, { url: i.url, width: i.width, height: i.height }]));
}

async function resolveFeaturedModels(
  config: EcosystemSeoConfig,
  mediaType: 'image' | 'video'
): Promise<EcosystemSeoFeaturedModel[]> {
  const ids = config.featuredModels.map((m) => m.modelId);
  if (ids.length === 0) return [];
  const versionIds = config.featuredModels.map((m) => m.versionId);
  const [models, imagesById, availableCheckpoints, metrics] = await Promise.all([
    dbRead.model.findMany({
      where: { id: { in: ids }, status: 'Published', nsfw: false },
      select: { id: true, name: true, type: true },
    }),
    fetchSfwMedia(
      config.featuredModels.map((m) => m.imageId),
      mediaType
    ),
    // Checkpoints in EcosystemCheckpoints are always generatable; others are only
    // available depending on auction results, so a featured checkpoint must be in here.
    dbRead.ecosystemCheckpoints.findMany({
      where: { id: { in: versionIds } },
      select: { id: true },
    }),
    dbRead.modelMetric.findMany({
      where: { modelId: { in: ids } },
      select: { modelId: true, downloadCount: true, generationCount: true },
    }),
  ]);
  const byId = new Map(models.map((m) => [m.id, m]));
  const metricByModel = new Map(metrics.map((m) => [m.modelId, m]));
  const availableVersionIds = new Set(availableCheckpoints.map((c) => c.id));

  // Engine/hosted models have no ModelMetric.generationCount (see getStats). For those featured
  // versions only, fall back to the count of media created with that specific version — bounded
  // and gated to zero-metric versions, so it never scans a big community checkpoint's images.
  const zeroGenVersionIds = config.featuredModels
    .filter((m) => Number(metricByModel.get(m.modelId)?.generationCount ?? 0) === 0)
    .map((m) => m.versionId);
  const versionGenFallback = new Map<number, number>();
  if (zeroGenVersionIds.length > 0) {
    const rows = await dbRead.$queryRaw<{ version_id: number; media_count: bigint }[]>(Prisma.sql`
      SELECT ir."modelVersionId" AS version_id, count(DISTINCT ir."imageId")::bigint AS media_count
      FROM "ImageResourceNew" ir
      WHERE ir."modelVersionId" IN (${Prisma.join(zeroGenVersionIds)})
      GROUP BY ir."modelVersionId"
    `);
    for (const r of rows) versionGenFallback.set(r.version_id, Number(r.media_count));
  }

  // Preserve curated order; drop any model that failed the NSFW/published re-check.
  // A model whose curated image failed the SFW re-check still renders — just without a thumbnail.
  return config.featuredModels
    .map((fm): EcosystemSeoFeaturedModel | null => {
      const model = byId.get(fm.modelId);
      if (!model) return null;
      // Checkpoints outside EcosystemCheckpoints are only generatable when they hold an auction
      // slot, so the card drops its Generate CTA rather than the whole entry — a canonical
      // release (e.g. Illustrious XL 1.0) still belongs in the curated list.
      const generatable = model.type !== 'Checkpoint' || availableVersionIds.has(fm.versionId);
      const metric = metricByModel.get(fm.modelId);
      return {
        modelId: fm.modelId,
        versionId: fm.versionId,
        name: fm.displayName ?? model.name,
        type: model.type as string,
        note: fm.note,
        imageUrl: imagesById.get(fm.imageId)?.url,
        downloadCount: Number(metric?.downloadCount ?? 0),
        generationCount:
          Number(metric?.generationCount ?? 0) || (versionGenFallback.get(fm.versionId) ?? 0),
        generatable,
      };
    })
    .filter((x): x is EcosystemSeoFeaturedModel => x !== null);
}

async function resolveFeaturedExamples(config: EcosystemSeoConfig): Promise<EcosystemSeoExample[]> {
  const ids = config.featuredExamples.map((e) => e.imageId);
  if (ids.length === 0) return [];
  // Example media MUST be remixable — the "Remix" button feeds it into the generator. That
  // needs generation metadata present and not creator-hidden (`hideMeta`); otherwise the
  // button opens an empty panel. Plus the SFW gate. Media type isn't filtered here so a
  // dual-modality page can mix images and clips — each example is re-checked against its own
  // expected type below (`fe.type ?? config.modality`).
  const images = await dbRead.image.findMany({
    where: {
      id: { in: ids },
      nsfwLevel: { lte: SFW_MAX_NSFW_LEVEL, gt: 0 },
      needsReview: null,
      hideMeta: false,
      meta: { not: Prisma.DbNull },
    },
    select: { id: true, url: true, width: true, height: true, type: true },
  });
  const byId = new Map(images.map((i) => [i.id, i]));
  return config.featuredExamples
    .map((fe): EcosystemSeoExample | null => {
      const image = byId.get(fe.imageId);
      const expectedType = fe.type ?? config.modality;
      if (!image || image.type !== expectedType) return null;
      return {
        imageId: fe.imageId,
        url: image.url,
        width: image.width,
        height: image.height,
        prompt: fe.prompt,
        settings: fe.settings,
        type: expectedType,
      };
    })
    .filter((x): x is EcosystemSeoExample => x !== null);
}

/**
 * Generic (queried) data for an ecosystem SEO page — stats, top LoRAs, and the
 * NSFW-re-validated featured models/images. Cached 24h in Redis; fail-open to a
 * direct DB read on cache miss or outage. Returns null for a key with no config
 * (the allow-list lives in ECOSYSTEM_SEO).
 *
 * `refresh` skips the cache read and recomputes + overwrites the entry — the
 * page only sets it for moderators (via `?refresh=true`) so it can't be used as
 * an anonymous cache-stampede vector.
 */
export async function getEcosystemSeoData(
  key: string,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<EcosystemSeoData | null> {
  const config = getEcosystemSeoConfig(key);
  if (!config) return null;

  const cacheKey = `${REDIS_KEYS.CACHES.ECOSYSTEM_SEO}:${CACHE_VERSION}:${key}` as const;
  if (!refresh) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as EcosystemSeoData;
        } catch {
          // stale/incompatible shape — fall through to recompute
        }
      }
    } catch {
      // redis down — fall through to DB; don't fail closed on a cache outage
    }
  }

  const data = await computeEcosystemSeoData(config);
  try {
    await redis.set(cacheKey, JSON.stringify(data), { EX: TTL });
  } catch {
    // fail open — next request recomputes
  }
  return data;
}
