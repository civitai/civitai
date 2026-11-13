import { parseArgs } from 'util';

import { dbRead } from '~/server/db/client';
import {
  comVersionTextSweepSql,
  sweepComFaceVersionText,
} from '~/server/services/model-com-face-version-text.service';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Queues every model with a .com face whose .com-visible version text has no current verdict, for
 * the `com-face-version-text` job, which rates them at its own pace behind owner edits. The same
 * set the hourly sweep finds, without its per-run limit. Writes only the queue rows; nothing is
 * shown or hidden by it.
 *
 *   pnpm run tsscript scripts/com-face-version-text-backfill.ts             # dry run: count
 *   pnpm run tsscript scripts/com-face-version-text-backfill.ts --apply [--limit N]
 */
const NO_LIMIT = 1_000_000;

async function main() {
  const { values } = parseArgs({
    options: { apply: { type: 'boolean' }, limit: { type: 'string' } },
  });
  const limit = values.limit ? Number(values.limit) : NO_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

  if (!values.apply) {
    const rows = await dbRead.$queryRaw<{ modelId: number }[]>(comVersionTextSweepSql(limit));
    console.log(`dry run: ${rows.length} models would be queued; nothing written`);
    return;
  }
  const queued = await sweepComFaceVersionText(limit);
  console.log(`queued ${queued.length} models`);
}

if (process.argv[1]?.endsWith('com-face-version-text-backfill.ts')) {
  void runScriptAndExit(() => main());
}
