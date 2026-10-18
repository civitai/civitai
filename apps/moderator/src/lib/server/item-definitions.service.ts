import { sql } from '@civitai/db/kysely';
import { cosmeticTeamOf } from '@civitai/shared/mystery-box';
import { ITEM_DEFINITION_STATUS, ITEM_TYPE, type RewardInfo } from '$lib/mystery-box';
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
