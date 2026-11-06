import type { Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { isSellable, stockFor } from '@civitai/shared/knights-shop';
import { withModerators } from '../mod-activity';
import { dbWrite } from '../db';
import type { Outcome } from './coreset.service';
import {
  diffFields,
  type EditShopItem,
  type FieldChange,
  type NewShopItem,
} from './shop-catalog.schema';

const EDITABLE = ['name', 'description', 'price', 'minRank', 'rotating', 'sortOrder'] as const;
type Action = 'create' | 'update' | 'retire' | 'restore';

/** The primary, not the replica: an edit locks and diffs the row, and the operator who just saved must see it. */
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

async function record(
  trx: Transaction<DB>,
  itemId: number,
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
): Promise<Outcome<{ id: number }>> {
  const row = {
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
    .execute(async (trx): Promise<Outcome<{ id: number }>> => {
      if (row.cosmeticId !== null) {
        const cosmetic = await trx
          .selectFrom('Cosmetic')
          .select('id')
          .where('id', '=', row.cosmeticId)
          .executeTakeFirst();
        if (!cosmetic) return { ok: false, error: 'That cosmetic does not exist.' };
      }
      const { id } = await trx
        .insertInto('KnightsShopItem')
        .values(row)
        .returning('id')
        .executeTakeFirstOrThrow();
      await record(trx, id, userId, 'create', diffFields({}, row, Object.keys(row)));
      return { ok: true, id };
    });
}

async function lockItem(trx: Transaction<DB>, id: number) {
  return trx
    .selectFrom('KnightsShopItem')
    .selectAll()
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

const NOT_FOUND = { ok: false, error: 'That item no longer exists.' } as const;

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

/** Retire, never delete: purchases and audit rows keep pointing at the item. */
export async function setShopItemActive(
  id: number,
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

/**
 * What a day's shop holds, drawn from rows already read. Mirrors what apps/knights/src/lib/server/shop/catalog.ts
 * reads (active, sellable, same stockFor); change them together or the preview lies.
 */
export function stockView(rows: ShopItemRow[], day: string) {
  const live = rows.filter((row) => row.active);
  const { stock } = stockFor(live.filter(isSellable), day);
  const byId = new Map(live.map((row) => [row.id, row]));
  return {
    day,
    stock: stock.flatMap(({ item, price, deal }) => {
      const row = byId.get(item.id);
      if (!row) return [];
      const hidden =
        row.kind === 'cosmetic' && row.cosmeticType === null ? ('cosmetic missing' as const) : null;
      return [{ item: row, price, deal, hidden }];
    }),
    excluded: live.filter((row) => !isSellable(row)),
  };
}

export async function listShopChanges({
  itemId,
  before,
  limit = 100,
}: {
  itemId?: number;
  before?: number;
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
  if (before) query = query.where('ch.id', '<', before);
  const rows = await query
    .orderBy('ch.id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const changes = (await withModerators(page)).map((row) => ({
    ...row,
    changes: row.changes as Record<string, FieldChange>,
  }));
  return { changes, nextBefore: rows.length > limit ? page[page.length - 1].id : null };
}
export type ShopChangeRow = Awaited<ReturnType<typeof listShopChanges>>['changes'][number];
