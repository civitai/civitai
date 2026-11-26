import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { withheldRows } from './retracted-media';

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
  coverId: number | null;
  coverUrl: string | null;
  coverType: string | null;
  /** The cover is withheld from this moderator: no key and no type. */
  coverRestricted: boolean;
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
  userId: number,
  viewer: App.Locals['user'] | undefined
): Promise<{ items: ReportedAccountModel[]; truncated: boolean }> {
  const cover = (column: 'id' | 'url' | 'type') =>
    sql<string | null>`(
      select i.${sql.ref(column)}::text
      from "ModelVersion" mv
      join "Post" p on p."modelVersionId" = mv.id and p."userId" = "Model"."userId"
      join "Image" i on i."postId" = p.id
      where mv."modelId" = "Model".id
      -- i.id last: each column is its own subquery, so a tie must break the same way in all three.
      order by mv.index nulls last, p.id, i.index nulls last, i.id
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
    .select(sql<number | null>`(${cover('id')})::int`.as('coverId'))
    .select(cover('url').as('coverUrl'))
    .select(cover('type').as('coverType'))
    .where('userId', '=', userId)
    .orderBy('id', 'desc')
    .limit(MODELS + 1)
    .execute();

  const items = await withheldRows(
    (rows.slice(0, MODELS) as Omit<ReportedAccountModel, 'coverRestricted'>[]).map((m) => ({
      ...m,
      coverRestricted: false,
    })),
    viewer,
    'reported-account-models',
    (m) => m.coverId,
    (m) => ({ ...m, coverUrl: null, coverType: null, coverRestricted: true })
  );
  return { items, truncated: rows.length > MODELS };
}
