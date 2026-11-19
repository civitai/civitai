import { describe, expect, it } from 'vitest';
import {
  countAll,
  diffCounts,
  formatBaseline,
  parse,
  productionSources,
  ttlSysRedisWrites,
  type Counts,
} from './source-ratchet.harness';

/**
 * RATCHET: TTL'd writes to sysRedis, counted per file.
 *
 * Data that expires is cache-shaped: losing it early costs a recompute, not correctness. That is
 * what the cluster client and `REDIS_KEYS` are for. sysRedis is the small durable store, and every
 * TTL'd key there competes with state that cannot be rebuilt. This freezes the count per file.
 *
 * What counts, on the sys client, a `.packed` view of it, a `.multi()` pipeline built from it, or
 * a local bound to any of those:
 *   - `set(…, { EX | PX | EXAT | PXAT | expiration })` (an options value that is not an object
 *     literal counts too, since it cannot be read);
 *   - `expire`, `pExpire`, `expireAt`, `pExpireAt`, `setEx`, `pSetEx`, `getEx`, `hExpire`…, and
 *     the client's own `setNxKeepTtlWithEx` / `hSetMultiWithExpire`.
 * Matching is on the AST, so a comment or a string never counts.
 *
 * Known gaps: a sys client handed in as a parameter or object property under another name is not
 * followed. A TTL set inside a Lua script
 * (`sysRedis.eval(SCRIPT, …)` whose script calls `EXPIRE`/`PEXPIRE`) or through `sendCommand` is
 * not counted. Locks, rate-limit windows and
 * idempotency markers are counted alongside caches: whether one of those may live on sysRedis is
 * a judgement for review, and the baseline records today's answer without endorsing it.
 */

const GLOBS = ['src/**/*.{ts,tsx}'];
const EXEMPT = ['src/server/redis/client.ts'];

const BASELINE: Counts = {
  'src/pages/api/testing/fee-allowance-boost.ts': 1,
  'src/pages/api/testing/redis-cluster.ts': 1,
  'src/pages/api/v1/blocks/dev-token.ts': 2,
  'src/pages/api/v1/blocks/submissions.ts': 2,
  'src/pages/api/v1/blocks/withdraw.ts': 2,
  'src/pages/api/webhooks/freshdesk.ts': 1,
  'src/server/auth/session-invalidation.ts': 2,
  'src/server/events/crucible-team-award.ts': 2,
  'src/server/events/index.ts': 1,
  'src/server/events/points/hooks.ts': 1,
  'src/server/events/points/push.ts': 1,
  'src/server/events/points/sync.ts': 3,
  'src/server/events/turf/turf.service.ts': 1,
  'src/server/integrations/moderation-cache-probe.ts': 1,
  'src/server/integrations/moderation-verdict-cache.ts': 1,
  'src/server/jobs/article-ingestion-reconcile.ts': 1,
  'src/server/jobs/audit-remix-sources.ts': 1,
  'src/server/jobs/collection-ai-review.ts': 1,
  'src/server/redis/queues.ts': 1,
  'src/server/routers/blocks.router.ts': 4,
  'src/server/services/app-hibernation/hibernation-deps.ts': 1,
  'src/server/services/article-share.service.ts': 1,
  'src/server/services/blocks/app-fork-start.service.ts': 2,
  'src/server/services/blocks/app-source-repo.service.ts': 1,
  'src/server/services/blocks/app-spend-cap.service.ts': 4,
  'src/server/services/blocks/block-output-unlock-lock.ts': 1,
  'src/server/services/blocks/block-quote-grant.service.ts': 1,
  'src/server/services/blocks/custom-comfy-settle.service.ts': 1,
  'src/server/services/blocks/dev-tunnel-access.service.ts': 2,
  'src/server/services/blocks/dev-tunnel.service.ts': 7,
  'src/server/services/blocks/review-autodeploy.service.ts': 2,
  'src/server/services/blocks/submit-rate-limit.ts': 1,
  'src/server/services/collection.service.ts': 2,
  'src/server/services/crucible-entry-accepted.ts': 1,
  'src/server/services/crucible-judging-session.ts': 2,
  'src/server/services/crucible-theme-review.ts': 1,
  'src/server/services/crucible.service.ts': 5,
  'src/server/services/download-link/download-link.store.ts': 4,
  'src/server/services/games/new-order.service.ts': 1,
  'src/server/services/generation-input-hosts.ts': 1,
  'src/server/services/idempotency-key.service.ts': 4,
  'src/server/services/image-scan-pipeline.ts': 1,
  'src/server/services/image.service.ts': 1,
  'src/server/services/membership-extend.service.ts': 1,
  'src/server/services/message-as-civitai.service.ts': 1,
  'src/server/services/model-file-scan.service.ts': 1,
  'src/server/services/notice-ledger.service.ts': 1,
  'src/server/services/orchestrator/promptAuditing.ts': 3,
  'src/server/services/post-batch.service.ts': 2,
  'src/server/services/review-batch/review-batch.service.ts': 4,
  'src/server/services/scanner-policies.service.ts': 5,
  'src/server/services/text-scan/actions/redetection.ts': 1,
  'src/server/services/training-studio-auto-label.service.ts': 1,
  'src/server/utils/apps-catalog-rate-limit.ts': 2,
  'src/server/utils/block-gen-idempotency.ts': 2,
  'src/server/utils/block-goods-rate-limit.ts': 4,
  'src/server/utils/block-tip-rate-limit.ts': 4,
  'src/server/utils/moderator-endpoint.ts': 1,
  'src/server/utils/rate-limiting.ts': 2,
};

const MESSAGE_GROWN =
  "New TTL'd write on sysRedis. TTL'd data is cache-shaped: use REDIS_KEYS on the cluster client " +
  '(`redis` from ~/server/redis/client); sysRedis is for durable state only.';
const MESSAGE_SHRUNK =
  "Fewer TTL'd sysRedis writes than the baseline records. Lower BASELINE in " +
  'no-ttl-sys-redis-write.test.ts to match, in this commit.';

describe("no new TTL'd sysRedis write (ratchet)", () => {
  it('positive control: each TTL shape counts, and plain writes, comments and strings do not', () => {
    const count = (src: string) => ttlSysRedisWrites(parse('x.ts', src));
    expect(count('await sysRedis.set(k, v, { EX: 60 });')).toBe(1);
    expect(count('await sysRedis.set(k, v, { NX: true, PX: 500 });')).toBe(1);
    expect(count('await sysRedis.packed.set(k, v, { EX: 60 });')).toBe(1);
    expect(count('await sysRedis.set(k, v, opts);')).toBe(1);
    expect(count('await sysRedis.expire(k, 60); await sysRedis.EXPIRE(k, 1);')).toBe(2);
    expect(count('await sysRedis.multi().incr(k).expire(k, 60).exec();')).toBe(1);
    expect(count("const tx = sysRedis.multi(); tx.set(k, '0', { EX: 1 }); await tx.exec();")).toBe(
      1
    );
    expect(count('void (sysRedis as any).pExpireAt(k, t);')).toBe(1);
    expect(count("await sysRedis.setNxKeepTtlWithEx(k, '1', 60);")).toBe(1);
    for (const method of [
      'pExpire',
      'expireAt',
      'setEx',
      'pSetEx',
      'getEx',
      'hExpire',
      'hpExpire',
      'hExpireAt',
      'hpExpireAt',
      'hSetMultiWithExpire',
    ])
      expect(count(`await sysRedis.${method}(k, 60);`), method).toBe(1);
    // Not TTL'd, or not the sys client.
    expect(count('await sysRedis.set(k, v); await sysRedis.set(k, v, { NX: true });')).toBe(0);
    expect(count('await redis.set(k, v, { EX: 60 }); await redis.expire(k, 1);')).toBe(0);
    expect(count("// sysRedis.expire(k, 60)\nconst s = 'sysRedis.set(k, v, { EX: 1 })';")).toBe(0);
  });

  const current = countAll(productionSources(GLOBS, EXEMPT), 'sysRedis', (sf) =>
    ttlSysRedisWrites(sf)
  );
  const { grown, shrunk } = diffCounts(current, BASELINE);

  it("no file gains a TTL'd sysRedis write", () => {
    expect(grown, MESSAGE_GROWN).toEqual([]);
  });

  it('the baseline matches the code (lower it when a write moves off sysRedis)', () => {
    expect(shrunk, `${MESSAGE_SHRUNK}\nCurrent counts:\n${formatBaseline(current)}`).toEqual([]);
  });
});
