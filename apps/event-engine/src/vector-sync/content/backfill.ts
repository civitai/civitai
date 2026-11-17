/**
 * Fills one content collection, newest row first:
 *   node dist/vector-sync/content/backfill.js --domain <name> --to <id> [options as in runBackfill]
 */
import { logger } from '@/utils/logger';
import { parseBackfillArgs, runBackfill } from '../domain/backfill';
import { selectDomains } from './consumer';

if (require.main === module) {
  (async () => {
    const args = parseBackfillArgs(process.argv.slice(2));
    if (!args.domain) throw new Error('--domain <name> is required');
    const [domain] = selectDomains([args.domain]);
    await runBackfill(domain, args);
  })().catch((err) => {
    logger.error({ err }, 'content-backfill: failed');
    process.exit(1);
  });
}
