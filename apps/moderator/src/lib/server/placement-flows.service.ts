import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { MAX_BUZZ_DAYS } from './buzz-flows.service';
import { isInt4Id, usersByIds } from './users.service';

// Paid placements (stickers, remixes, gallery promotions) between a set of accounts and anyone.
//
// Their Buzz never moves account to account: the placer pays into the escrow account (id 0) and
// settlement pays out of it, so buzz_flows, which lists flows between two real accounts, sees neither
// leg. The Placement row names both ends, and PlacementTransaction holds each leg that moved.
//
// The set is matched on placer and owner only. `sellerId` has no index, and a seller is reported on
// the rows found that way.

/** Where each leg kind's Buzz went, by the main app's `PlacementTransactionKind`. Every kind is
 *  listed: one left out reads as Buzz still sitting in escrow. */
const LEGS = {
  held: ['holdFee', 'holdPrincipal'],
  refunded: ['principalToPlacer', 'feeToPlacer'],
  toOwner: ['toOwner', 'feeToOwner'],
  toSeller: ['toSeller'],
  toPlatform: ['toPlatform'],
  /** Kept by the platform when a moderator removes the placement. */
  forfeited: ['forfeit'],
} as const;
type Leg = keyof typeof LEGS;
const LEG_NAMES = Object.keys(LEGS) as Leg[];

export const PAIR_LIMIT = 100;
const STICKERS_PER_PAIR = 5;
/** The main app's `PlacementStatus`. */
const STATUSES = ['pending', 'approved', 'declined', 'expired', 'removed'] as const;

/** A placement with no `spendType` predates the column, and its escrow is yellow. */
const currency = sql<string>`coalesce(p."spendType", 'yellow')`;

export type PlacementPair = {
  placerId: number;
  placerName: string | null;
  ownerId: number;
  ownerName: string | null;
  sellerId: number | null;
  surface: string;
  currency: string;
  placements: number;
  free: number;
  statuses: Record<string, number>;
  /** Buzz that moved, by leg: into escrow from the placer, back to them, and out to the other ends. */
  held: number;
  refunded: number;
  toOwner: number;
  toSeller: number;
  toPlatform: number;
  forfeited: number;
  /** Placer and owner are both in the asked-about set. */
  withinSet: boolean;
  /** Sticker placements only: the most used stickers. */
  stickers: { cosmeticId: number; name: string | null; count: number }[];
};

export type PlacementAccount = {
  userId: number;
  username: string | null;
  /** By currency: placements this account made, and the Buzz it held and got back. */
  placed: Record<string, { placements: number; held: number; refunded: number; forfeited: number }>;
  /** By currency: placements on this account's content, and the Buzz paid to it as owner. */
  received: Record<string, { placements: number; earned: number }>;
};

export type PlacementFlows = {
  days: number;
  accounts: PlacementAccount[];
  pairs: PlacementPair[];
  truncated: boolean;
};

const legSum = (kinds: readonly string[]) =>
  sql<string>`coalesce(sum(t.amount) filter (where t.kind in (${sql.join([...kinds])})), 0)`;
const sumOf = (leg: Leg) => sql<string>`coalesce(sum(t.${sql.ref(leg)}), 0)`.as(leg);

export async function getPlacementFlows(userIds: number[], days = 90): Promise<PlacementFlows> {
  const ids = [...new Set(userIds)].filter(isInt4Id);
  const window = Math.min(MAX_BUZZ_DAYS, Math.max(1, Math.trunc(days)));
  if (!ids.length) return { days: window, accounts: [], pairs: [], truncated: false };
  const since = new Date(Date.now() - window * 86_400_000);

  // One row per placement in scope, with its settled legs summed. A leg with no transactionId has
  // not moved yet.
  const inScope = dbRead
    .selectFrom('Placement as p')
    .where((eb) => eb.or([eb('p.placerId', 'in', ids), eb('p.ownerId', 'in', ids)]))
    .where('p.createdAt', '>=', since);

  const placements = inScope.leftJoin(
    (eb) =>
      eb
        .selectFrom('PlacementTransaction as t')
        .select(['t.placementId', ...LEG_NAMES.map((leg) => legSum(LEGS[leg]).as(leg))])
        .where('t.transactionId', 'is not', null)
        // Without this the legs of every placement site-wide are summed before the join.
        .where('t.placementId', 'in', inScope.select('p.id'))
        .groupBy('t.placementId')
        .as('t'),
    (join) => join.onRef('t.placementId', '=', 'p.id')
  );

  const [pairRows, placedRows, receivedRows] = await Promise.all([
    placements
      .select((eb) => [
        'p.placerId',
        'p.ownerId',
        'p.sellerId',
        'p.surface',
        currency.as('currency'),
        eb.fn.countAll<string>().as('placements'),
        sql<string>`count(*) filter (where p.free)`.as('free'),
        ...STATUSES.map((status) =>
          sql<string>`count(*) filter (where p.status = ${status})`.as(status)
        ),
        ...LEG_NAMES.map(sumOf),
      ])
      .groupBy(['p.placerId', 'p.ownerId', 'p.sellerId', 'p.surface', currency])
      // Pairs inside the set first: with the cap, those are the rows the question is about.
      .orderBy((eb) => eb.and([eb('p.placerId', 'in', ids), eb('p.ownerId', 'in', ids)]), 'desc')
      .orderBy('placements', 'desc')
      .limit(PAIR_LIMIT + 1)
      .execute(),
    placements
      .select((eb) => [
        'p.placerId as userId',
        currency.as('currency'),
        eb.fn.countAll<string>().as('placements'),
        sumOf('held'),
        sumOf('refunded'),
        sumOf('forfeited'),
      ])
      .where('p.placerId', 'in', ids)
      .groupBy(['p.placerId', currency])
      .execute(),
    placements
      .select((eb) => [
        'p.ownerId as userId',
        currency.as('currency'),
        eb.fn.countAll<string>().as('placements'),
        sql<string>`coalesce(sum(t."toOwner"), 0)`.as('earned'),
      ])
      .where('p.ownerId', 'in', ids)
      .groupBy(['p.ownerId', currency])
      .execute(),
  ]);

  const truncated = pairRows.length > PAIR_LIMIT;
  const shown = pairRows.slice(0, PAIR_LIMIT);

  // Only for the sticker pairs shown, so the read is bounded by the pair cap rather than the table.
  const stickerPairs = shown.filter((r) => r.surface === 'sticker');
  const stickerRows = stickerPairs.length
    ? await inScope
        .select((eb) => [
          'p.placerId',
          'p.ownerId',
          'p.sellerId',
          currency.as('currency'),
          sql<string>`(p.data->>'cosmeticId')`.as('cosmeticId'),
          eb.fn.countAll<string>().as('count'),
        ])
        .where('p.surface', '=', 'sticker')
        .where((eb) =>
          eb(
            eb.refTuple('p.placerId', 'p.ownerId'),
            'in',
            stickerPairs.map((r) => eb.tuple(r.placerId, r.ownerId))
          )
        )
        // The pair rows' own grouping, so each row lists only its own stickers.
        .groupBy(['p.placerId', 'p.ownerId', 'p.sellerId', currency, sql`p.data->>'cosmeticId'`])
        .execute()
    : [];

  const cosmeticIds = [...new Set(stickerRows.map((s) => Number(s.cosmeticId)).filter(isInt4Id))];
  const [users, cosmetics] = await Promise.all([
    usersByIds([...new Set([...ids, ...shown.flatMap((r) => [r.placerId, r.ownerId])])]),
    cosmeticIds.length
      ? dbRead
          .selectFrom('Cosmetic')
          .select(['id', 'name'])
          .where('id', 'in', cosmeticIds)
          .execute()
      : Promise.resolve([]),
  ]);
  const cosmeticName = new Map(cosmetics.map((c) => [c.id, c.name]));
  const name = (id: number) => users.get(id)?.username ?? null;
  const inSet = new Set(ids);

  const pairs: PlacementPair[] = shown.map((r) => ({
    placerId: r.placerId,
    placerName: name(r.placerId),
    ownerId: r.ownerId,
    ownerName: name(r.ownerId),
    sellerId: r.sellerId,
    surface: r.surface,
    currency: r.currency,
    placements: Number(r.placements),
    free: Number(r.free),
    statuses: Object.fromEntries(
      STATUSES.map((status) => [status, Number(r[status])]).filter(([, n]) => n)
    ),
    ...(Object.fromEntries(LEG_NAMES.map((leg) => [leg, Number(r[leg])])) as Record<Leg, number>),
    withinSet: inSet.has(r.placerId) && inSet.has(r.ownerId),
    stickers:
      r.surface === 'sticker'
        ? stickerRows
            .filter(
              (s) =>
                s.placerId === r.placerId &&
                s.ownerId === r.ownerId &&
                s.sellerId === r.sellerId &&
                s.currency === r.currency
            )
            .map((s) => ({
              cosmeticId: Number(s.cosmeticId),
              name: cosmeticName.get(Number(s.cosmeticId)) ?? null,
              count: Number(s.count),
            }))
            .filter((s) => isInt4Id(s.cosmeticId))
            .sort((a, b) => b.count - a.count)
            .slice(0, STICKERS_PER_PAIR)
        : [],
  }));

  const accounts: PlacementAccount[] = ids.map((userId) => ({
    userId,
    username: name(userId),
    placed: Object.fromEntries(
      placedRows
        .filter((r) => r.userId === userId)
        .map((r) => [
          r.currency,
          {
            placements: Number(r.placements),
            held: Number(r.held),
            refunded: Number(r.refunded),
            forfeited: Number(r.forfeited),
          },
        ])
    ),
    received: Object.fromEntries(
      receivedRows
        .filter((r) => r.userId === userId)
        .map((r) => [r.currency, { placements: Number(r.placements), earned: Number(r.earned) }])
    ),
  }));

  return { days: window, accounts, pairs, truncated };
}

export type PlacementParties = {
  placementId: number;
  surface: string;
  placerId: number;
  ownerId: number;
  sellerId: number | null;
};

/** The placement a Buzz transaction belongs to, from its `placement-<id>-<leg>` reference. */
export function placementIdOf(externalTransactionId: string | null | undefined): number | null {
  const m = /^placement-(\d+)-[A-Za-z]/.exec(externalTransactionId ?? '');
  const id = m ? Number(m[1]) : NaN;
  return isInt4Id(id) ? id : null;
}

/** Both ends of each referenced placement, in one read. A reference that does not parse is skipped. */
export async function getPlacementParties(
  externalTransactionIds: (string | null)[]
): Promise<Map<number, PlacementParties>> {
  const ids = [...new Set(externalTransactionIds.map(placementIdOf).filter((id) => id !== null))];
  if (!ids.length) return new Map();
  const rows = await dbRead
    .selectFrom('Placement')
    .select(['id', 'surface', 'placerId', 'ownerId', 'sellerId'])
    .where('id', 'in', ids)
    .execute();
  return new Map(
    rows.map((r) => [
      r.id,
      {
        placementId: r.id,
        surface: r.surface,
        placerId: r.placerId,
        ownerId: r.ownerId,
        sellerId: r.sellerId,
      },
    ])
  );
}
