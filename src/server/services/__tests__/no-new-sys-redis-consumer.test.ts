import { describe, expect, it } from 'vitest';
import {
  countAll,
  diffCounts,
  parse,
  productionSources,
  sysRedisConsumer,
  type Counts,
} from './source-ratchet.harness';

/**
 * RATCHET: the set of production files under `src/` that name `sysRedis` or `REDIS_SYS_KEYS`.
 *
 * sysRedis is the small durable store: state that cannot be rebuilt (sessions, ledgers, locks a
 * restart must not drop). Cache-shaped data belongs on the cluster client with `REDIS_KEYS`.
 * This freezes the set of files that name it.
 *
 * Counted per FILE (any identifier named `sysRedis` or `REDIS_SYS_KEYS`, imports included), not
 * per reference, so adding a call inside a file already on the list does not trip it.
 * `no-ttl-sys-redis-write` ratchets the call shape that most clearly marks cache data.
 *
 * Exempt: `src/server/redis/client.ts`, the app shim that builds the client. Test files are not
 * scanned.
 *
 * Known gaps: a client reached through a parameter or object property that never names
 * `sysRedis` in the file (e.g. `redis: PointsRedis` injected by a caller) is invisible here; the
 * caller that passes it in is on the list. The KEY SET is not checked here at all: a new
 * `REDIS_SYS_KEYS` entry, defined in `packages/civitai-redis` and used from a file already on the
 * list, passes.
 */

const GLOBS = ['src/**/*.{ts,tsx}'];
const EXEMPT = ['src/server/redis/client.ts'];

const BASELINE: string[] = [
  'src/server/api-routes/admin/banking-change-notice.ts',
  'src/server/api-routes/admin/klein9b-notice.ts',
  'src/pages/api/download/models/[modelVersionId].ts',
  'src/pages/api/generation/history/callback.ts',
  'src/pages/api/generation/history/index.ts',
  'src/pages/api/internal/redis-sys-usage.ts',
  'src/server/api-routes/mod/flip-phases.ts',
  'src/server/api-routes/mod/new-order/rate-limit-config.ts',
  'src/pages/api/testing/fee-allowance-boost.ts',
  'src/pages/api/testing/redis-cluster.ts',
  'src/pages/api/v1/blocks/dev-token.ts',
  'src/pages/api/v1/blocks/submissions.ts',
  'src/pages/api/v1/blocks/withdraw.ts',
  'src/pages/api/webhooks/freshdesk.ts',
  'src/pages/api/webhooks/scanner-policy-result.ts',
  'src/pages/api/webhooks/stripe.ts',
  'src/server/auth/session-invalidation.ts',
  'src/server/auth/session-verifier.ts',
  'src/server/controllers/buzz-withdrawal-request.controller.ts',
  'src/server/events/base.event.ts',
  'src/server/events/crucible-team-award.ts',
  'src/server/events/index.ts',
  'src/server/events/points/award.ts',
  'src/server/events/points/hooks.ts',
  'src/server/events/points/keys.ts',
  'src/server/events/points/push.ts',
  'src/server/events/points/read.ts',
  'src/server/events/points/referee.ts',
  'src/server/events/points/roster-sync.ts',
  'src/server/events/points/roster.ts',
  'src/server/events/points/self-heal.ts',
  'src/server/events/points/sync.ts',
  'src/server/events/points/watch.ts',
  'src/server/events/scoring/award-results.ts',
  'src/server/events/scoring/cosmetic-placement.service.ts',
  'src/server/events/team-balance.ts',
  'src/server/events/turf/config.ts',
  'src/server/events/turf/flag-day.ts',
  'src/server/events/turf/live.ts',
  'src/server/events/turf/turf-feed.ts',
  'src/server/events/turf/turf-map.ts',
  'src/server/events/turf/turf-watch.ts',
  'src/server/events/turf/turf.service.ts',
  'src/server/freshdesk-agent/freshdesk-investigation-tools.ts',
  'src/server/games/daily-challenge/daily-challenge.utils.ts',
  'src/server/games/new-order/utils.ts',
  'src/server/health/dependency-checks.ts',
  'src/server/integrations/moderation-cache-probe.ts',
  'src/server/integrations/moderation-verdict-cache.ts',
  'src/server/jobs/article-ingestion-reconcile.ts',
  'src/server/jobs/audit-remix-sources.ts',
  'src/server/jobs/cache-cleanup.ts',
  'src/server/jobs/collection-ai-review.ts',
  'src/server/jobs/creator-program-counterparty-review.ts',
  'src/server/jobs/creator-program-prepayout-review.ts',
  'src/server/jobs/entity-moderation.ts',
  'src/server/jobs/job-lock.ts',
  'src/server/jobs/linked-account-review.ts',
  'src/server/jobs/metric-reconciliation-audit.ts',
  'src/server/jobs/remove-deleted-user-images.ts',
  'src/server/jobs/resource-generation-availability.ts',
  'src/server/jobs/update-user-score.ts',
  'src/server/meilisearch/cleanup-cursor.ts',
  'src/server/meilisearch/util.ts',
  'src/server/metrics/base.metrics.ts',
  'src/server/metrics/model.metrics.ts',
  'src/server/orchestrator/get-orchestrator-token.ts',
  'src/server/prom/ingestion-gauge-store.ts',
  'src/server/redis/crucible-elo.redis.ts',
  'src/server/redis/queues.ts',
  'src/server/registry-adapter/snapshot-store.redis.ts',
  'src/server/routers/blocks.router.ts',
  'src/server/routers/buzz-withdrawal-request.router.ts',
  'src/server/routers/orchestrator.router.ts',
  'src/server/routers/research.router.ts',
  'src/server/routers/user-restriction.router.ts',
  'src/server/services/account-deletion-images.ts',
  'src/server/services/api-key.service.ts',
  'src/server/services/app-hibernation/hibernation-deps.ts',
  'src/server/services/article-share.service.ts',
  'src/server/services/banking-change-notice.service.ts',
  'src/server/services/block-registry.service.ts',
  'src/server/services/blocks/app-buzz-usage.service.ts',
  'src/server/services/blocks/app-fork-start.service.ts',
  'src/server/services/blocks/app-source-repo.service.ts',
  'src/server/services/blocks/app-spend-cap.service.ts',
  'src/server/services/blocks/block-buzz-cap.ts',
  'src/server/services/blocks/block-output-unlock-lock.ts',
  'src/server/services/blocks/block-quote-grant.service.ts',
  'src/server/services/blocks/custom-comfy-settle.service.ts',
  'src/server/services/blocks/dev-tunnel-access.service.ts',
  'src/server/services/blocks/dev-tunnel.service.ts',
  'src/server/services/blocks/live-unpublish.service.ts',
  'src/server/services/blocks/review-autodeploy.service.ts',
  'src/server/services/blocks/submit-rate-limit.ts',
  'src/server/services/challenge.service.ts',
  'src/server/services/chat.service.ts',
  'src/server/services/collection.service.ts',
  'src/server/services/content.service.ts',
  'src/server/services/creator-program-bankable.ts',
  'src/server/services/creator-program.service.ts',
  'src/server/services/crucible-bradley-terry.ts',
  'src/server/services/crucible-entry-accepted.ts',
  'src/server/services/crucible-judging-session.ts',
  'src/server/services/crucible-redis-keys.ts',
  'src/server/services/crucible-theme-review-config.ts',
  'src/server/services/crucible-theme-review.ts',
  'src/server/services/crucible.service.ts',
  'src/server/services/daily-challenge.service.ts',
  'src/server/services/download-link/download-link.store.ts',
  'src/server/services/event.service.ts',
  'src/server/services/feed-request-capture.service.ts',
  'src/server/services/games/new-order.service.ts',
  'src/server/services/generation-input-hosts.ts',
  'src/server/services/generation/generation.service.ts',
  'src/server/services/headless-post.service.ts',
  'src/server/services/huggingface-import-config.service.ts',
  'src/server/services/image-scan-pipeline.ts',
  'src/server/services/image-url-ownership.ts',
  'src/server/services/image.service.ts',
  'src/server/services/klein9b-notice.service.ts',
  'src/server/services/knights/sources.ts',
  'src/server/services/membership-extend.service.ts',
  'src/server/services/message-as-civitai.service.ts',
  'src/server/services/model-file-scan.service.ts',
  'src/server/services/nc-earnings-notice.service.ts',
  'src/server/services/notice-ledger.service.ts',
  'src/server/services/nsfwLevels.service.ts',
  'src/server/services/orchestrator/comfy/comfy.utils.ts',
  'src/server/services/orchestrator/prompt-origin.ts',
  'src/server/services/orchestrator/promptAuditing.ts',
  'src/server/services/post-batch.service.ts',
  'src/server/services/pricing-slot.service.ts',
  'src/server/services/review-batch/review-batch.service.ts',
  'src/server/services/review-batch/review-batch.store.ts',
  'src/server/services/scanner-policies.service.ts',
  'src/server/services/semantic-search-audit.service.ts',
  'src/server/services/site-alert.service.ts',
  'src/server/services/system-cache.ts',
  'src/server/services/text-scan/actions/redetection.ts',
  'src/server/services/text-scan/clavata-cutover.ts',
  'src/server/services/text-scan/mode.ts',
  'src/server/services/text-scan/prompt.ts',
  'src/server/services/training-studio-auto-label.service.ts',
  'src/server/services/training.service.ts',
  'src/server/services/upload-prompt-retry.service.ts',
  'src/server/utils/apps-catalog-rate-limit.ts',
  'src/server/utils/block-gen-idempotency.ts',
  'src/server/utils/block-goods-rate-limit.ts',
  'src/server/utils/block-tip-rate-limit.ts',
  'src/server/utils/cache-helpers.ts',
  'src/server/utils/client-config.ts',
  'src/server/utils/moderation-utils.ts',
  'src/server/utils/moderator-endpoint.ts',
  'src/server/utils/rate-limiting.ts',
];

const MESSAGE_GROWN =
  'New sysRedis consumer. Use REDIS_KEYS on the cluster client (`redis` from ~/server/redis/client); ' +
  'sysRedis is for durable state only. If this file genuinely stores state that cannot be rebuilt, ' +
  'add it to BASELINE in no-new-sys-redis-consumer.test.ts in this commit and say why in the PR.';
const MESSAGE_SHRUNK =
  'These files no longer use sysRedis / REDIS_SYS_KEYS. Remove them from BASELINE in ' +
  'no-new-sys-redis-consumer.test.ts so the ratchet keeps up with the code.';

const asCounts = (files: string[]): Counts => Object.fromEntries(files.map((f) => [f, 1]));

describe('no new sysRedis consumer (ratchet)', () => {
  it('positive control: the detector sees an import and a use, and ignores comments and strings', () => {
    const count = (src: string) => sysRedisConsumer(parse('x.ts', src));
    expect(count("import { sysRedis } from '~/server/redis/client';")).toBe(1);
    expect(count('const k = REDIS_SYS_KEYS.SESSION.ALL;')).toBe(1);
    expect(count("import * as r from '~/server/redis/client'; r.sysRedis.get('k');")).toBe(1);
    expect(count("// sysRedis is mentioned here\nconst s = 'REDIS_SYS_KEYS';")).toBe(0);
    expect(count("import { redis, REDIS_KEYS } from '~/server/redis/client';")).toBe(0);
  });

  const current = asCounts(
    Object.keys(
      countAll(productionSources(GLOBS, EXEMPT), ['sysRedis', 'REDIS_SYS_KEYS'], (sf) =>
        sysRedisConsumer(sf)
      )
    )
  );
  const { grown, shrunk } = diffCounts(current, asCounts(BASELINE));

  it('no new file uses sysRedis', () => {
    expect(grown, MESSAGE_GROWN).toEqual([]);
  });

  it('the baseline matches the code (lower it when a file stops using sysRedis)', () => {
    const files = Object.keys(current)
      .sort()
      .map((f) => `  '${f}',`)
      .join('\n');
    expect(shrunk, `${MESSAGE_SHRUNK}\nCurrent files:\n${files}`).toEqual([]);
  });
});
