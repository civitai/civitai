import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { eligibleSql, IMAGE_ROW_COLUMNS, type ImageRow } from '../eligibility';
import { videoLimitSkip } from '../embedder';
import { heldImageSql } from '../held';
import { vectorSyncMetrics } from '../metrics';
import { getPayloads, type ImagePayload } from '../source';

/** The videos of "Image", unaliased for the walks. */
export const VIDEO_WHERE = `type = 'video'`;

/** The image payload, so the search service filters videos exactly as it filters images. */
export type VideoPayload = ImagePayload & {
  /** Always empty: the vector is the clip. */
  search_text: string;
  /** sha256 of the stored key: a replaced file is re-embedded. */
  docHash: string;
  url: string;
  payloadHash?: string;
};

/**
 * The image rules (eligibility.ts) plus the held-media rule the other content indexes apply. Clips
 * past the worker's limits get no document, so they are never sent and never retried.
 */
export async function getVideoDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, VideoPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<ImageRow>(
    `SELECT ${IMAGE_ROW_COLUMNS} FROM "Image" i
     WHERE i.id = ANY($1::int[]) AND i.type = 'video' AND ${eligibleSql('i')}
       AND NOT ${heldImageSql('i')}`,
    [ids]
  );
  const supported = rows.filter((row) => {
    const skip = /^[a-z]+:/i.test(row.url) ? 'external-url' : videoLimitSkip(row);
    if (skip) vectorSyncMetrics.skipped.inc({ domain: 'video', reason: skip });
    return !skip;
  });
  const payloads = await getPayloads(pg as Pool, supported);
  return new Map(
    supported.map((row) => [
      row.id,
      {
        ...payloads.get(row.id)!,
        search_text: '',
        docHash: createHash('sha256').update(row.url).digest('hex'),
        url: row.url,
      },
    ])
  );
}
