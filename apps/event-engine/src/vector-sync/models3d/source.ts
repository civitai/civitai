import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { heldImageSql, heldUserSql } from '../held';
import { model3dDocument } from './document';

/** NsfwLevel.Blocked: a level that blocks on its own, whatever the ingestion state says. */
const BLOCKED = 32;

/**
 * Which 3D models get a point: the site's `model3dSemanticEligibleText` as SQL, held to it by the
 * site's model3d-eligibility parity test. A model that stops matching loses its point at its next
 * sync.
 */
export const MODEL3D_ELIGIBLE_SQL = `(m.status = 'Published' AND m."deletedAt" IS NULL
  AND m."nsfwLevel" NOT IN (0, ${BLOCKED}) AND NOT m."tosViolation" AND NOT m.unlisted AND NOT m.minor AND NOT m.poi
  AND m.availability = 'Public' AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
  AND NOT ${heldUserSql('m."userId"')}
  AND EXISTS (SELECT 1 FROM "Image" ti WHERE ti.id = m."thumbnailImageId"
    AND ti.ingestion = 'Scanned' AND ti."needsReview" IS NULL AND NOT ti."tosViolation"
    AND ti."blockedFor" IS NULL AND ti."nsfwLevel" NOT IN (0, ${BLOCKED})
    AND ti."userId" = m."userId" AND NOT ti.minor AND NOT ti.poi
    AND NOT ${heldImageSql('ti')}))`;

/** The thumbnail `ti`'s level, the site's `model3dThumbnailLevelText`, pinned by the parity test. */
export const MODEL3D_THUMBNAIL_LEVEL_SQL = 'ti."nsfwLevel"';

export type Model3DPayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The document text, for phrase filters; the vector is the thumbnail. */
  search_text: string;
  name: string;
  /** Tag names, for the search service's dictionaries; tagIds is the filter. */
  tags: string[];
  tagIds: number[];
  /** The set bits of Model3D.nsfwLevel (never 0 here: unrated models are not indexed). */
  nsfwLevel: number[];
  /**
   * The set bits of the thumbnail's own level; the models3d gate requires it because the vector is
   * the thumbnail, rated apart from the model.
   */
  thumbnailNsfwLevel: number[];
  /** generationParams.enableAnimation, the feed's "animated" filter. */
  animated: boolean;
  /** Model3DLicense.name. */
  license: string;
  publishedAt: string | null;
  userId: number;
  username: string | null;
  thumbnailImageId: number;
  /** The thumbnail's stored key, which the vector is embedded from. */
  thumbnailUrl: string;
  /** sha256 of the thumbnail and search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  name: string;
  description: string | null;
  nsfwLevel: number;
  animated: boolean;
  license: string;
  publishedAt: Date | null;
  userId: number;
  username: string | null;
  thumbnailImageId: number;
  thumbnailUrl: string;
  thumbnailNsfwLevel: number;
  tags: { id: number; name: string }[];
};

/** The payloads of the eligible 3D models among `ids`; an id missing from the map gets no point. */
export async function getModel3DDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, Model3DPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT m.id, m.name, left(m.description, 20000) AS description, m."nsfwLevel",
       COALESCE(m."generationParams"->>'enableAnimation' = 'true', false) AS animated,
       l.name AS license, m."publishedAt", m."userId", u.username,
       m."thumbnailImageId", ti.url AS "thumbnailUrl",
       ${MODEL3D_THUMBNAIL_LEVEL_SQL} AS "thumbnailNsfwLevel",
       COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
         FROM "TagsOnModel3D" tm JOIN "Tag" t ON t.id = tm."tagId"
         WHERE tm."model3dId" = m.id), '[]') AS tags
     FROM "Model3D" m
     JOIN "User" u ON u.id = m."userId"
     JOIN "Model3DLicense" l ON l.id = m."licenseId"
     JOIN "Image" ti ON ti.id = m."thumbnailImageId"
     WHERE m.id = ANY($1::int[]) AND ${MODEL3D_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, Model3DPayload>();
  for (const row of rows) {
    const { text, tags, docHash } = model3dDocument({
      name: row.name,
      username: row.username,
      tags: row.tags.map((t) => t.name),
      description: row.description,
      thumbnailImageId: row.thumbnailImageId,
      thumbnailUrl: row.thumbnailUrl,
    });
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      tags,
      tagIds: row.tags.map((t) => t.id),
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      thumbnailNsfwLevel: nsfwLevels(row.thumbnailNsfwLevel),
      animated: row.animated,
      license: row.license,
      publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
      userId: row.userId,
      username: row.username,
      thumbnailImageId: row.thumbnailImageId,
      thumbnailUrl: row.thumbnailUrl,
      docHash,
    });
  }
  return docs;
}
