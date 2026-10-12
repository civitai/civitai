import type { ImageMetaProps } from '~/server/schema/image.schema';
import { stripBlockProvenanceMetadata } from '~/shared/utils/block-provenance-metadata';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { getMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

/**
 * Whole-meta ceiling. The on-site upload refuses an image whose `comfy` graph is over 1 MB; this
 * applies the same figure to the whole bag, so an oversize graph or prompt yields no meta here.
 */
export const MAX_EMBEDDED_META_MB = 1;

/**
 * The parser awaits between reads, so a deadline bounds the async part of a slow parse. It
 * cannot pre-empt synchronous parsing; that is bounded by the caller's byte cap on the input.
 */
export const EMBEDDED_META_PARSE_DEADLINE_MS = 2_000;

/**
 * Generation parameters embedded in an uploaded image's bytes, validated the way the on-site
 * upload validates the meta it parses in the browser, or `undefined`.
 *
 * Never throws: malformed, oversize, slow or prompt-audit-blocked metadata all yield `undefined`,
 * so the upload proceeds as if the file carried none — the same outcome as a user uploading a
 * copy with its metadata stripped.
 */
export async function readEmbeddedImageMeta(
  bytes: Uint8Array,
  { deadlineMs = EMBEDDED_META_PARSE_DEADLINE_MS }: { deadlineMs?: number } = {}
): Promise<ImageMetaProps | undefined> {
  let parsed: ImageMetaProps;
  try {
    parsed = await withDeadline(getMetadata(bytes), deadlineMs);
  } catch {
    return undefined;
  }
  if (!parsed || Object.keys(parsed).length === 0) return undefined;

  try {
    if (calculateSizeInMegabytes(parsed) > MAX_EMBEDDED_META_MB) return undefined;

    // `imageMetaSchema` passes unknown keys through, and an A1111 `parameters` line becomes
    // top-level keys, so a file can spell a provenance key here.
    const meta = stripBlockProvenanceMetadata(parsed as Record<string, unknown>) as ImageMetaProps;

    // SFW list: rows from this path are SFW-only.
    if (!auditMetaData(meta, false).success) return undefined;

    return meta;
  } catch {
    return undefined;
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('embedded meta parse deadline')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
