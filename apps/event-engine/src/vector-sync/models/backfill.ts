/**
 * Fills the models collection, newest model first:
 *   node dist/vector-sync/models/backfill.js --to <id> [--from <id>] [--limit N] [--page 500]
 *     [--dry-run] [--confirm] [--stamp-catalog]
 * Options as in runBackfill.
 */
import { logger } from '@/utils/logger';
import {
  backfillDomain,
  parseBackfillArgs,
  runBackfill,
  type BackfillOptions,
} from '../domain/backfill';
import { modelDomain } from './domain';
import type { ModelPayload } from './source';

export type ModelBackfillOptions = BackfillOptions;

export const backfillModels = (
  opts: BackfillOptions,
  deps: Parameters<typeof backfillDomain<ModelPayload>>[2]
) => backfillDomain(modelDomain, opts, deps);

if (require.main === module) {
  runBackfill(modelDomain, parseBackfillArgs(process.argv.slice(2))).catch((err) => {
    logger.error({ err }, 'model-backfill: failed');
    process.exit(1);
  });
}
