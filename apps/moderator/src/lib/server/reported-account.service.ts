import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';

export type ReportedAccountModel = {
  id: number;
  name: string;
  type: string;
  status: string;
  mode: string | null;
  nsfw: boolean;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  tosViolation: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  coverUrl: string | null;
  coverType: string | null;
};

const MODELS = 60;

/**
 * A reported account's models, newest first, deleted and unpublished included — a report about an
 * account is often about a model it already pulled, and the public profile hides exactly those.
 *
 * The cover is the site's: the owner's first image on the first version's first post. Picked per row
 * in a scalar subquery rather than joined, so a model with no images still lists, and the walk stops
 * at the first hit instead of reading every image of a 400-image model.
 */
export async function getReportedAccountModels(
  userId: number
): Promise<{ items: ReportedAccountModel[]; truncated: boolean }> {
  const cover = (column: 'url' | 'type') =>
    sql<string | null>`(
      select i.${sql.ref(column)}::text
      from "ModelVersion" mv
      join "Post" p on p."modelVersionId" = mv.id and p."userId" = "Model"."userId"
      join "Image" i on i."postId" = p.id
      where mv."modelId" = "Model".id
      order by mv.index nulls last, p.id, i.index nulls last
      limit 1
    )`;

  const rows = await dbRead
    .selectFrom('Model')
    .select([
      'id',
      'name',
      sql<string>`type::text`.as('type'),
      sql<string>`status::text`.as('status'),
      sql<string | null>`mode::text`.as('mode'),
      'nsfw',
      'nsfwLevel',
      'poi',
      'minor',
      'tosViolation',
      'deletedAt',
      'createdAt',
    ])
    .select(cover('url').as('coverUrl'))
    .select(cover('type').as('coverType'))
    .where('userId', '=', userId)
    .orderBy('id', 'desc')
    .limit(MODELS + 1)
    .execute();

  return { items: rows.slice(0, MODELS) as ReportedAccountModel[], truncated: rows.length > MODELS };
}
