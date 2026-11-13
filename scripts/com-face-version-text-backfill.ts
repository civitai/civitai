import { parseArgs } from 'util';

import { dbRead } from '~/server/db/client';
import {
  COM_VERSION_TEXT_WORKFLOWS_PER_RUN,
  comVersionTextSweepSql,
  getComVersionTextPolicy,
  rateComFaceVersionText,
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
 *   pnpm run tsscript scripts/com-face-version-text-backfill.ts --rate-dry-run 20
 *   pnpm run tsscript scripts/com-face-version-text-backfill.ts --apply [--limit N]
 *
 * `--rate-dry-run N` rates the first N models of the set (preview workflows, so it spends) and
 * writes nothing: no verdicts, no queue rows, no holds. It prints how many would be held, so that
 * count can be reviewed before `--apply`.
 */
const NO_LIMIT = 1_000_000;

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean' },
      limit: { type: 'string' },
      'rate-dry-run': { type: 'string' },
    },
  });
  const limit = values.limit ? Number(values.limit) : NO_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const policy = await getComVersionTextPolicy();

  if (values['rate-dry-run']) {
    const sample = Number(values['rate-dry-run']);
    if (!Number.isInteger(sample) || sample < 1)
      throw new Error('--rate-dry-run must be a positive integer');
    const rows = await dbRead.$queryRaw<{ modelId: number }[]>(
      comVersionTextSweepSql(sample, policy)
    );
    const wouldHold: number[] = [];
    let incomplete = 0;
    for (const { modelId } of rows) {
      const result = await rateComFaceVersionText(modelId, COM_VERSION_TEXT_WORKFLOWS_PER_RUN, {
        dryRun: true,
      });
      if (result.csamHits) wouldHold.push(modelId);
      if (result.status !== 'complete') incomplete++;
    }
    console.log(`rate dry run: ${rows.length} models rated; nothing written`);
    console.log(
      `would hold: ${wouldHold.length} models${wouldHold.length ? ` (${wouldHold.join(',')})` : ''}`
    );
    console.log(`not fully rated in one pass: ${incomplete}`);
    return;
  }

  if (!values.apply) {
    const rows = await dbRead.$queryRaw<{ modelId: number }[]>(
      comVersionTextSweepSql(limit, policy)
    );
    console.log(`dry run: ${rows.length} models would be queued; nothing written`);
    return;
  }
  const queued = await sweepComFaceVersionText(limit);
  console.log(`queued ${queued.length} models`);
}

if (process.argv[1]?.endsWith('com-face-version-text-backfill.ts')) {
  void runScriptAndExit(() => main());
}
