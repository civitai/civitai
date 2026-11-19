import { describe, expect, it } from 'vitest';
import {
  countAll,
  diffCounts,
  formatBaseline,
  parse,
  productionSources,
  rawAbortTimeouts,
  type Counts,
} from './source-ratchet.harness';

/**
 * RATCHET: raw `AbortSignal.timeout(…)` in server code, counted per file.
 *
 * `~/server/utils/fetch-timeout` owns outbound deadlines: `outboundFetch(url, { timeoutMs })` for a
 * fetch, `fetchTimeoutSignal(ms)` / `withFetchTimeout(ms, signal)` when you need the signal. They
 * read the `outbound-fetch-timeouts-off` switch, so every deadline can be dropped at once if one
 * proves too tight in production. A raw `AbortSignal.timeout` cannot be switched off, and it is
 * the shape an agent copies from the nearest file. This freezes the count.
 *
 * Scope: `src/server/**` and `src/pages/api/**`, test files excluded. Exempt:
 * `src/server/utils/fetch-timeout.ts`, which is where the canonical helpers call it.
 *
 * Known gap: `const T = AbortSignal.timeout; T(5)` or a reference through another alias is not
 * counted. Baselined sites are grandfathered as found, including any that are not outbound HTTP.
 */

const GLOBS = ['src/server/**/*.{ts,tsx}', 'src/pages/api/**/*.{ts,tsx}'];
const EXEMPT = ['src/server/utils/fetch-timeout.ts'];

const BASELINE: Counts = {
  'src/pages/api/internal/blocks/git-push.ts': 1,
  'src/pages/api/upload/complete.ts': 1,
  'src/server/auth/preview-access.ts': 1,
  'src/server/beacon/beacon-go-shadow.ts': 1,
  'src/server/clickhouse/tracker.ts': 1,
  'src/server/events/points/clickhouse-limits.ts': 1,
  'src/server/events/points/placement-stats.ts': 1,
  'src/server/freshdesk-agent/freshdesk-investigation-tools.ts': 1,
  'src/server/http/orchestrator/flagged-consumers.ts': 1,
  'src/server/integrations/beehiiv.ts': 1,
  'src/server/integrations/moderation-shadow-probe.ts': 1,
  'src/server/integrations/moderation.ts': 1,
  'src/server/jobs/announcement-media-check.ts': 1,
  'src/server/jobs/process-vault-items.ts': 1,
  'src/server/jobs/retry-image-storage-deletes.ts': 1,
  'src/server/routers/blocks.router.ts': 1,
  'src/server/services/blocks/apps-pipeline.service.ts': 5,
  'src/server/services/blocks/block-image-upload.service.ts': 2,
  'src/server/services/blocks/dev-tunnel.service.ts': 1,
  'src/server/services/blocks/forgejo.service.ts': 3,
  'src/server/services/bounty-entry-file-check.service.ts': 1,
  'src/server/services/cdn-access.service.ts': 1,
  'src/server/services/cover-image.service.ts': 1,
  'src/server/services/creator-service-deal-file-access.ts': 1,
  'src/server/services/creator-service-deal-file-scan.ts': 2,
  'src/server/services/creator-shop.service.ts': 1,
  'src/server/services/csam-evidence-spool.ts': 1,
  'src/server/services/csam-original-image.ts': 4,
  'src/server/services/feed-shadow.service.ts': 1,
  'src/server/services/feedback-hq.service.ts': 2,
  'src/server/services/generator-evidence/orchestrator-evidence.ts': 5,
  'src/server/services/huggingface.service.ts': 1,
  'src/server/services/image.service.ts': 4,
  'src/server/services/integration.service.ts': 1,
  'src/server/services/orchestrator/assert-workflow-owner.ts': 1,
  'src/server/services/orchestrator/blobRatings.ts': 2,
  'src/server/services/orchestrator/cancel-pending-workflows.ts': 1,
  'src/server/services/orchestrator/civitai.ts': 1,
  'src/server/services/orchestrator/consumer-blob-scan.ts': 1,
  'src/server/services/orchestrator/orchestrator.service.ts': 2,
  'src/server/services/orchestrator/training/studio-dataset-archive.service.ts': 1,
  'src/server/services/orchestrator/workflows.ts': 2,
  'src/server/services/review-batch/review-batch.service.ts': 1,
  'src/server/services/semantic-guard-status.ts': 1,
  'src/server/services/semantic-search-client.ts': 1,
  'src/server/services/site-search.service.ts': 1,
  'src/server/services/training-data-scan.service.ts': 3,
  'src/server/services/vault-item-deletion.ts': 1,
  'src/server/trpc/feed-go-shadow.ts': 2,
  'src/server/utils/bot-detection/refresh-bot-ips.ts': 1,
  'src/server/utils/created-image-media-probe.ts': 1,
  'src/server/utils/og-image-helpers.ts': 1,
  'src/server/utils/stored-image-probe.ts': 2,
  'src/server/warmup.ts': 1,
};

const MESSAGE_GROWN =
  'New raw AbortSignal.timeout in server code. Use outboundFetch(url, { timeoutMs }) or ' +
  'fetchTimeoutSignal(ms) / withFetchTimeout(ms, signal) from ~/server/utils/fetch-timeout, ' +
  'which honour the outbound-fetch-timeouts-off switch.';
const MESSAGE_SHRUNK =
  'Fewer raw AbortSignal.timeout calls than the baseline records. Lower BASELINE in ' +
  'no-raw-abort-timeout.test.ts to match, in this commit.';

describe('no new raw AbortSignal.timeout in server code (ratchet)', () => {
  it('positive control: calls count, comments, strings and the helper do not', () => {
    const count = (src: string) => rawAbortTimeouts(parse('x.ts', src));
    expect(count('await fetch(u, { signal: AbortSignal.timeout(5000) });')).toBe(1);
    expect(
      count('const s = globalThis.AbortSignal.timeout(1); const t = AbortSignal.timeout(2);')
    ).toBe(2);
    expect(count("// AbortSignal.timeout(5000)\nconst x = 'AbortSignal.timeout(1)';")).toBe(0);
    expect(count('await outboundFetch(u, { timeoutMs: 5000 }); fetchTimeoutSignal(10);')).toBe(0);
    expect(count('AbortSignal.any([a, b]);')).toBe(0);
  });

  const current = countAll(productionSources(GLOBS, EXEMPT), 'AbortSignal', (sf) =>
    rawAbortTimeouts(sf)
  );
  const { grown, shrunk } = diffCounts(current, BASELINE);

  it('no file gains a raw AbortSignal.timeout', () => {
    expect(grown, MESSAGE_GROWN).toEqual([]);
  });

  it('the baseline matches the code (lower it when a site moves to the helper)', () => {
    expect(shrunk, `${MESSAGE_SHRUNK}\nCurrent counts:\n${formatBaseline(current)}`).toEqual([]);
  });
});
