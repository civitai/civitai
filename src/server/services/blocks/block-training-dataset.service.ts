import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbRead } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { classifyGatedImageForViewer } from '~/server/services/blocks/block-gated-images.logic';
import { imageUpload } from '~/server/services/orchestrator/imageUpload';
import {
  BLOCK_TRAINING_DATASET_ID_REGEX,
  BLOCK_TRAINING_DATASET_MAX_ITEMS,
} from '~/server/schema/blocks/workflow.schema';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks `kind:'training'` — the DATASET primitive.
//
// A block names images by id; the server decides which of them may be trained on,
// imports the admitted ones into orchestrator blobs under the VIEWER'S orchestrator
// token, and hands back an opaque handle. The training body names that handle and
// nothing else about the data, so the image set, the blob references and the image
// COUNT the run is priced on never come from the block.
//
// ADMISSION, per image (all must hold):
//   - the image is the VIEWER'S OWN (`Image.userId` = token subject). Images this
//     app published for the viewer are included by that rule; another user's image
//     is never admitted, whoever published it — v1 has no cross-user datasets;
//   - it is an image (`type = 'image'`), not a video or audio row;
//   - `classifyGatedImageForViewer` says `visible` under the token's maturity
//     ceiling — the one predicate the app's gated reads already use. That refuses a
//     row that is unscanned or still scanning, scan-blocked, flagged for review,
//     marked as a minor or as a real person, a ToS violation, hard-blocked, or
//     rated above the ceiling the token was minted with.
//
// A refused image is REPORTED, not thrown: the block gets the rest of its dataset
// and a per-image reason. The reasons are deliberately coarse — they say what the
// app can act on (pick another image, wait for a scan) and nothing finer.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a prepared dataset handle stays usable. */
export const BLOCK_TRAINING_DATASET_TTL_SECONDS = 24 * 60 * 60;
/** Concurrent orchestrator imports per request. */
export const BLOCK_TRAINING_IMPORT_CONCURRENCY = 4;
/** Width of the consent-dialog thumbnail stored per item. */
const THUMBNAIL_WIDTH = 450;

export type BlockTrainingRejectionReason =
  /** Not found, or not the viewer's own image. One reason for both, on purpose. */
  | 'unavailable'
  /** A video or audio row. */
  | 'unsupported-media'
  /** Refused by moderation state or the token's maturity ceiling. */
  | 'not-eligible'
  /** Not scanned yet — retry once the scan finishes. */
  | 'pending-scan'
  /** The orchestrator did not accept the image. */
  | 'import-failed';

export type BlockTrainingDatasetItem = {
  imageId: number;
  /** The orchestrator blob reference the training step names. */
  air: string;
  caption: string;
  /** A server-built edge url for the consent dialog. */
  thumbnailUrl: string;
};

export type BlockTrainingDataset = {
  v: 1;
  datasetId: string;
  userId: number;
  appBlockId: string;
  blockInstanceId: string;
  items: BlockTrainingDatasetItem[];
  /** Always `items.length`. Stored for the reader's convenience, never trusted alone. */
  count: number;
  createdAt: string;
};

/** Who a dataset is prepared for — every field from VERIFIED token claims. */
export type BlockTrainingActor = {
  userId: number;
  appBlockId: string;
  blockInstanceId: string;
  /** The token's resolved browsing-level ceiling (`resolveViewerBrowsingLevel`). */
  browsingLevel: number;
  /** `false` on a SFW-ceiling token — passed to the orchestrator import. */
  allowMatureContent: boolean | undefined;
};

type ImageRow = {
  id: number;
  url: string;
  type: string;
  nsfwLevel: number;
  ingestion: string;
  needsReview: string | null;
  poi: boolean | null;
  minor: boolean | null;
  tosViolation: boolean | null;
  acceptableMinor: boolean | null;
  blockedFor: string | null;
};

/**
 * The per-image admission decision. PURE — the whole rule set for one row, so it
 * can be tested row by row without a database. `null` means admitted.
 *
 * `row` is null when the id resolved to nothing the viewer owns (the query is
 * already scoped to the viewer), which is the same answer as "does not exist".
 */
export function admitTrainingImage(
  row: ImageRow | null,
  browsingLevel: number
): BlockTrainingRejectionReason | null {
  if (!row) return 'unavailable';
  if (row.type !== 'image') return 'unsupported-media';
  const verdict = classifyGatedImageForViewer(
    {
      ingestion: row.ingestion,
      nsfwLevel: row.nsfwLevel,
      needsReview: row.needsReview,
      poi: row.poi,
      minor: row.minor,
      tosViolation: row.tosViolation,
      acceptableMinor: row.acceptableMinor,
      blockedFor: row.blockedFor,
    },
    browsingLevel
  );
  // `!== 'visible'`, not `=== 'hidden'`: an unrecognised verdict refuses too.
  if (verdict.status === 'pending') return 'pending-scan';
  if (verdict.status !== 'visible') return 'not-eligible';
  return null;
}

/**
 * The blob reference a training step can name, from an orchestrator image import.
 *
 * The orchestrator's blob dataset accepts an AIR, a `/v2/consumer/blobs/{key}` url
 * or a bare blob key. The url form is the one the Training Studio already sends for
 * workflow-produced blobs, so that is the form used here; the presigned query is
 * dropped (the extension must survive, the signature is not needed server-side).
 * Anything else — an unavailable or blocked blob, or a url of another shape — is
 * `null`, i.e. the image is refused rather than sent in a form nothing has shown
 * the orchestrator accepts.
 */
export function trainingBlobAirFromImport(blob: {
  url?: string | null;
  available?: boolean;
  blockedReason?: string | null;
}): string | null {
  if (blob.available !== true || blob.blockedReason) return null;
  if (typeof blob.url !== 'string' || blob.url.length === 0) return null;
  const base = blob.url.split('?')[0];
  return base.includes('/v2/consumer/blobs/') ? base : null;
}

function datasetKey(
  datasetId: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.TRAINING_DATASET}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.TRAINING_DATASET}:${datasetId}`;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Prepare a training dataset from the viewer's own images.
 *
 * `auditCaptions` is the caller's prompt-moderation pass over the joined captions
 * (it throws on a refusal); it runs BEFORE any orchestrator import, so a refused
 * caption set costs no upload. It is injected because the moderation call needs
 * request context (the viewer's domain strictness and moderator flag) that only the
 * caller has.
 *
 * Throws BAD_REQUEST when nothing was admitted — a handle to an empty dataset would
 * only fail later, at a quote.
 */
export async function prepareBlockTrainingDataset(input: {
  actor: BlockTrainingActor;
  items: Array<{ imageId: number; caption: string }>;
  /** The viewer's orchestrator token. */
  token: string;
  auditCaptions: (text: string) => Promise<void>;
}): Promise<{
  datasetId: string;
  count: number;
  rejected: Array<{ imageId: number; reason: BlockTrainingRejectionReason }>;
}> {
  const { actor, token } = input;

  // Dedupe by image id, first caption wins — the orchestrator also refuses a
  // dataset naming one blob twice.
  const seen = new Set<number>();
  const requested = input.items.filter((item) => {
    if (seen.has(item.imageId)) return false;
    seen.add(item.imageId);
    return true;
  });
  if (requested.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'no images in the training dataset' });
  }
  if (requested.length > BLOCK_TRAINING_DATASET_MAX_ITEMS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `a training dataset holds at most ${BLOCK_TRAINING_DATASET_MAX_ITEMS} images`,
    });
  }

  const ids = requested.map((r) => r.imageId);
  const rows = await dbRead.$queryRaw<ImageRow[]>`
    SELECT
      i."id", i."url", i."type"::text AS "type", i."nsfwLevel", i."ingestion"::text AS "ingestion",
      i."needsReview", i."poi", i."minor", i."tosViolation", i."acceptableMinor", i."blockedFor"
    FROM "Image" i
    WHERE i."id" = ANY(${ids}::int[])
      AND i."userId" = ${actor.userId}
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const rejected: Array<{ imageId: number; reason: BlockTrainingRejectionReason }> = [];
  const admitted: Array<{ row: ImageRow; caption: string }> = [];
  for (const item of requested) {
    const row = byId.get(item.imageId) ?? null;
    const reason = admitTrainingImage(row, actor.browsingLevel);
    if (reason) rejected.push({ imageId: item.imageId, reason });
    else admitted.push({ row: row as ImageRow, caption: item.caption.trim() });
  }
  if (admitted.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'none of the requested images can be used for training',
    });
  }

  // Captions are app-supplied text that becomes training data — moderated like a
  // prompt, once over the whole set, before anything is uploaded.
  const captionText = admitted
    .map((a) => a.caption)
    .filter((c) => c.length > 0)
    .join('\n');
  if (captionText.length > 0) await input.auditCaptions(captionText);

  const imported = await mapBounded(admitted, BLOCK_TRAINING_IMPORT_CONCURRENCY, async (a) => {
    try {
      const data = await imageUpload({
        sourceImage: getEdgeUrl(a.row.url, { original: true }),
        token,
        allowMatureContent: actor.allowMatureContent,
      });
      return trainingBlobAirFromImport(data.blob);
    } catch {
      return null;
    }
  });

  const items: BlockTrainingDatasetItem[] = [];
  admitted.forEach((a, i) => {
    const air = imported[i];
    if (!air) {
      rejected.push({ imageId: a.row.id, reason: 'import-failed' });
      return;
    }
    items.push({
      imageId: a.row.id,
      air,
      caption: a.caption,
      thumbnailUrl: getEdgeUrl(a.row.url, { width: THUMBNAIL_WIDTH }),
    });
  });
  if (items.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'none of the requested images could be prepared for training',
    });
  }

  const datasetId = `tds_${randomBytes(16).toString('hex')}`;
  const record: BlockTrainingDataset = {
    v: 1,
    datasetId,
    userId: actor.userId,
    appBlockId: actor.appBlockId,
    blockInstanceId: actor.blockInstanceId,
    items,
    count: items.length,
    createdAt: new Date().toISOString(),
  };
  await sysRedis.set(datasetKey(datasetId), JSON.stringify(record), {
    EX: BLOCK_TRAINING_DATASET_TTL_SECONDS,
  });

  return { datasetId, count: items.length, rejected };
}

/**
 * Load a prepared dataset FOR THIS subject, app and install, or `null`.
 *
 * `null` covers expired, never-existed, malformed and bound-to-someone-else alike,
 * so a caller answers all four with one refusal and the handle cannot be used to
 * probe another viewer's datasets. The count returned is `items.length`, whatever
 * the stored `count` says.
 */
export async function loadBlockTrainingDataset(
  datasetId: string,
  binding: { userId: number; appBlockId: string; blockInstanceId: string }
): Promise<BlockTrainingDataset | null> {
  if (!BLOCK_TRAINING_DATASET_ID_REGEX.test(datasetId)) return null;
  const raw = await sysRedis.get(datasetKey(datasetId));
  if (typeof raw !== 'string') return null;
  let parsed: BlockTrainingDataset;
  try {
    parsed = JSON.parse(raw) as BlockTrainingDataset;
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.userId !== binding.userId ||
    parsed.appBlockId !== binding.appBlockId ||
    parsed.blockInstanceId !== binding.blockInstanceId ||
    !Array.isArray(parsed.items) ||
    parsed.items.length === 0
  ) {
    return null;
  }
  return { ...parsed, count: parsed.items.length };
}
