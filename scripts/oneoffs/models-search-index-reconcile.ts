/**
 * Read-only run of the models search index reconciliation, printed instead of logged.
 * The same check runs daily as the `models-search-index-reconcile` job.
 *
 * Usage:
 *   pnpm tsscript scripts/oneoffs/models-search-index-reconcile.ts
 */

import { summarizeReconcile } from '~/server/jobs/models-search-index-reconcile';
import { reconcileModelsIndex } from '~/server/meilisearch/models-index-reconcile';

async function main() {
  const startedAt = Date.now();
  const result = await reconcileModelsIndex();
  const { level, message, ...summary } = summarizeReconcile(result);
  console.log(`[${level}] ${message}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log('missing residue ids:', result.missing.residue.join(',') || '(none)');
  console.log('orphaned residue ids:', result.orphaned.residue.join(',') || '(none)');
  console.log(`took ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
