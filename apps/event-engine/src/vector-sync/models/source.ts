import type { Pool } from 'pg';
import { modelDocument, nsfwLevels, normalizeTitle, type ModelSource } from './document';

/**
 * Which models get a vector: the demo's export rule (civitai/model-search-demo export.py), which
 * is the site's search-index rule (published, not Unsearchable) plus deleted, ToS and minor
 * exclusions. A model also needs a published, searchable version, checked in `getModelDocs`.
 * Private is excluded at both levels so the payload never holds a private name or description.
 */
export const MODEL_ELIGIBLE_SQL = `m.status = 'Published' AND m."deletedAt" IS NULL
  AND NOT m."tosViolation" AND NOT m.minor AND m.availability NOT IN ('Unsearchable', 'Private')
  AND m."publishedAt" IS NOT NULL`;

const VERSION_ELIGIBLE_SQL = `mv.status = 'Published' AND mv.availability NOT IN ('Unsearchable', 'Private')`;
/** Versions read per model; the document folds in the first three descriptions. */
const MAX_VERSIONS = 8;

export type ModelPayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  name: string;
  type: string;
  checkpointType: string | null;
  baseModels: string[];
  /** Tag names and published versions' trigger words, for the search service's dictionaries. */
  tags: string[];
  triggerWords: string[];
  /**
   * The versions this document was built from. A version delete event carries only the version's
   * id, so the live sync finds the model by this field.
   */
  versionIds: number[];
  /** The set bits of Model.nsfwLevel; empty while unrated. */
  nsfwLevel: number[];
  publishedAt: string;
  userId: number;
  username: string | null;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = ModelSource & {
  checkpointType: string | null;
  nsfwLevel: number;
  publishedAt: Date;
  userId: number;
};

/** The payloads of the eligible models among `ids`; an id missing from the map gets no point. */
export async function getModelDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, ModelPayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT m.id, m.name, m.type, m."checkpointType", m."nsfwLevel", m."publishedAt", m."userId",
       u.username, left(m.description, 16000) AS description,
       COALESCE((SELECT array_agg(t.name::text ORDER BY t.name) FROM "TagsOnModels" tm
         JOIN "Tag" t ON t.id = tm."tagId" WHERE tm."modelId" = m.id), '{}') AS tags,
       COALESCE((SELECT json_agg(v) FROM (
         SELECT mv.id, mv.name, left(mv.description, 2500) AS description, mv."baseModel",
           mv."trainedWords"
         FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND ${VERSION_ELIGIBLE_SQL}
         ORDER BY mv.index ASC NULLS LAST, mv.id DESC LIMIT ${MAX_VERSIONS}) v), '[]') AS versions
     FROM "Model" m JOIN "User" u ON u.id = m."userId"
     WHERE m.id = ANY($1::int[]) AND ${MODEL_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, ModelPayload>();
  for (const row of rows) {
    if (!row.versions.length) continue;
    const { text, baseModels, tags, triggerWords, docHash } = modelDocument(row);
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.name),
      search_text: text,
      name: row.name,
      type: row.type,
      checkpointType: row.checkpointType,
      baseModels,
      tags,
      triggerWords,
      versionIds: row.versions.map((v) => v.id),
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      publishedAt: new Date(row.publishedAt).toISOString(),
      userId: row.userId,
      username: row.username,
      docHash,
    });
  }
  return docs;
}
