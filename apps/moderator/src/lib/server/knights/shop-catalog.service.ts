import type { Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { isSellable, stockFor, type ShopItem } from '@civitai/shared/knights-shop';
import { getPaginatedCosmetics } from '../cosmetics.service';
import { withModerators } from '../mod-activity';
import { dbWrite } from '../db';
import {
  diffFields,
  type EditShopItem,
  type FieldChange,
  type NewShopItem,
} from './shop-catalog.schema';

export type Outcome<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const EDITABLE = ['name', 'description', 'price', 'minRank', 'rotating', 'sortOrder'] as const;
type Action = 'create' | 'update' | 'retire' | 'restore';

/** Catalog edits read and write the primary: an operator who just saved must see it, and the edit is diffed against the row it locks. */
const db = () => dbWrite;

export async function listShopItems() {
  return db()
    .selectFrom('KnightsShopItem as i')
    .leftJoin('Cosmetic as c', 'c.id', 'i.cosmeticId')
    .select([
      'i.id',
      'i.kind',
      'i.name',
      'i.description',
      'i.price',
      'i.buzz',
      'i.cosmeticId',
      'i.tier',
      'i.months',
      'i.minRank',
      'i.active',
      'i.rotating',
      'i.sortOrder',
      'c.name as cosmeticName',
      'c.type as cosmeticType',
      'c.data as cosmeticData',
    ])
    .orderBy('i.active', 'desc')
    .orderBy('i.sortOrder')
    .orderBy('i.id')
    .execute();
}
export type ShopItemRow = Awaited<ReturnType<typeof listShopItems>>[number];

/** The id scheme the dev seed uses, so a re-seed never duplicates an item added here. */
export function shopItemId(item: NewShopItem): string {
  if (item.kind === 'buzz_pack') return `buzz-${item.buzz}`;
  if (item.kind === 'cosmetic') return `cosmetic-${item.cosmeticId}`;
  return `membership-${item.tier}-${item.months}m`;
}

async function record(
  trx: Transaction<DB>,
  itemId: string,
  userId: number,
  action: Action,
  changes: Record<string, FieldChange>
) {
  await trx
    .insertInto('KnightsShopItemChange')
    .values({ itemId, userId, action, changes: JSON.stringify(changes) as never })
    .execute();
}

export async function createShopItem(
  input: NewShopItem,
  userId: number
): Promise<Outcome<{ id: string }>> {
  const id = shopItemId(input);
  const row = {
    id,
    kind: input.kind,
    name: input.name,
    description: input.description,
    price: input.price,
    buzz: input.kind === 'buzz_pack' ? input.buzz : null,
    cosmeticId: input.kind === 'cosmetic' ? input.cosmeticId : null,
    tier: input.kind === 'membership' ? input.tier : null,
    months: input.kind === 'membership' ? input.months : null,
    minRank: input.minRank,
    active: true,
    rotating: input.rotating,
    sortOrder: input.sortOrder,
  };
  return db()
    .transaction()
    .execute(async (trx): Promise<Outcome<{ id: string }>> => {
      if (row.cosmeticId !== null) {
        const cosmetic = await trx
          .selectFrom('Cosmetic')
          .select('id')
          .where('id', '=', row.cosmeticId)
          .executeTakeFirst();
        if (!cosmetic) return { ok: false, error: 'That cosmetic does not exist.' };
      }
      const inserted = await trx
        .insertInto('KnightsShopItem')
        .values(row)
        .onConflict((oc) => oc.column('id').doNothing())
        .executeTakeFirst();
      if (!inserted.numInsertedOrUpdatedRows) {
        return {
          ok: false,
          error: `An item with the id ${id} already exists. Edit or restore it instead.`,
        };
      }
      await record(trx, id, userId, 'create', diffFields({}, row, Object.keys(row)));
      return { ok: true, id };
    });
}

async function lockItem(trx: Transaction<DB>, id: string) {
  return trx
    .selectFrom('KnightsShopItem')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

const NOT_FOUND = { ok: false, error: 'That item no longer exists.' } as const;

/** Edits the settings of an item. A save that changes nothing writes nothing. */
export async function updateShopItem(
  input: EditShopItem,
  userId: number
): Promise<Outcome<{ changed: boolean }>> {
  return db()
    .transaction()
    .execute(async (trx): Promise<Outcome<{ changed: boolean }>> => {
      const before = await lockItem(trx, input.id);
      if (!before) return NOT_FOUND;
      const changes = diffFields(before, input, EDITABLE);
      if (Object.keys(changes).length === 0) return { ok: true, changed: false };
      await trx
        .updateTable('KnightsShopItem')
        .set({
          name: input.name,
          description: input.description,
          price: input.price,
          minRank: input.minRank,
          rotating: input.rotating,
          sortOrder: input.sortOrder,
        })
        .where('id', '=', input.id)
        .execute();
      await record(trx, input.id, userId, 'update', changes);
      return { ok: true, changed: true };
    });
}

/** Retiring hides an item from the shop; purchases keep pointing at it, so it is never deleted. */
export async function setShopItemActive(
  id: string,
  active: boolean,
  userId: number
): Promise<Outcome<{ changed: boolean }>> {
  return db()
    .transaction()
    .execute(async (trx): Promise<Outcome<{ changed: boolean }>> => {
      const before = await lockItem(trx, id);
      if (!before) return NOT_FOUND;
      if (before.active === active) return { ok: true, changed: false };
      await trx.updateTable('KnightsShopItem').set({ active }).where('id', '=', id).execute();
      await record(trx, id, userId, active ? 'restore' : 'retire', {
        active: { from: before.active, to: active },
      });
      return { ok: true, changed: true };
    });
}

/** What the shop would show on `day`: the rows it reads (active, then sellable) through the same `stockFor`. */
export async function previewShop(day: string) {
  const rows: ShopItem[] = await db()
    .selectFrom('KnightsShopItem')
    .selectAll()
    .where('active', '=', true)
    .execute();
  const sellable = rows.filter(isSellable);
  return {
    day,
    ...stockFor(sellable, day),
    excluded: rows.filter((item) => !isSellable(item)),
  };
}

export async function listShopChanges({
  itemId,
  limit = 100,
}: {
  itemId?: string;
  limit?: number;
}) {
  let query = db()
    .selectFrom('KnightsShopItemChange as ch')
    .innerJoin('KnightsShopItem as i', 'i.id', 'ch.itemId')
    .select([
      'ch.id',
      'ch.itemId',
      'i.name as itemName',
      'ch.userId',
      'ch.action',
      'ch.changes',
      'ch.createdAt',
    ]);
  if (itemId) query = query.where('ch.itemId', '=', itemId);
  const rows = await query
    .orderBy('ch.createdAt', 'desc')
    .orderBy('ch.id', 'desc')
    .limit(limit)
    .execute();
  return (await withModerators(rows)).map((row) => ({
    ...row,
    changes: row.changes as Record<string, FieldChange>,
  }));
}

export async function searchCosmetics(query: string) {
  const { items } = await getPaginatedCosmetics({ name: query, limit: 10 });
  return items.map(({ id, name, type, data }) => ({ id, name, type, data }));
}
