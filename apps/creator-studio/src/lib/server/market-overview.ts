import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import { sfwBrowsingLevelsFlag } from '@civitai/shared';
import { baseModelGroups, baseModels } from '@civitai/shared/basemodel.constants';
import { safeError } from '@civitai/axiom';
import type { SessionUser } from '@civitai/auth';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getLogger } from '$lib/server/logger';
import { modFallbackFlagEnabled } from '$lib/server/main-app-flags';
import { shownOnSomeSiteSql } from '$lib/server/models';
import {
  buildMarketSnapshot,
  displayEcosystem,
  gatedFreeModelIds,
  NAMED_TYPES,
  namedEcosystems,
  type FreeCellRow,
  type GatedRow,
  marketView,
  parseMarketFilters,
  type MarketSnapshot,
} from '$lib/analytics/market-overview';

export const MARKET_OVERVIEW_FLAG = 'creator-market-overview';

export const marketOverviewEnabled = (user: SessionUser) =>
  modFallbackFlagEnabled(MARKET_OVERVIEW_FLAG, user);

type Db = typeof dbRead;

// A live gate, as models.ts's paidAccessFilter reads it. Reads alias `pa` (PaidAccess).
const LIVE_GATE = sql`pa."entityType" = 'ModelVersion' and (pa."endsAt" is null or pa."endsAt" > now())`;
const PUBLIC_VERSION = sql`mv."status" = 'Published' and mv."availability" = 'Public'`;

export async function readGatedRows(db: Db): Promise<GatedRow[]> {
  const { rows } = await sql<GatedRow>`
    select m.id as "modelId", m."userId" as "ownerId", m.type::text as type, mv."baseModel",
      m."nsfwLevel", pa."timeframeDays", pa."endsAt", pa.terms
    from "PaidAccess" pa
    join "ModelVersion" mv on mv.id = pa."entityId"
    join "Model" m on m.id = mv."modelId"
    where ${LIVE_GATE} and ${PUBLIC_VERSION} and m."deletedAt" is null and ${shownOnSomeSiteSql('m')}
  `.execute(db);
  return rows.map((r) => ({ ...r, nsfwLevel: Number(r.nsfwLevel) }));
}

/**
 * Free models, one fine cell each by the ecosystem of one of their public versions: no active gate on a public
 * version, or only gates that charge nothing (`gatedFree`). The ecosystem is mapped in SQL before
 * `count(distinct)`, because seller counts per raw base model do not add up.
 */
export async function readFreeCells(
  db: Db,
  named: Set<string>,
  gatedFree: number[]
): Promise<FreeCellRow[]> {
  const names = [...new Set([...baseModels, ...baseModelGroups])];
  const ecoMap = sql.join(names.map((n) => sql`(${n}::text, ${displayEcosystem(n, named)}::text)`));
  const namedTypes = sql.join(NAMED_TYPES.map((t) => sql.lit(t)));
  const { rows } = await sql<FreeCellRow>`
    with eco(base, ecosystem) as (values ${ecoMap}),
    -- One pass over public versions instead of per-model subqueries.
    v as (
      select mv."modelId",
        count(*)::int as versions,
        max(mv."baseModel") as base,
        bool_or(pa."entityId" is not null) as gated
      from "ModelVersion" mv
      left join "PaidAccess" pa on pa."entityId" = mv.id and ${LIVE_GATE}
      where ${PUBLIC_VERSION}
      group by mv."modelId"
    ),
    fm as (
      select m.id, m."userId", v.base, v.versions,
        case when (m."nsfwLevel" & ~${sql.lit(sfwBrowsingLevelsFlag)}) = 0 then 'sfw' else 'nsfw' end as rating,
        case when m.type::text in (${namedTypes}) then m.type::text else 'Other' end as type
      from v join "Model" m on m.id = v."modelId"
      where m."deletedAt" is null and ${shownOnSomeSiteSql('m', { publicVersionKnown: true })}
        and (not v.gated or m.id = any(${gatedFree}::int[]))
    )
    select fm.rating, fm.type, coalesce(eco.ecosystem, 'Other') as ecosystem,
      count(*)::int as models, sum(fm.versions)::int as versions,
      count(distinct fm."userId")::int as sellers
    from fm left join eco on eco.base = fm.base
    group by 1, 2, 3
  `.execute(db);
  return rows;
}

export async function readMarketSnapshot(db: Db): Promise<MarketSnapshot> {
  const gated = await readGatedRows(db);
  const named = namedEcosystems(gated);
  return buildMarketSnapshot(
    gated,
    await readFreeCells(db, named, gatedFreeModelIds(gated)),
    named
  );
}

const READ_TIMEOUT = sql`set local statement_timeout = '10s'`;

const marketCache = createCache({
  // Bump the version on any change to the floor, so a fixed rule never serves a payload built by the old one.
  name: 'market-overview:v1',
  ttlSeconds: 3600,
  fetch: async () => {
    const started = Date.now();
    const snapshot = await dbRead.transaction().execute(async (trx) => {
      await READ_TIMEOUT.execute(trx);
      return readMarketSnapshot(trx);
    });
    getLogger().logToAxiom({
      name: 'market-overview-fill',
      payload: {
        ms: Date.now() - started,
        paid: snapshot.paid.length,
        free: snapshot.free.length,
        suppressed: snapshot.suppressed.paid + snapshot.suppressed.free,
      },
    });
    return snapshot;
  },
});

// Each instance keeps its last good snapshot and reuses it for the cache TTL, so a Redis outage (where createCache
// fails open and would refill on every request) doesn't turn each view into a catalogue scan. Concurrent misses share
// one fill, and a failed fill (including a floor breach) never replaces the snapshot.
export const TTL_MS = 3_600_000;
export const RETRY_AFTER_MS = 60_000;

export function snapshotReader(
  load: () => Promise<MarketSnapshot>,
  clock: () => number = Date.now
) {
  let lastGood: MarketSnapshot | null = null;
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let inflight: Promise<MarketSnapshot | null> | null = null;
  return (): Promise<MarketSnapshot | null> => {
    const now = clock();
    if (now - loadedAt < TTL_MS || now - failedAt < RETRY_AFTER_MS)
      return Promise.resolve(lastGood);
    inflight ??= load()
      .then((snapshot) => {
        lastGood = snapshot;
        loadedAt = clock();
        return snapshot;
      })
      .catch((error) => {
        failedAt = clock();
        getLogger().logToAxiom({ name: 'market-overview-fill-failed', error: safeError(error) });
        return lastGood;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

export const getMarketSnapshot = snapshotReader(() => marketCache.get({}));

/** GET `/analytics/base-models/market`: 404 unless the flag is on for the viewer, 503 with no snapshot yet. */
export const marketHandler =
  (
    enabled: (user: SessionUser) => Promise<boolean>,
    snapshot: () => Promise<MarketSnapshot | null>
  ): RequestHandler =>
  async ({ locals, url }) => {
    if (!(await enabled(locals.user))) throw error(404, 'Not found');
    const s = await snapshot();
    if (!s) throw error(503, 'The market overview is unavailable right now.');
    return json(marketView(s, parseMarketFilters(url.searchParams)), {
      headers: { 'cache-control': 'private, no-store' },
    });
  };
