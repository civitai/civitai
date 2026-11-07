import { isCivitaiSiteUrl, parseCivitaiUrlSafe } from '~/utils/civitai-url';

export type CivitaiEmbedType = 'model' | 'image';
export type CivitaiEmbedItem = { type: CivitaiEmbedType; id: number; versionId?: number };

/** model.getAll caps `limit` at 100 (image.getInfinite at 200); one cap keeps every id in one request. */
export const CIVITAI_EMBED_MAX_PER_TYPE = 100;

const isEmbedType = (value: unknown): value is CivitaiEmbedType =>
  value === 'model' || value === 'image';

function toId(value: unknown) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Drops anything that is not a known type with positive integer ids. */
export function toCivitaiEmbedItem(raw: unknown): CivitaiEmbedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, id, versionId } = raw as Record<string, unknown>;
  const safeId = toId(id);
  if (!isEmbedType(type) || !safeId) return null;
  const safeVersionId = type === 'model' ? toId(versionId) : undefined;
  return safeVersionId ? { type, id: safeId, versionId: safeVersionId } : { type, id: safeId };
}

/** Accepts only absolute civitai site links to a model (optionally a version) or an image. */
export function parseCivitaiEmbedUrl(input: string): CivitaiEmbedItem | null {
  const trimmed = input?.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed) || !isCivitaiSiteUrl(trimmed)) return null;

  const ref = parseCivitaiUrlSafe(trimmed);
  if (ref?.type === 'model')
    return ref.modelVersionId
      ? { type: 'model', id: ref.modelId, versionId: ref.modelVersionId }
      : { type: 'model', id: ref.modelId };

  const match = /^\/images\/(\d+)\/?$/.exec(new URL(trimmed).pathname);
  const imageId = toId(match?.[1]);
  return imageId ? { type: 'image', id: imageId } : null;
}

/** Host-relative, so the stored link follows the reader onto whichever site they are on. */
export function getCivitaiEmbedHref(item: CivitaiEmbedItem) {
  if (item.type === 'image') return `/images/${item.id}`;
  return item.versionId
    ? `/models/${item.id}?modelVersionId=${item.versionId}`
    : `/models/${item.id}`;
}

type JsonNode = { type?: string; attrs?: Record<string, unknown>; content?: JsonNode[] };

/** Every embedded id in a document, by type, deduped and capped per type. */
export function collectCivitaiEmbedIds(doc: JsonNode | null | undefined) {
  const ids: Record<CivitaiEmbedType, Set<number>> = { model: new Set(), image: new Set() };
  const walk = (node: JsonNode | undefined) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'civitaiEmbed' && Array.isArray(node.attrs?.items))
      for (const raw of node.attrs.items) {
        const item = toCivitaiEmbedItem(raw);
        if (item && ids[item.type].size < CIVITAI_EMBED_MAX_PER_TYPE) ids[item.type].add(item.id);
      }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc ?? undefined);
  return { modelIds: [...ids.model], imageIds: [...ids.image] };
}
