import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import type { SearchUploadFaceScan } from '~/server/services/search-upload-gate';
import {
  SEARCH_UPLOAD_APP_ID_META_KEY,
  SEARCH_UPLOAD_FACE_SCAN_META_KEY,
} from '~/shared/utils/block-provenance-metadata';

/** Which consumer blob a search upload was copied from, as `upload:<blobId>`. Read only with the provenance key and the owner. */
export const SEARCH_UPLOAD_REF_META_KEY = 'searchUploadRef';

export function isSearchUploadRow(metadata: unknown): boolean {
  return !!metadata && typeof metadata === 'object' && SEARCH_UPLOAD_APP_ID_META_KEY in metadata;
}

export async function writeSearchUploadFaceScan(imageId: number, faceScan: SearchUploadFaceScan) {
  // Built from scalars in SQL, so the write can only ever add this one server-owned key.
  const ran = faceScan.ran ? 1 : 0;
  const scores = faceScan.faces.map((face) => face.animeProbability);
  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      ${SEARCH_UPLOAD_FACE_SCAN_META_KEY}::text,
      jsonb_build_object(
        'ran', ${ran}::int = 1,
        'faces', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('animeProbability', s.p) ORDER BY s.i), '[]'::jsonb)
          FROM unnest(${scores}::float8[]) WITH ORDINALITY AS s(p, i)
        )
      )
    )
    WHERE id = ${imageId}
  `;
}

export type SearchUploadRecord = {
  id: number;
  url: string;
  nsfwLevel: number;
  createdAt: Date;
  ingestion: string;
  tosViolation: boolean;
  blockedFor: string | null;
  needsReview: string | null;
  minor: boolean;
  poi: boolean;
  metadata: Record<string, unknown> | null;
};

const isSearchUploadSql = Prisma.sql`i."postId" IS NULL AND COALESCE(i.metadata, '{}'::jsonb) ? ${SEARCH_UPLOAD_APP_ID_META_KEY}`;

/** The viewer's own search upload, or null. `dbWrite`: polled seconds after the row is written. */
export async function findOwnedSearchUpload(userId: number, uploadId: number) {
  const [row] = await dbWrite.$queryRaw<SearchUploadRecord[]>`
    SELECT i.id, i.url, i."nsfwLevel", i."createdAt", i.ingestion::text AS ingestion, i."tosViolation",
      i."blockedFor", i."needsReview", i.minor, i.poi, i.metadata
    FROM "Image" i
    WHERE i.id = ${uploadId} AND i."userId" = ${userId} AND ${isSearchUploadSql}
  `;
  return row ?? null;
}

/** The viewer's upload of the same blob made after `since`, so a repeat costs no second scan. */
export async function findSearchUploadByRef(userId: number, ref: string, since: Date) {
  const [row] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i
    WHERE i."userId" = ${userId} AND ${isSearchUploadSql}
      AND i.metadata->>${SEARCH_UPLOAD_REF_META_KEY}::text = ${ref}
      AND i."createdAt" > ${since}
    ORDER BY i.id DESC
    LIMIT 1
  `;
  return row?.id ?? null;
}

/** Whether the viewer has an upload still waiting for its scan, written after `since`. */
export async function hasUnscannedSearchUpload(userId: number, since: Date) {
  const [row] = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT i.id FROM "Image" i
    WHERE i."userId" = ${userId} AND ${isSearchUploadSql}
      AND i.ingestion IN ('Pending', 'Rescan')
      AND i."createdAt" > ${since}
    LIMIT 1
  `;
  return !!row;
}
