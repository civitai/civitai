import { createJob } from './job';
import { logToAxiom } from '~/server/logging/client';
import {
  RECONCILE_SAMPLE_SIZE,
  reconcileModelsIndex,
  type ModelsIndexReconcileResult,
} from '~/server/meilisearch/models-index-reconcile';

export function summarizeReconcile(r: ModelsIndexReconcileResult) {
  const residue = r.missing.residue.length + r.orphaned.residue.length;
  const message = !r.complete
    ? `${r.indexName}: index scan ended at ${r.documentsScanned} of ${r.totalInIndex} document(s); nothing reconciled`
    : `${r.indexName}: ${r.missing.residue.length} pullable model(s) with no document, ` +
      `${r.orphaned.residue.length} document(s) not pullable` +
      ` (churn: ${r.missing.pending.length} not yet indexed, ${r.orphaned.churn.length} not yet deleted)`;

  return {
    level: !r.complete || residue > 0 ? ('error' as const) : ('info' as const),
    message,
    complete: r.complete,
    total: r.totalInIndex,
    documentsScanned: r.documentsScanned,
    pullableScanned: r.pullableScanned,
    missingResidue: r.missing.residue.length,
    missingResidueIds: r.missing.residue.slice(0, RECONCILE_SAMPLE_SIZE),
    missingPending: r.missing.pending.length,
    missingNoEligibleVersion: r.missing.noEligibleVersion.length,
    missingNoEligibleVersionIds: r.missing.noEligibleVersion.slice(0, RECONCILE_SAMPLE_SIZE),
    missingResolved: r.missing.resolved,
    orphanedResidue: r.orphaned.residue.length,
    orphanedResidueIds: r.orphaned.residue.slice(0, RECONCILE_SAMPLE_SIZE),
    orphanedChurn: r.orphaned.churn.length,
    orphanedByStatus: r.orphaned.byStatus,
    orphanedResolved: r.orphaned.resolved,
  };
}

export const modelsSearchIndexReconcileJob = createJob(
  'models-search-index-reconcile',
  '0 6 * * *',
  async (jobContext) => {
    const { level, ...summary } = summarizeReconcile(await reconcileModelsIndex({ jobContext }));
    logToAxiom({ type: level, name: 'models-search-index-reconcile', ...summary }).catch(
      () => undefined
    );
    return summary;
  },
  { lockExpiration: 60 * 60 }
);
