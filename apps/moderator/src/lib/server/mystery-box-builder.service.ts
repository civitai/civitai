import { sql } from '@civitai/db/kysely';
import type { Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  boxOddsSnapshotSchema,
  snapshotOfLiveBox,
  snapshotsMatch,
  type BoxOddsSnapshotData,
} from '@civitai/shared/box-odds-snapshot';
import {
  boxChecklist,
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
  type BoxArt,
  type BoxDraft,
} from '$lib/mystery-box';
import { openingStats } from '$lib/mystery-box-openings';
import { dbRead, dbWrite } from './db';
import { readEventTeams, readRewards } from './item-definitions.service';

/** A refusal the moderator can act on. Thrown before anything commits; the action answers 409. */
export class BoxRefusal extends Error {}

export type Trx = Transaction<DB>;

type BoxParams = Record<string, unknown> & { event?: unknown; emptyRule?: unknown; art?: unknown };

export async function listBoxes() {
  return dbRead
    .selectFrom('ItemDefinition as d')
    .where('d.type', '=', ITEM_TYPE.box)
    .select((eb) => [
      'd.id',
      'd.name',
      'd.status',
      'd.version',
      'd.params',
      'd.updatedAt',
      eb
        .selectFrom('CosmeticShopItem as s')
        .whereRef('s.itemDefinitionId', '=', 'd.id')
        .select((e) => e.fn.countAll<number>().as('n'))
        .as('listings'),
      eb
        .selectFrom('Item as i')
        .whereRef('i.itemDefinitionId', '=', 'd.id')
        .select((e) => e.fn.countAll<number>().as('n'))
        .as('held'),
      eb
        .selectFrom('BoxOpening as o')
        .whereRef('o.boxDefinitionId', '=', 'd.id')
        .select((e) => e.fn.countAll<number>().as('n'))
        .as('opened'),
    ])
    .orderBy('d.id', 'desc')
    .execute();
}

export async function createBox({ name, userId }: { name: string; userId: number }) {
  const row = await dbWrite
    .insertInto('ItemDefinition')
    .values({
      type: ITEM_TYPE.box,
      name,
      status: ITEM_DEFINITION_STATUS.draft,
      params: sql`${JSON.stringify({ emptyRule: 'keep' })}::jsonb`,
      createdById: userId,
      updatedById: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Reads the primary: a lagging replica would hand the editor rows without the ids the last save gave
 * them, and the next save would insert them again.
 */
export async function readBoxForEditor(boxId: number) {
  const box = await dbWrite
    .selectFrom('ItemDefinition')
    .selectAll()
    .where('id', '=', boxId)
    .where('type', '=', ITEM_TYPE.box)
    .executeTakeFirst();
  if (!box) return null;
  const [tiers, contents, listings, snapshots] = await Promise.all([
    dbWrite
      .selectFrom('BoxTier')
      .select(['id', 'key', 'name', 'weight', 'color', 'sortOrder'])
      .where('boxDefinitionId', '=', boxId)
      .orderBy('sortOrder')
      .orderBy('id')
      .execute(),
    dbWrite
      .selectFrom('BoxContent')
      .select(['id', 'tierId', 'rewardDefinitionId', 'enabled'])
      .where('boxDefinitionId', '=', boxId)
      .orderBy('id')
      .execute(),
    dbWrite
      .selectFrom('CosmeticShopItem')
      .select([
        'id',
        'title',
        'description',
        'unitAmount',
        'availableFrom',
        'availableTo',
        'availableQuantity',
        'status',
        'listed',
      ])
      .where('itemDefinitionId', '=', boxId)
      .orderBy('id')
      .execute(),
    dbWrite
      .selectFrom('BoxOddsSnapshot')
      .select(['version', 'createdAt', 'createdById'])
      .where('boxDefinitionId', '=', boxId)
      .orderBy('version', 'desc')
      .execute(),
  ]);
  const params = (box.params ?? {}) as BoxParams;
  const keyOf = new Map(tiers.map((tier) => [tier.id, tier.key]));
  const draft: BoxDraft = {
    name: box.name,
    description: box.description ?? '',
    imageUrl: box.imageUrl ?? '',
    event: typeof params.event === 'string' ? params.event : '',
    emptyRule: 'keep',
    art: (params.art && typeof params.art === 'object' ? params.art : {}) as BoxArt,
    tiers: tiers.map(({ id, key, name, weight, color }) => ({ id, key, name, weight, color })),
    contents: contents.map((content) => ({
      id: content.id,
      rewardDefinitionId: content.rewardDefinitionId,
      tierKey: keyOf.get(content.tierId) ?? '',
      enabled: content.enabled,
    })),
  };
  const rewards = await readRewards(
    dbWrite,
    contents.map((content) => content.rewardDefinitionId)
  );
  return {
    box: {
      id: box.id,
      status: box.status,
      version: box.version,
      updatedAt: box.updatedAt.toISOString(),
    },
    draft,
    rewards: [...rewards.values()],
    listings,
    snapshots,
  };
}

async function liveSnapshot(trx: Trx, boxId: number): Promise<BoxOddsSnapshotData> {
  const [tiers, contents] = await Promise.all([
    trx
      .selectFrom('BoxTier')
      .select(['id', 'key', 'name', 'weight', 'sortOrder'])
      .where('boxDefinitionId', '=', boxId)
      .execute(),
    // Must match what the draw reads: enabled cosmetic contents.
    trx
      .selectFrom('BoxContent as bc')
      .innerJoin('ItemDefinition as d', 'd.id', 'bc.rewardDefinitionId')
      .select(['bc.tierId', 'd.cosmeticId'])
      .where('bc.boxDefinitionId', '=', boxId)
      .where('bc.enabled', '=', true)
      .where('d.type', '=', ITEM_TYPE.cosmetic)
      .where('d.cosmeticId', 'is not', null)
      .execute(),
  ]);
  return snapshotOfLiveBox(
    tiers,
    contents.map((content) => ({ tierId: content.tierId, cosmeticId: content.cosmeticId! }))
  );
}

/**
 * FOR NO KEY UPDATE waits for every open in flight (each reads this row FOR SHARE), so no open draws
 * across this save's version change. Never take the item-holder lock inside: opens take it before
 * this row, so the reverse order deadlocks.
 */
async function lockBox(trx: Trx, boxId: number) {
  const box = await trx
    .selectFrom('ItemDefinition')
    .select(['id', 'type', 'status', 'version', 'params', 'updatedAt'])
    .where('id', '=', boxId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!box || box.type !== ITEM_TYPE.box) throw new BoxRefusal('No such box.');
  return box;
}

/**
 * Runs on the caller's transaction so the bump commits with the change it versions: the display cache
 * keys contents by (box, version), and a bump committed first could cache the old contents under the
 * new version.
 */
async function bumpVersion(
  trx: Trx,
  boxId: number,
  { status, userId }: { status: string; userId: number }
) {
  const { version } = await trx
    .updateTable('ItemDefinition')
    .set({ version: sql`version + 1`, status, updatedById: userId, updatedAt: new Date() })
    .where('id', '=', boxId)
    .returning('version')
    .executeTakeFirstOrThrow();
  if (status !== ITEM_DEFINITION_STATUS.draft)
    await trx
      .insertInto('BoxOddsSnapshot')
      .values({
        boxDefinitionId: boxId,
        version,
        snapshot: sql`${JSON.stringify(await liveSnapshot(trx, boxId))}::jsonb`,
        createdById: userId,
      })
      .execute();
  return version;
}

export type SaveBoxInput = {
  boxId: number;
  expectedVersion: number;
  /** Every save stamps it, and a detail-only save leaves the version alone. */
  expectedUpdatedAt: string;
  draft: BoxDraft;
  publish: boolean;
  userId: number;
};

/** One transaction: any refusal rolls the whole save back. */
export async function saveBox({
  boxId,
  expectedVersion,
  expectedUpdatedAt,
  draft,
  publish,
  userId,
}: SaveBoxInput) {
  return dbWrite.transaction().execute(async (trx) => {
    const box = await lockBox(trx, boxId);
    if (
      box.version !== expectedVersion ||
      new Date(box.updatedAt).getTime() !== new Date(expectedUpdatedAt).getTime()
    )
      throw new BoxRefusal(
        'Someone changed this box since you opened it. Reload to see their changes.'
      );
    if (publish && box.status !== ITEM_DEFINITION_STATUS.draft)
      throw new BoxRefusal('This box is already published.');
    const status = publish ? ITEM_DEFINITION_STATUS.published : box.status;
    const before = await liveSnapshot(trx, boxId);
    const params = (box.params ?? {}) as BoxParams;
    const eventBefore = typeof params.event === 'string' ? params.event : null;
    const event = draft.event.trim() || null;

    const { event: _event, ...rest } = params;
    await trx
      .updateTable('ItemDefinition')
      .set({
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        imageUrl: draft.imageUrl.trim() || null,
        params: sql`${JSON.stringify({
          ...rest,
          ...(event ? { event } : {}),
          emptyRule: draft.emptyRule,
          art: draft.art,
        })}::jsonb`,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where('id', '=', boxId)
      .execute();

    await writeTiersAndContents(trx, boxId, draft);

    // The checklist reads the rows this transaction wrote, not the request.
    if (status !== ITEM_DEFINITION_STATUS.draft) {
      const [tierRows, contentRows] = await Promise.all([
        trx
          .selectFrom('BoxTier')
          .select(['id', 'key', 'name', 'weight', 'color'])
          .where('boxDefinitionId', '=', boxId)
          .orderBy('sortOrder')
          .orderBy('id')
          .execute(),
        trx
          .selectFrom('BoxContent as bc')
          .innerJoin('BoxTier as t', 't.id', 'bc.tierId')
          .select(['bc.id', 'bc.rewardDefinitionId', 'bc.enabled', 't.key as tierKey'])
          .where('bc.boxDefinitionId', '=', boxId)
          .execute(),
      ]);
      const rewards = await readRewards(
        trx,
        contentRows.map((row) => row.rewardDefinitionId)
      );
      const teams = await readEventTeams(trx, event);
      const problems = boxChecklist(
        { name: draft.name, tiers: tierRows, contents: contentRows },
        rewards,
        teams
      );
      if (problems.length) throw new BoxRefusal(problems.join(' '));
    }

    const after = await liveSnapshot(trx, boxId);
    const oddsChanged = !snapshotsMatch(before, after) || event !== eventBefore;
    const version =
      oddsChanged || publish ? await bumpVersion(trx, boxId, { status, userId }) : box.version;
    return { version, status, bumped: version !== box.version };
  });
}

async function writeTiersAndContents(trx: Trx, boxId: number, draft: BoxDraft) {
  const [tiers, contents] = await Promise.all([
    trx.selectFrom('BoxTier').select(['id', 'key']).where('boxDefinitionId', '=', boxId).execute(),
    trx
      .selectFrom('BoxContent')
      .select(['id', 'rewardDefinitionId'])
      .where('boxDefinitionId', '=', boxId)
      .execute(),
  ]);
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const contentById = new Map(contents.map((content) => [content.id, content]));

  const keys = new Set<string>();
  for (const tier of draft.tiers) {
    if (keys.has(tier.key)) throw new BoxRefusal(`Two tiers share the key "${tier.key}".`);
    keys.add(tier.key);
    if (tier.id === null) {
      if (tiers.some((existing) => existing.key === tier.key))
        throw new BoxRefusal(`The key "${tier.key}" is already used by a tier of this box.`);
      continue;
    }
    const existing = tierById.get(tier.id);
    if (!existing) throw new BoxRefusal(`Tier #${tier.id} isn't in this box.`);
    if (existing.key !== tier.key)
      throw new BoxRefusal(`Tier "${existing.key}" can't change its key once saved.`);
  }
  for (const content of draft.contents)
    if (content.id !== null && !contentById.has(content.id))
      throw new BoxRefusal(`Content #${content.id} isn't in this box.`);

  // Contents first: removed contents free the (box, reward) slot a re-added reward needs, and let a
  // removed tier go (BoxContent.tierId is RESTRICT).
  const keptContentIds = draft.contents.flatMap((content) => (content.id ? [content.id] : []));
  await trx
    .deleteFrom('BoxContent')
    .where('boxDefinitionId', '=', boxId)
    .$if(keptContentIds.length > 0, (qb) => qb.where('id', 'not in', keptContentIds))
    .execute();

  const tierIdByKey = new Map<string, number>();
  for (const [sortOrder, tier] of draft.tiers.entries()) {
    const values = { name: tier.name.trim(), weight: tier.weight, color: tier.color, sortOrder };
    if (tier.id === null) {
      const row = await trx
        .insertInto('BoxTier')
        .values({ boxDefinitionId: boxId, key: tier.key, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      tierIdByKey.set(tier.key, row.id);
    } else {
      await trx
        .updateTable('BoxTier')
        .set(values)
        .where('id', '=', tier.id)
        .where('boxDefinitionId', '=', boxId)
        .execute();
      tierIdByKey.set(tier.key, tier.id);
    }
  }

  for (const content of draft.contents) {
    const tierId = tierIdByKey.get(content.tierKey);
    if (tierId === undefined)
      throw new BoxRefusal(
        `Reward #${content.rewardDefinitionId} is in a tier the box doesn't have.`
      );
    if (content.id === null)
      await trx
        .insertInto('BoxContent')
        .values({
          boxDefinitionId: boxId,
          tierId,
          rewardDefinitionId: content.rewardDefinitionId,
          enabled: content.enabled,
        })
        .execute();
    else
      await trx
        .updateTable('BoxContent')
        .set({ tierId, enabled: content.enabled })
        .where('id', '=', content.id)
        .where('boxDefinitionId', '=', boxId)
        .execute();
  }

  const keptTierIds = [...tierIdByKey.values()];
  await trx
    .deleteFrom('BoxTier')
    .where('boxDefinitionId', '=', boxId)
    .where('id', 'not in', keptTierIds.length ? keptTierIds : [0])
    .execute();
}

/**
 * A new version with no change to the box's rows, for a change made outside the builder that alters
 * what a team draws: a content cosmetic's `data.team`. Its snapshot repeats the last one's odds.
 */
export async function recordOutsideChange({
  boxId,
  expectedVersion,
  userId,
}: {
  boxId: number;
  expectedVersion: number;
  userId: number;
}) {
  return dbWrite.transaction().execute(async (trx) => {
    const box = await lockBox(trx, boxId);
    if (box.version !== expectedVersion)
      throw new BoxRefusal(
        'Someone changed this box since you opened it. Reload to see their changes.'
      );
    if (box.status === ITEM_DEFINITION_STATUS.draft)
      throw new BoxRefusal('A draft is shown nowhere, so it has nothing to record.');
    return bumpVersion(trx, boxId, { status: box.status, userId });
  });
}

/** Archiving doesn't touch opens: `openMysteryBox` checks only the type, so an archived box still opens. */
export async function archiveBox({ boxId, userId }: { boxId: number; userId: number }) {
  const result = await dbWrite
    .updateTable('ItemDefinition')
    .set({ status: ITEM_DEFINITION_STATUS.archived, updatedById: userId, updatedAt: new Date() })
    .where('id', '=', boxId)
    .where('type', '=', ITEM_TYPE.box)
    .where('status', '=', ITEM_DEFINITION_STATUS.published)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new BoxRefusal('Only a published box can be archived.');
}

export type BoxListingInput = {
  title: string;
  description: string | null;
  unitAmount: number;
  availableFrom: Date | null;
  availableTo: Date | null;
  availableQuantity: number | null;
  status: 'Draft' | 'Published' | 'Archived';
};

/**
 * Always unlisted: with no `cosmeticId` the storefront would read this as a pack and show it without
 * the box's flag, region and event checks. `listed` defaults to true and a CHECK refuses that for a
 * box listing, so the insert names it.
 */
export async function createBoxListing({
  boxId,
  listing,
  userId,
}: {
  boxId: number;
  listing: BoxListingInput;
  userId: number;
}) {
  const box = await dbWrite
    .selectFrom('ItemDefinition')
    .select('id')
    .where('id', '=', boxId)
    .where('type', '=', ITEM_TYPE.box)
    .executeTakeFirst();
  if (!box) throw new BoxRefusal('No such box.');
  const row = await dbWrite
    .insertInto('CosmeticShopItem')
    .values({
      ...listing,
      cosmeticId: null,
      itemDefinitionId: boxId,
      listed: false,
      addedById: userId,
      meta: sql`'{}'::jsonb`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Never writes `listed` (see `createBoxListing`) or `itemDefinitionId`, and the WHERE holds the box: a
 * refund finds a purchase through the listing's current `itemDefinitionId`.
 */
export async function updateBoxListing({
  boxId,
  listingId,
  listing,
}: {
  boxId: number;
  listingId: number;
  listing: BoxListingInput;
}) {
  const result = await dbWrite
    .updateTable('CosmeticShopItem')
    .set(listing)
    .where('id', '=', listingId)
    .where('itemDefinitionId', '=', boxId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw new BoxRefusal('No such listing for this box.');
}

const RECENT_OPENINGS = 100;

export async function readBoxOpenings(boxId: number) {
  const box = await dbRead
    .selectFrom('ItemDefinition')
    .select(['id', 'name', 'version', 'status'])
    .where('id', '=', boxId)
    .where('type', '=', ITEM_TYPE.box)
    .executeTakeFirst();
  if (!box) return null;
  const [recent, groups, tiers, snapshots] = await Promise.all([
    dbRead
      .selectFrom('BoxOpening as o')
      .leftJoin('ItemDefinition as d', 'd.id', 'o.rewardDefinitionId')
      .leftJoin('BoxTier as t', 't.id', 'o.tierId')
      .select([
        'o.boxItemId',
        'o.createdAt',
        'o.userId',
        'o.boxVersion',
        'o.tierId',
        't.name as tierName',
        'd.name as rewardName',
        'o.tierWeight',
        'o.eligibleWeight',
        'o.tierPoolSize',
        'o.rewardStatus',
      ])
      .where('o.boxDefinitionId', '=', boxId)
      .orderBy('o.createdAt', 'desc')
      .limit(RECENT_OPENINGS)
      .execute(),
    dbRead
      .selectFrom('BoxOpening')
      .select([
        'boxVersion',
        'tierId',
        'eligibleWeight',
        (eb) => eb.fn.countAll<string>().as('count'),
      ])
      .where('boxDefinitionId', '=', boxId)
      .groupBy(['boxVersion', 'tierId', 'eligibleWeight'])
      .execute(),
    dbRead
      .selectFrom('BoxTier')
      .select(['id', 'key', 'name'])
      .where('boxDefinitionId', '=', boxId)
      .orderBy('sortOrder')
      .orderBy('id')
      .execute(),
    dbRead
      .selectFrom('BoxOddsSnapshot')
      .select(['version', 'snapshot'])
      .where('boxDefinitionId', '=', boxId)
      .execute(),
  ]);
  const parsed = new Map<number, BoxOddsSnapshotData>();
  for (const row of snapshots) {
    const result = boxOddsSnapshotSchema.safeParse(row.snapshot);
    if (result.success) parsed.set(row.version, result.data);
  }
  return {
    box,
    recent: recent.map((row) => ({ ...row, boxItemId: String(row.boxItemId) })),
    stats: openingStats(
      groups.map((g) => ({ ...g, count: Number(g.count) })),
      parsed,
      tiers
    ),
  };
}
