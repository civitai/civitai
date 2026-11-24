/**
 * The API request policy facts the Go feed service's public route reads (apps/feed-go, DESIGN.md §6.2),
 * taken from the modules `applyApiRequestPolicy` (src/server/middleware/api-request-policy.ts) uses:
 *
 *   - `regionBlockDefault`: DEFAULT_REGION_BLOCK_CONFIG, the region block list in force when
 *     REGION_BLOCK_CONFIG is unset (the Go service reads that same variable first, as the app does).
 *   - `botUserAgentPatterns`: the user-agent patterns `verifyBot` requires before it checks the IP
 *     ranges. The Go service never decides a crawler itself: a request matching one goes to the app.
 *   - `privateCacheControl`: PRIVATE_CACHE_CONTROL, the default Cache-Control of an API response.
 *   - `regionBlockResponse`: API_REGION_BLOCK, the 451 (status, Content-Type, body) every API path
 *     answers a blocked region with. With FEED_GO_ANSWER_REGION_BLOCKED on, the Go service writes it
 *     itself instead of handing the request to the app, so the bytes must be the app's own.
 *
 * Writes apps/feed-go/internal/apipolicy/apipolicy.json:
 *
 *   pnpm exec tsx scripts/feed-go-api-policy.ts
 *
 * `scripts/__tests__/feed-go-api-policy.schema-drift.test.ts` fails when the committed file differs from this
 * output, so the Go side cannot drift from the lists it mirrors.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_REGION_BLOCK } from '~/server/middleware/api-request-policy';
import { PRIVATE_CACHE_CONTROL } from '~/server/middleware/middleware-utils';
import { BOT_UA_PATTERNS } from '~/server/utils/bot-detection/verify-bot';
import { DEFAULT_REGION_BLOCK_CONFIG } from '~/server/utils/region-blocking';

export const FEED_GO_API_POLICY_PATH = join(
  __dirname,
  '..',
  'apps/feed-go/internal/apipolicy/apipolicy.json'
);

export function buildFeedGoApiPolicy() {
  return {
    regionBlockDefault: DEFAULT_REGION_BLOCK_CONFIG.map(({ region, effectiveDate }) => ({
      region,
      effectiveDate,
    })),
    botUserAgentPatterns: Object.entries(BOT_UA_PATTERNS)
      .map(([name, re]) => {
        // Go's RE2 reads these as written; only the case-insensitive flag is carried over, so any
        // other flag must be ported deliberately rather than dropped here.
        if (re.flags.replace('i', '') !== '') {
          throw new Error(`bot pattern ${name} has flags ${re.flags}: only "i" is handed to Go`);
        }
        return { name, source: re.source, ignoreCase: re.flags.includes('i') };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    privateCacheControl: PRIVATE_CACHE_CONTROL,
    regionBlockResponse: {
      status: API_REGION_BLOCK.status,
      contentType: API_REGION_BLOCK.contentType,
      body: API_REGION_BLOCK.body,
    },
  };
}

export function renderFeedGoApiPolicy() {
  return JSON.stringify(buildFeedGoApiPolicy(), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('feed-go-api-policy.ts')) {
  writeFileSync(FEED_GO_API_POLICY_PATH, renderFeedGoApiPolicy());
  console.log(`wrote ${FEED_GO_API_POLICY_PATH}`);
}
