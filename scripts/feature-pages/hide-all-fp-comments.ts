/**
 * Runbook: with featurePagesMirror braked, removes every Feature Pages comment the data.civitai.com
 * platform may hold text for, hidden ones included, before the mirror job is taken out. The mirror
 * is the only path that pushes later purges and erasures, so this runs first, and it must report 0
 * remaining.
 *
 * Usage:
 *   pnpm run tsscript scripts/feature-pages/hide-all-fp-comments.ts            # dry run: count only
 *   pnpm run tsscript scripts/feature-pages/hide-all-fp-comments.ts --execute  # remove, then read back
 *
 * Requires the app's .env: the Feature Pages signer settings and the hub service-token client.
 */
import { hideAllFpComments } from '~/server/services/feature-pages/mirror.service';

const execute = process.argv.includes('--execute');

hideAllFpComments({ execute })
  .then((result) => {
    console.log(JSON.stringify({ execute, ...result }));
    process.exit(execute && (result.remaining > 0 || result.failed > 0) ? 1 : 0);
  })
  .catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
