import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  CLEANUP_INDEXES,
  EMPTY_PAGE_BACKOFF_MS,
  EMPTY_PAGE_CONFIRM_DELAY_MS,
  EMPTY_PAGE_TRUST_COVERAGE,
  fetchValidIds,
} from '~/server/meilisearch/cleanup';
import { assessPassCoverage } from '~/server/meilisearch/cleanup-coverage';
import { searchClient } from '~/server/meilisearch/client';
import type { JobContext } from '~/server/jobs/job';
import { modelSearchIndexSelect } from '~/server/selectors/model.selector';

/**
 * How recently a model must have changed for a disagreement to count as CHURN, not residue.
 *
 * Inside this window, a missing document can still be waiting for the sync, and an
 * ineligible one can still be waiting for the delete queue or the nightly cleanup at 02:00.
 * Past it, nothing scheduled is going to fix the disagreement.
 */
export const RECONCILE_CHURN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many ids of each population a report lists. The counts are always exact. */
export const RECONCILE_SAMPLE_SIZE = 100;

const PAGE_SIZE = 10000;
const VERIFY_CHUNK = 1000;

const modelsCfg = CLEANUP_INDEXES.find((c) => c.key === 'models')!;

export type ModelsIndexReconcileResult = {
  indexName: string;
  /** False when the index scan did not reach its end; nothing was classified. */
  complete: boolean;
  totalInIndex: number | null;
  documentsScanned: number;
  pullableScanned: number;
  /** Pullable in Postgres, with no document. */
  missing: {
    candidates: number;
    /** Changed outside the churn window: nothing scheduled will index these. */
    residue: number[];
    /** Changed inside the churn window: the sync may not have reached them yet. */
    pending: number[];
    /** Pullable but with no published, searchable version, so the indexer skips them by design. */
    noEligibleVersion: number[];
    /** Gone from the diff on re-check against the primary and the live index. */
    resolved: number;
  };
  /** A document whose id is not pullable. */
  orphaned: {
    candidates: number;
    /** Changed outside the churn window, or with no `Model` row at all. */
    residue: number[];
    /** Changed inside the churn window: delete-queue churn. */
    churn: number[];
    /** `Model.status` of each confirmed orphan; `missing` when there is no row. */
    byStatus: Record<string, number>;
    resolved: number;
  };
};

export type ReconcileOptions = {
  now?: Date;
  jobContext?: JobContext;
  delay?: (ms: number) => Promise<void>;
};

/** Ids in `a` that are not in `b`. Both must be ascending. */
export function sortedDifference(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const id of a) {
    while (j < b.length && b[j] < id) j++;
    if (b[j] !== id) out.push(id);
  }
  return out;
}

function assertAscending(ids: number[], after: number, source: string) {
  let prev = after;
  for (const id of ids) {
    if (!(id > prev)) throw new Error(`${source} returned ids out of order (${id} after ${prev})`);
    prev = id;
  }
}

export async function reconcileModelsIndex(
  opts: ReconcileOptions = {}
): Promise<ModelsIndexReconcileResult> {
  if (!searchClient) throw new Error('searchClient not configured');
  const index = searchClient.index(modelsCfg.indexName);
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? new Date();
  const churnCutoff = new Date(now.getTime() - RECONCILE_CHURN_WINDOW_MS);

  const [stats, settings] = await Promise.all([index.getStats(), index.getSettings()]);
  const maxTotalHits = settings.pagination?.maxTotalHits;
  const pageSize =
    typeof maxTotalHits === 'number' && maxTotalHits > 0
      ? Math.min(PAGE_SIZE, maxTotalHits)
      : PAGE_SIZE;

  const result: ModelsIndexReconcileResult = {
    indexName: modelsCfg.indexName,
    complete: false,
    totalInIndex: stats.numberOfDocuments,
    documentsScanned: 0,
    pullableScanned: 0,
    missing: { candidates: 0, residue: [], pending: [], noEligibleVersion: [], resolved: 0 },
    orphaned: { candidates: 0, residue: [], churn: [], byStatus: {}, resolved: 0 },
  };

  const withRetries = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      opts.jobContext?.checkIfCanceled();
      try {
        return await fn();
      } catch (err) {
        if (attempt >= 3) throw err;
        await delay(attempt * 500 + 500);
      }
    }
  };

  const fetchDocPage = async (cursor: number) => {
    const page = await withRetries(() =>
      index.search<{ id: number }>('', {
        filter: `id > ${cursor}`,
        sort: ['id:asc'],
        limit: pageSize,
        attributesToRetrieve: ['id'],
      })
    );
    return page.hits.map((h) => h.id);
  };

  const documentIds: number[] = [];
  for (let cursor = -1; ; ) {
    opts.jobContext?.checkIfCanceled();
    let ids = await fetchDocPage(cursor);
    // The engine can answer empty mid-write, so an empty page far short of the document
    // count is re-asked on cleanup's escalating schedule before it is believed.
    if (ids.length === 0) {
      const coverage = documentIds.length / Math.max(stats.numberOfDocuments, 1);
      const schedule =
        coverage >= EMPTY_PAGE_TRUST_COVERAGE
          ? [EMPTY_PAGE_CONFIRM_DELAY_MS]
          : EMPTY_PAGE_BACKOFF_MS;
      for (const ms of schedule) {
        await delay(ms);
        ids = await fetchDocPage(cursor);
        if (ids.length > 0) break;
      }
    }
    if (ids.length === 0) break;
    assertAscending(ids, cursor, modelsCfg.indexName);
    documentIds.push(...ids);
    cursor = ids[ids.length - 1];
  }
  result.documentsScanned = documentIds.length;

  // An index scan that ended early makes every id above where it stopped look missing.
  const { reachedEnd } = assessPassCoverage({
    stoppedEarly: false,
    passCovered: documentIds.length,
    totalInIndex: stats.numberOfDocuments,
    indexingAtStart: stats.isIndexing ?? null,
  });
  if (!reachedEnd) return result;

  const pullableIds: number[] = [];
  for (let cursor = -1; ; ) {
    opts.jobContext?.checkIfCanceled();
    const page = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Model" WHERE id > ${cursor} ORDER BY id LIMIT ${PAGE_SIZE}
    `;
    if (page.length === 0) break;
    const ids = page.map((r) => r.id);
    const pullable = await withRetries(() => fetchValidIds(modelsCfg, ids, dbRead));
    pullableIds.push(...ids.filter((id) => pullable.has(id)));
    cursor = ids[ids.length - 1];
  }
  result.pullableScanned = pullableIds.length;

  const missingCandidates = sortedDifference(pullableIds, documentIds);
  const orphanCandidates = sortedDifference(documentIds, pullableIds);
  result.missing.candidates = missingCandidates.length;
  result.orphaned.candidates = orphanCandidates.length;

  // The two scans are minutes apart over live data, so every candidate is re-asked of
  // the primary and the index before it is reported.
  for (const ids of chunk(missingCandidates, VERIFY_CHUNK)) {
    opts.jobContext?.checkIfCanceled();
    const [inIndex, stillPullable] = await Promise.all([
      presentInIndex(ids),
      withRetries(() => fetchValidIds(modelsCfg, ids, dbWrite)),
    ]);
    const confirmed = new Set(ids.filter((id) => stillPullable.has(id) && !inIndex.has(id)));
    result.missing.resolved += ids.length - confirmed.size;
    if (confirmed.size === 0) continue;

    const models = await dbWrite.model.findMany({
      where: { id: { in: [...confirmed] } },
      select: {
        id: true,
        updatedAt: true,
        modelVersions: {
          where: modelSearchIndexSelect.modelVersions.where,
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { id: 'asc' },
    });
    for (const m of models) {
      if (m.modelVersions.length === 0) result.missing.noEligibleVersion.push(m.id);
      else if (m.updatedAt > churnCutoff) result.missing.pending.push(m.id);
      else result.missing.residue.push(m.id);
    }
  }

  for (const ids of chunk(orphanCandidates, VERIFY_CHUNK)) {
    opts.jobContext?.checkIfCanceled();
    const [inIndex, pullable] = await Promise.all([
      presentInIndex(ids),
      withRetries(() => fetchValidIds(modelsCfg, ids, dbWrite)),
    ]);
    const confirmed = ids.filter((id) => inIndex.has(id) && !pullable.has(id));
    result.orphaned.resolved += ids.length - confirmed.length;
    if (confirmed.length === 0) continue;

    const rows = await dbWrite.$queryRaw<{ id: number; status: string; updatedAt: Date }[]>`
      SELECT id, status::text AS status, "updatedAt" FROM "Model"
      WHERE id IN (${Prisma.join(confirmed)})
    `;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of confirmed) {
      const row = byId.get(id);
      const status = row?.status ?? 'missing';
      result.orphaned.byStatus[status] = (result.orphaned.byStatus[status] ?? 0) + 1;
      if (row && row.updatedAt > churnCutoff) result.orphaned.churn.push(id);
      else result.orphaned.residue.push(id);
    }
  }

  result.complete = true;
  return result;

  async function presentInIndex(ids: number[]) {
    const page = await withRetries(() =>
      index.search<{ id: number }>('', {
        filter: `id IN [${ids.join(',')}]`,
        limit: ids.length,
        attributesToRetrieve: ['id'],
      })
    );
    return new Set(page.hits.map((h) => h.id));
  }
}
