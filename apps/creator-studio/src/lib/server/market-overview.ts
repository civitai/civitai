import { sql } from '@civitai/db/kysely';
import { sfwBrowsingLevelsFlag } from '@civitai/shared';
import { baseModelGroups, baseModels } from '@civitai/shared/basemodel.constants';
import { safeError } from '@civitai/axiom';
import type { SessionUser } from '@civitai/auth';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { getLogger } from '$lib/server/logger';
import { modFallbackFlagEnabled } from '$lib/server/main-app-flags';
import { paidAccessFilter, shownOnSomeSiteSql } from '$lib/server/models';
import {
  buildMarketSnapshot,
  displayEcosystem,
  gatedFreeModelIds,
  NAMED_TYPES,
  namedEcosystems,
  type FreeCellRow,
  type GatedRow,
  type MarketSnapshot,
} from '$lib/analytics/market-overview';

export const MARKET_OVERVIEW_FLAG = 'creator-market-overview';

export const marketOverviewEnabled = (user: SessionUser) =>
  modFallbackFlagEnabled(MARKET_OVERVIEW_FLAG, user);

type Db = typeof dbRead;

const PUBLIC_VERSION = sql`mv."status" = 'Published' and mv."availability" = 'Public'`;

export async function readGatedRows(db: Db): Promise<GatedRow[]> {
  const { rows } = await sql<GatedRow>`
    select m.id as "modelId", m."userId" as "ownerId", m.type::text as type, mv."baseModel",
      m."nsfwLevel", pa."timeframeDays", pa."endsAt", pa.terms
    from "PaidAccess" pa
    join "ModelVersion" mv on mv.id = pa."entityId"
    join "Model" m on m.id = mv."modelId"
    where pa."entityType" = 'ModelVersion' and (pa."endsAt" is null or pa."endsAt" > now()) and ${PUBLIC_VERSION} and m."deletedAt" is null and ${shownOnSomeSiteSql('m')}
  `.execute(db);
  return rows.map((r) => ({ ...r, nsfwLevel: Number(r.nsfwLevel) }));
}

/**
 * Free models, one fine cell each by the ecosystem of their newest public version: no active gate on a public
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
    fm as (
      select m.id, m."userId",
        case when (m."nsfwLevel" & ~${sql.lit(sfwBrowsingLevelsFlag)}) = 0 then 'sfw' else 'nsfw' end as rating,
        case when m.type::text in (${namedTypes}) then m.type::text else 'Other' end as type,
        (select mv."baseModel" from "ModelVersion" mv where mv."modelId" = m.id and ${PUBLIC_VERSION}
          order by mv."publishedAt" desc nulls last, mv.id desc limit 1) as base,
        (select count(*) from "ModelVersion" mv where mv."modelId" = m.id and ${PUBLIC_VERSION})::int as versions
      from "Model" m
      where m."deletedAt" is null and ${shownOnSomeSiteSql('m')}
        and (
          m.id = any(${gatedFree}::int[])
          or not exists (
            select 1 from "ModelVersion" mv
            where mv."modelId" = m.id and ${PUBLIC_VERSION} and ${paidAccessFilter('mv')}
          )
        )
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
      ms: Date.now() - started,
      paid: snapshot.paid.length,
      free: snapshot.free.length,
      suppressed: snapshot.suppressed.paid + snapshot.suppressed.free,
    });
    return snapshot;
  },
});

// createCache fails open: with Redis down every view would refill. This instance serves its last good snapshot
// instead, and a failed fill (including a floor breach) never replaces it.
let lastGood: MarketSnapshot | null = null;

export async function getMarketSnapshot(): Promise<MarketSnapshot | null> {
  try {
    lastGood = await marketCache.get({});
  } catch (error) {
    getLogger().logToAxiom({ name: 'market-overview-fill-failed', error: safeError(error) });
  }
  return lastGood;
}
