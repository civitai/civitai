import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Global rewards-bonus cap, mirroring MAX_GLOBAL_BONUS in the main app's buzz.service.
const MAX_GLOBAL_BONUS = 5;

// Active global rewards-bonus multiplier, mirroring getActiveRewardsBonusEvent + the /10 scaling in
// getMultipliersForUser. Picks the highest-multiplier currently-active enabled event; its stored value
// (multiplier * 10) is scaled back and clamped to [1, MAX_GLOBAL_BONUS].
export async function getGlobalRewardsBonus(db: Kysely<DB>): Promise<number> {
  const events = await db
    .selectFrom('RewardsBonusEvent')
    .select(['multiplier', 'startsAt', 'endsAt'])
    .where('enabled', '=', true)
    .execute();
  const now = new Date();
  const active = events.filter(
    (e) => (!e.startsAt || e.startsAt <= now) && (!e.endsAt || e.endsAt >= now)
  );
  if (!active.length) return 1;
  const raw = Math.max(...active.map((e) => e.multiplier)) / 10;
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_GLOBAL_BONUS) : 1;
}

// --- RewardsBonusEvent CRUD (moderator admin page; the in-process enabled-events cache is dropped) ---

export type ActiveRewardsBonusEvent = {
  id: number;
  name: string;
  description: string | null;
  multiplier: number;
  articleId: number | null;
  bannerLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

export type RewardsBonusEventRow = ActiveRewardsBonusEvent & {
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertRewardsBonusEventInput = {
  id?: number;
  name: string;
  description?: string | null;
  multiplier: number;
  articleId?: number | null;
  bannerLabel?: string | null;
  enabled: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  userId: number;
};

// The currently-active enabled event: read the enabled events (highest multiplier, then newest) and return
// the first whose start/end window contains `now`. The time filter is evaluated per call — not cached — so a
// scheduled start/end transition takes effect immediately.
export async function getActiveRewardsBonusEvent(
  db: Kysely<DB>
): Promise<ActiveRewardsBonusEvent | null> {
  const events = await db
    .selectFrom('RewardsBonusEvent')
    .select([
      'id',
      'name',
      'description',
      'multiplier',
      'articleId',
      'bannerLabel',
      'startsAt',
      'endsAt',
    ])
    .where('enabled', '=', true)
    .orderBy('multiplier', 'desc')
    .orderBy('createdAt', 'desc')
    .execute();

  const now = new Date();
  return (
    events.find(
      (event) =>
        (!event.startsAt || event.startsAt <= now) && (!event.endsAt || event.endsAt >= now)
    ) ?? null
  );
}

// Create (no id) or update (id) one event. `createdById` is stamped only on create. On update, `updatedAt` is
// auto-stamped by the @updatedAt plugin; on insert it's set explicitly (the plugin only rewrites UPDATEs).
export function upsertRewardsBonusEvent(db: Kysely<DB>, input: UpsertRewardsBonusEventInput) {
  const payload = {
    name: input.name,
    description: input.description ?? null,
    multiplier: input.multiplier,
    articleId: input.articleId ?? null,
    bannerLabel: input.bannerLabel ?? null,
    enabled: input.enabled,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
  };

  if (input.id != null) {
    return db
      .updateTable('RewardsBonusEvent')
      .set({ ...payload })
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  return db
    .insertInto('RewardsBonusEvent')
    .values({ ...payload, createdById: input.userId, updatedAt: new Date() })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export function deleteRewardsBonusEvent(db: Kysely<DB>, id: number) {
  return db.deleteFrom('RewardsBonusEvent').where('id', '=', id).execute();
}

export function getRewardsBonusEventById(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('RewardsBonusEvent')
    .select([
      'id',
      'name',
      'description',
      'multiplier',
      'articleId',
      'bannerLabel',
      'enabled',
      'startsAt',
      'endsAt',
      'createdAt',
      'updatedAt',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}

// A page of events (enabled first, then by start date desc with nulls last, then id desc), plus the total
// for pagination. Mirrors the getPagination/getPagingData helpers inline so the package needs no app import.
export async function getRewardsBonusEventsPaged(
  db: Kysely<DB>,
  { page, limit = 20 }: { page?: number; limit?: number }
): Promise<{
  items: RewardsBonusEventRow[];
  totalItems: number;
  currentPage: number;
  pageSize: number;
  totalPages: number;
}> {
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  let query = db
    .selectFrom('RewardsBonusEvent')
    .select([
      'id',
      'name',
      'description',
      'multiplier',
      'articleId',
      'bannerLabel',
      'enabled',
      'startsAt',
      'endsAt',
      'createdAt',
      'updatedAt',
    ])
    .orderBy('enabled', 'desc')
    .orderBy(sql`"startsAt" desc nulls last`)
    .orderBy('id', 'desc');

  if (take != null) query = query.limit(take);
  if (skip != null) query = query.offset(skip);

  const items = (await query.execute()) as RewardsBonusEventRow[];

  const totalItems = Number(
    (
      await db
        .selectFrom('RewardsBonusEvent')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirst()
    )?.count ?? 0
  );

  const currentPage = page ?? 1;
  const pageSize = limit ?? totalItems;
  const totalPages = pageSize && totalItems ? Math.ceil(totalItems / pageSize) : 1;

  return { items, totalItems, currentPage, pageSize, totalPages };
}
