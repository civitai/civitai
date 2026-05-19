import { Prisma } from '@prisma/client';

// Shared on-site predicate. An image/video is considered "made on Civitai" when
// it has `civitaiResources` in its meta, no `Version` key, and either no `Model`
// key or a `Model` value that is a Civitai AIR URN (urn:air:...).
//
// `Version` and a non-AIR `Model` are markers left by external tooling
// (A1111, ComfyUI, etc.) — they override the civitaiResources signal because
// the metadata was post-processed off-site. An AIR-formatted `Model` is a
// Civitai-native identifier so it does NOT disqualify on-site.
//
// Video generations posted from the Queue/Feed carry `civitaiResources` too,
// so they're covered by the same predicate — no separate engine check needed.

export function isImageMetaOnSite(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;

  if (!('civitaiResources' in m)) return false;
  if ('Version' in m) return false;
  if ('Model' in m && !(typeof m.Model === 'string' && m.Model.startsWith('urn:air:'))) {
    return false;
  }
  return true;
}

// SQL fragment producing the same boolean. `metaColumn` is the qualified column
// reference (e.g. `i.meta`). Defaults to `i.meta` which matches the convention
// in every current callsite.
export function imageOnSiteSql(metaColumn = 'i.meta'): Prisma.Sql {
  const col = Prisma.raw(metaColumn);
  return Prisma.sql`(
    ${col}->>'civitaiResources' IS NOT NULL
    AND NOT (${col} ? 'Version')
    AND (NOT (${col} ? 'Model') OR (${col}->>'Model') LIKE 'urn:air:%')
  )`;
}
