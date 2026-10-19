import { sql } from '@civitai/db/kysely';
import { CosmeticType } from '@civitai/db-schema/enums';
import { cosmeticTeamOf } from '@civitai/shared/mystery-box';
import { designName, type CatalogDesign, type FlowReward } from '$lib/box-design';
import { ITEM_DEFINITION_STATUS, ITEM_TYPE, type RewardInfo } from '$lib/mystery-box';
import { escapeLike } from './like';
import { dbRead, dbWrite } from './db';
import type { Trx } from './mystery-box-builder.service';

export type CosmeticSelector = { event: string } | { cosmeticIds: number[] };

const selectCosmetics = (selector: CosmeticSelector) => {
  const query = dbRead.selectFrom('Cosmetic as c');
  return 'event' in selector
    ? query.where(sql<boolean>`c.data->>'event' = ${selector.event}`)
    : query.where('c.id', 'in', selector.cosmeticIds.length ? selector.cosmeticIds : [0]);
};

export async function previewCosmeticDefinitions(selector: CosmeticSelector) {
  const rows = await selectCosmetics(selector)
    .leftJoin('ItemDefinition as d', 'd.cosmeticId', 'c.id')
    .select(['c.id', 'd.id as definitionId'])
    .execute();
  const found = new Set(rows.map((row) => row.id));
  return {
    cosmetics: rows.length,
    alreadyDefined: rows.filter((row) => row.definitionId !== null).length,
    missingIds:
      'cosmeticIds' in selector ? selector.cosmeticIds.filter((id) => !found.has(id)) : [],
  };
}

/** Idempotent: the unique index on `cosmeticId` turns a repeat into a skip. */
export async function createCosmeticDefinitions({
  selector,
  userId,
}: {
  selector: CosmeticSelector;
  userId: number;
}) {
  const cosmetics = await selectCosmetics(selector).select(['c.id', 'c.name']).execute();
  if (!cosmetics.length) return { created: 0, alreadyDefined: 0 };
  const created = await dbWrite
    .insertInto('ItemDefinition')
    .values(
      cosmetics.map((cosmetic) => ({
        type: ITEM_TYPE.cosmetic,
        name: cosmetic.name,
        cosmeticId: cosmetic.id,
        status: ITEM_DEFINITION_STATUS.published,
        createdById: userId,
        updatedById: userId,
      }))
    )
    .onConflict((oc) => oc.column('cosmeticId').doNothing())
    .returning('id')
    .execute();
  return { created: created.length, alreadyDefined: cosmetics.length - created.length };
}

function rewardInfo(row: {
  id: number;
  type: string;
  name: string;
  cosmeticId: number | null;
  data: unknown;
}): RewardInfo {
  const url = (row.data as { url?: unknown } | null)?.url;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    cosmeticId: row.cosmeticId,
    team: cosmeticTeamOf(row.data) ?? null,
    imageUrl: typeof url === 'string' ? url : null,
  };
}

export async function readRewards(client: Trx | typeof dbRead, ids: number[]) {
  if (!ids.length) return new Map<number, RewardInfo>();
  const rows = await client
    .selectFrom('ItemDefinition as d')
    .leftJoin('Cosmetic as c', 'c.id', 'd.cosmeticId')
    .where('d.id', 'in', ids)
    .select(['d.id', 'd.type', 'd.name', 'd.cosmeticId', 'c.data'])
    .execute();
  return new Map(rows.map((row) => [row.id, rewardInfo(row)]));
}

export async function findCosmeticRewards(selector: CosmeticSelector) {
  const rows = await selectCosmetics(selector)
    .leftJoin('ItemDefinition as d', 'd.cosmeticId', 'c.id')
    .select(['d.id', 'd.type', 'd.name', 'd.cosmeticId', 'c.data'])
    .orderBy('c.id')
    .execute();
  const rewards = rows.flatMap((row) =>
    row.id === null || row.type === null || row.name === null
      ? []
      : [rewardInfo({ ...row, id: row.id, type: row.type, name: row.name })]
  );
  return { rewards, undefinedCosmetics: rows.length - rewards.length };
}

/**
 * Teams as an event's cosmetics name them, not as the main app's event config does, so an event
 * whose team hats aren't loaded yet shows fewer teams.
 */
export async function readEventTeams(client: Trx | typeof dbRead, event: string | null) {
  if (!event) return [];
  const rows = await client
    .selectFrom('Cosmetic')
    .select(sql<string>`data->>'team'`.as('team'))
    .distinct()
    .where(sql<boolean>`data->>'event' = ${event} AND data->>'team' IS NOT NULL`)
    .execute();
  return rows.map((row) => row.team).sort();
}

export async function readCosmeticEvents() {
  const rows = await dbRead
    .selectFrom('Cosmetic')
    .select([
      sql<string>`data->>'event'`.as('event'),
      sql<(string | null)[]>`array_agg(DISTINCT data->>'team')`.as('teams'),
    ])
    .where(sql<boolean>`data->>'event' IS NOT NULL`)
    .groupBy(sql`data->>'event'`)
    .execute();
  return rows
    .map((row) => ({
      event: row.event,
      teams: row.teams.filter((team): team is string => team !== null).sort(),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

const PAGE_SIZE = 100;

export async function listCosmeticDefinitions({ event, page }: { event: string; page: number }) {
  let query = dbRead
    .selectFrom('ItemDefinition as d')
    .innerJoin('Cosmetic as c', 'c.id', 'd.cosmeticId')
    .where('d.type', '=', ITEM_TYPE.cosmetic);
  if (event) query = query.where(sql<boolean>`c.data->>'event' = ${event}`);
  const rows = await query
    .select([
      'd.id',
      'd.name',
      'd.status',
      'd.cosmeticId',
      'c.type as cosmeticType',
      sql<string | null>`c.data->>'team'`.as('team'),
      sql<string | null>`c.data->>'event'`.as('event'),
      sql<string | null>`c.data->>'url'`.as('url'),
    ])
    .orderBy('d.id', 'desc')
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
    .execute();
  return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE };
}

/** A reward with the shelf price the cosmetic is sold at, which steers tier placement in the builder. */
export async function withShelfPrices(rewards: RewardInfo[]): Promise<FlowReward[]> {
  const cosmeticIds = rewards.flatMap((reward) => (reward.cosmeticId === null ? [] : [reward.cosmeticId]));
  const prices = new Map<number, number>();
  if (cosmeticIds.length)
    for (const row of await dbRead
      .selectFrom('CosmeticShopItem')
      .select(['cosmeticId', (eb) => eb.fn.min('unitAmount').as('shelf')])
      .where('cosmeticId', 'in', cosmeticIds)
      .where('status', '=', 'Published')
      .where('archivedAt', 'is', null)
      .groupBy('cosmeticId')
      .execute())
      if (row.cosmeticId !== null && row.shelf !== null) prices.set(row.cosmeticId, row.shelf);
  return rewards.map((reward) => ({
    ...reward,
    shelf: reward.cosmeticId === null ? null : (prices.get(reward.cosmeticId) ?? null),
    design: designName(reward.name, reward.team),
  }));
}

export type CatalogQuery = {
  q: string;
  /** An event's name; '' leaves the event unfiltered. */
  event: string;
  noEvent: boolean;
  types: string[];
  /** Designs with a variant for this team, or for no team. */
  team: string;
  minShelf: number | null;
  maxShelf: number | null;
  noShelf: boolean;
  needsDefinition: boolean;
  limit: number;
};

export const COSMETIC_TYPES: readonly string[] = Object.values(CosmeticType);
export const CATALOG_MAX = 480;

type CatalogRow = {
  event: string | null;
  type: string;
  design: string;
  shelf: number | null;
  variants: CatalogDesign['variants'];
  total: string;
};

/**
 * `designName` in SQL: the cosmetic's name without its " - <team>" suffix. Kept beside the query and
 * pinned to the TypeScript rule by a test.
 */
const designSql = sql`CASE WHEN team IS NOT NULL AND length(name) > length(team) + 3
  AND right(name, length(team) + 3) = ' - ' || team THEN left(name, length(name) - length(team) - 3) ELSE name END`;

/**
 * Every cosmetic, grouped into designs (a team-variant set is one design), with its item definition
 * and its shelf price. Filters on the cosmetic (name, event, type) narrow before grouping; filters on
 * the design (team, price, needs a definition) after. One pass over `Cosmetic`, and `limit` bounds the
 * answer, so a page of results costs the same however many thousand cosmetics exist.
 */
export async function searchCosmeticCatalog(query: CatalogQuery) {
  const where = [sql`true`];
  if (query.q) where.push(sql`c.name ILIKE ${`%${escapeLike(query.q)}%`}`);
  if (query.noEvent) where.push(sql`c.data->>'event' IS NULL`);
  else if (query.event) where.push(sql`c.data->>'event' = ${query.event}`);
  if (query.types.length) where.push(sql`c.type::text = ANY(${query.types}::text[])`);

  const designWhere = [sql`true`];
  if (query.team) designWhere.push(sql`for_team`);
  if (query.noShelf) designWhere.push(sql`shelf IS NULL`);
  else {
    if (query.minShelf !== null) designWhere.push(sql`shelf >= ${query.minShelf}`);
    if (query.maxShelf !== null) designWhere.push(sql`shelf <= ${query.maxShelf}`);
  }
  if (query.needsDefinition) designWhere.push(sql`NOT defined`);

  const result = await sql<CatalogRow>`
    WITH shelf AS (
      SELECT "cosmeticId", min("unitAmount") AS price FROM "CosmeticShopItem"
      WHERE "cosmeticId" IS NOT NULL AND status = 'Published' AND "archivedAt" IS NULL
      GROUP BY "cosmeticId"
    ), cosmetics AS (
      SELECT c.id, c.name, c.type::text AS type, c.data->>'event' AS event,
        CASE WHEN jsonb_typeof(c.data->'team') = 'string' THEN c.data->>'team' END AS team,
        c.data->>'url' AS url, d.id AS definition_id, s.price AS shelf
      FROM "Cosmetic" c
      LEFT JOIN "ItemDefinition" d ON d."cosmeticId" = c.id
      LEFT JOIN shelf s ON s."cosmeticId" = c.id
      WHERE ${sql.join(where, sql` AND `)}
    ), designs AS (
      SELECT event, type, ${designSql} AS design, min(shelf) AS shelf,
        json_agg(json_build_object('cosmeticId', id, 'definitionId', definition_id, 'name', name,
          'team', team, 'url', url) ORDER BY team NULLS FIRST, id) AS variants,
        bool_or(team IS NULL OR team = ${query.team}) AS for_team,
        bool_and(definition_id IS NOT NULL) AS defined
      FROM cosmetics
      GROUP BY event, type, ${designSql}
    )
    SELECT event, type, design, shelf, variants, count(*) OVER() AS total
    FROM designs
    WHERE ${sql.join(designWhere, sql` AND `)}
    ORDER BY design, event NULLS FIRST, type
    LIMIT ${Math.min(query.limit, CATALOG_MAX)}
  `.execute(dbRead);

  return {
    designs: result.rows.map(
      (row): CatalogDesign => ({
        key: `${row.event ?? ''}|${row.type}|${row.design}`,
        name: row.design,
        type: row.type,
        event: row.event,
        shelf: row.shelf,
        variants: row.variants,
      })
    ),
    total: Number(result.rows[0]?.total ?? 0),
  };
}
