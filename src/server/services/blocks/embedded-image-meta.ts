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
 * Budgets checked by a header walk BEFORE the parser runs. The parser is synchronous over the
 * whole buffer, so these — not a timer — are what bound its work: a file with a million text
 * chunks or a 40 MB graph is refused before it is parsed.
 */
export const EMBEDDED_META_BUDGET = {
  /** PNG text/EXIF chunks, JPEG APPn/COM segments, WebP EXIF/XMP chunks. */
  maxMetadataBlocks: 64,
  /** Total payload bytes across those blocks. */
  maxMetadataBytes: 2 * 1024 * 1024,
  /** Every chunk/segment walked, metadata or not. */
  maxStructuralBlocks: 20_000,
} as const;

/**
 * Generation parameters embedded in an uploaded image's bytes, validated the way the on-site
 * upload validates the meta it parses in the browser, or `undefined`.
 *
 * Never throws: malformed, over-budget, oversize or prompt-audit-blocked metadata all yield
 * `undefined`, so the upload proceeds as if the file carried none — the same outcome as a user
 * uploading a copy with its metadata stripped.
 */
export async function readEmbeddedImageMeta(
  bytes: Uint8Array
): Promise<ImageMetaProps | undefined> {
  try {
    const region = metadataRegion(bytes);
    if (!region) return undefined;

    const parsed = await getMetadata(region);
    if (!parsed || Object.keys(parsed).length === 0) return undefined;
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

/**
 * Walks the container's chunk/segment headers (no payload is decoded) and returns the prefix of
 * `bytes` that was walked — through PNG `IEND`, up to JPEG start-of-scan, or the WebP chunk list
 * — when its metadata fits {@link EMBEDDED_META_BUDGET}, else `null`. Only that prefix is parsed:
 * the parser keeps reading past `IEND`, so bytes the walk did not count must never reach it.
 * Only PNG, JPEG and WebP — the formats the parser reads — can pass.
 */
export function metadataRegion(bytes: Uint8Array): Uint8Array | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const counter = new BudgetCounter();
  let end: number | null = null;
  if (
    view.length >= 8 &&
    view.readUInt32BE(0) === 0x89504e47 &&
    view.readUInt32BE(4) === 0x0d0a1a0a
  )
    end = walkPng(view, counter);
  else if (view.length >= 2 && view[0] === 0xff && view[1] === 0xd8) end = walkJpeg(view, counter);
  else if (
    view.length >= 12 &&
    view.toString('latin1', 0, 4) === 'RIFF' &&
    view.toString('latin1', 8, 12) === 'WEBP'
  )
    end = walkWebp(view, counter);
  return end === null ? null : bytes.subarray(0, end);
}

class BudgetCounter {
  private blocks = 0;
  private metadataBlocks = 0;
  private metadataBytes = 0;

  /** Returns false once any budget is exceeded. */
  add(isMetadata: boolean, payloadBytes: number): boolean {
    this.blocks += 1;
    if (isMetadata) {
      this.metadataBlocks += 1;
      this.metadataBytes += payloadBytes;
    }
    return (
      this.blocks <= EMBEDDED_META_BUDGET.maxStructuralBlocks &&
      this.metadataBlocks <= EMBEDDED_META_BUDGET.maxMetadataBlocks &&
      this.metadataBytes <= EMBEDDED_META_BUDGET.maxMetadataBytes
    );
  }
}

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

/** End offset of the `IEND` chunk, or null. */
function walkPng(view: Buffer, counter: BudgetCounter): number | null {
  let offset = 8;
  while (offset + 8 <= view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString('latin1', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (next > view.length) return null;
    if (!counter.add(PNG_METADATA_CHUNKS.has(type), length)) return null;
    if (type === 'IEND') return next;
    offset = next;
  }
  return null;
}

/** Offset of the start-of-scan (or end-of-image) marker, or null. */
function walkJpeg(view: Buffer, counter: BudgetCounter): number | null {
  let offset = 2;
  while (offset + 4 <= view.length) {
    if (view[offset] !== 0xff) return null;
    const marker = view[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return offset;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (!counter.add(false, 0)) return null;
      offset += 2;
      continue;
    }
    const length = view.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > view.length) return null;
    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!counter.add(isMetadata, length - 2)) return null;
    offset += 2 + length;
  }
  return null;
}

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);

/** End offset of the last whole chunk, or null. */
function walkWebp(view: Buffer, counter: BudgetCounter): number | null {
  let offset = 12;
  while (offset + 8 <= view.length) {
    const type = view.toString('latin1', offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    if (offset + 8 + size > view.length) return null;
    if (!counter.add(WEBP_METADATA_CHUNKS.has(type), size)) return null;
    offset = Math.min(view.length, offset + 8 + size + (size % 2));
  }
  return offset;
}
