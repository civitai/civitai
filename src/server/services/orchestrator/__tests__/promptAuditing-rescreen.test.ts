import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the deferred external-moderation re-screen feature in promptAuditing.ts.
 *
 * Closes the trust-and-safety gap where the inline external moderation (OpenAI
 * omni-moderation, CSAM pre-screen) is fail-soft: when OpenAI is slow/down the
 * pre-screen is silently skipped and never recovered. The new code enqueues those
 * skips and an async job re-screens them, applying the SAME consequence as inline.
 *
 * Strategy: mock every heavy boundary (sysRedis, extModeration, prom metric, db,
 * clickhouse, user/notification/session services) so the REAL promptAuditing logic
 * runs against fakes. We assert on the enqueue contract, the drain/consequence
 * behavior, the attempt-cap drop, fail-soft, and the metric outcomes.
 */

// --- sysRedis mock (durable queue + blocked-prompt store) -------------------
const sysRedis = vi.hoisted(() => ({
  lPush: vi.fn(async () => 1),
  lTrim: vi.fn(async () => undefined),
  lPopCount: vi.fn(async () => [] as string[] | null),
  lRange: vi.fn(async () => [] as string[]),
  lLen: vi.fn(async () => 1),
  lRem: vi.fn(async () => 0),
  exists: vi.fn(async () => 1),
  expire: vi.fn(async () => true),
  del: vi.fn(async () => 1),
  rPush: vi.fn(async () => 1),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis,
  REDIS_KEYS: { SYSTEM: { PROMPT_ALLOWLIST: 'system:prompt-allowlist' } },
  REDIS_SYS_KEYS: {
    GENERATION: {
      BLOCKED_PROMPTS: 'generation:blocked-prompts',
      MODERATION_RESCREEN_QUEUE: 'generation:moderation-rescreen-queue',
    },
  },
}));

// --- extModeration mock -----------------------------------------------------
const moderatePrompt = vi.hoisted(() => vi.fn());
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt },
}));

// --- prom metric mock (capture outcome label increments) --------------------
const metricInc = vi.hoisted(() => vi.fn());
vi.mock('~/server/prom/client', () => ({
  externalModerationOutcomeCounter: { inc: metricInc },
}));

// --- consequence side-effect mocks ------------------------------------------
const userRestrictionCreate = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('~/server/db/client', () => ({
  dbRead: { promptAllowlist: { findMany: vi.fn(async () => []) } },
  dbWrite: { userRestriction: { create: userRestrictionCreate } },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
const updateUserById = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('~/server/services/user.service', () => ({ updateUserById }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));

import { logToAxiom } from '~/server/logging/client';
import {
  auditPromptServer,
  enqueuePromptRescreen,
  processPromptRescreenQueue,
} from '~/server/services/orchestrator/promptAuditing';

const QUEUE_KEY = 'generation:moderation-rescreen-queue';

function outcomes() {
  return metricInc.mock.calls.map((c) => (c[0] as { outcome: string }).outcome);
}

beforeEach(() => {
  vi.clearAllMocks();
  sysRedis.lPush.mockResolvedValue(1);
  sysRedis.lTrim.mockResolvedValue(undefined as never);
  sysRedis.lPopCount.mockResolvedValue([] as never);
  sysRedis.exists.mockResolvedValue(1 as never);
  sysRedis.lRange.mockResolvedValue([] as never);
  sysRedis.lLen.mockResolvedValue(1 as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auditPromptServer fail-soft + enqueue contract', () => {
  it('does NOT throw and enqueues with attempt:0 when moderatePrompt rejects', async () => {
    // Inline external call fails (OpenAI down). Regex audit passes (benign prompt).
    moderatePrompt.mockRejectedValueOnce(new Error('503 upstream'));

    await expect(
      auditPromptServer({
        prompt: 'a serene mountain landscape',
        negativePrompt: 'blurry',
        userId: 42,
        isGreen: false,
        isModerator: false,
        remixOfId: 7,
        imageId: 9,
      })
    ).resolves.toBeUndefined();

    // logged the inline error
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'external-moderation-error' })
    );

    // enqueue pushed the payload (fire-and-forget; let the microtask flush). FIFO:
    // the queue is appended with rPush (drained oldest-first via lPopCount).
    await new Promise((r) => setImmediate(r));
    expect(sysRedis.rPush).toHaveBeenCalledWith(QUEUE_KEY, expect.any(String));
    const pushed = JSON.parse(sysRedis.rPush.mock.calls[0][1] as string);
    expect(pushed).toMatchObject({
      prompt: 'a serene mountain landscape',
      negativePrompt: 'blurry',
      userId: 42,
      isModerator: false,
      remixOfId: 7,
      imageId: 9,
      attempt: 0,
    });

    // metric: skipped
    expect(outcomes()).toContain('skipped');
  });

  it('does NOT enqueue when moderatePrompt resolves cleanly', async () => {
    moderatePrompt.mockResolvedValueOnce({ flagged: false, categories: [] });

    await expect(
      auditPromptServer({ prompt: 'a cat', userId: 1, isGreen: false })
    ).resolves.toBeUndefined();

    await new Promise((r) => setImmediate(r));
    expect(sysRedis.rPush).not.toHaveBeenCalled();
    expect(outcomes()).not.toContain('skipped');
  });
});

describe('enqueuePromptRescreen', () => {
  it('caps the queue with lTrim and increments skipped, never throws', () => {
    expect(() =>
      enqueuePromptRescreen({ prompt: 'p', userId: 5, attempt: 0 })
    ).not.toThrow();
    expect(outcomes()).toContain('skipped');
  });

  it('caps the list via lTrim(0, MAX-1) and sets a TTL after rPush', async () => {
    enqueuePromptRescreen({ prompt: 'p', userId: 5, attempt: 0 });
    await new Promise((r) => setImmediate(r));
    expect(sysRedis.rPush).toHaveBeenCalledWith(QUEUE_KEY, expect.any(String));
    expect(sysRedis.lTrim).toHaveBeenCalledWith(QUEUE_KEY, 0, 19999);
    // TTL backstop so raw prompt text can't persist indefinitely (6h = 21600s).
    expect(sysRedis.expire).toHaveBeenCalledWith(QUEUE_KEY, 21600);
  });

  it('swallows a redis error (best-effort, never throws/rejects)', async () => {
    sysRedis.rPush.mockRejectedValueOnce(new Error('redis down'));
    expect(() => enqueuePromptRescreen({ prompt: 'p', userId: 5, attempt: 0 })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompt-rescreen-enqueue-error' })
    );
  });
});

describe('processPromptRescreenQueue', () => {
  it('returns an empty summary when the queue is empty', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([] as never);
    const r = await processPromptRescreenQueue(500);
    expect(r).toEqual({ processed: 0, flagged: 0, clean: 0, requeued: 0, dropped: 0 });
    expect(moderatePrompt).not.toHaveBeenCalled();
  });

  it('flagged item applies the consequence (addBlockedPrompt + reportProhibitedRequest)', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'bad', userId: 100, isModerator: false, attempt: 0 }),
    ] as never);
    moderatePrompt.mockResolvedValueOnce({ flagged: true, categories: ['sexual/minors'] });
    // addBlockedPrompt path: key exists, list contains one real entry → lLen=1
    sysRedis.exists.mockResolvedValue(1 as never);
    sysRedis.lRange.mockResolvedValue([] as never);
    sysRedis.lLen.mockResolvedValue(1 as never);

    const r = await processPromptRescreenQueue(500);

    expect(r.processed).toBe(1);
    expect(r.flagged).toBe(1);
    // addBlockedPrompt pushes the entry onto the per-user blocked-prompts list
    expect(sysRedis.lPush).toHaveBeenCalledWith(
      'generation:blocked-prompts:100',
      expect.any(String)
    );
    const entry = JSON.parse(
      sysRedis.lPush.mock.calls.find((c) => c[0] === 'generation:blocked-prompts:100')![1] as string
    );
    expect(entry).toMatchObject({ source: 'External-Deferred', category: 'external' });
    expect(outcomes()).toContain('rescreen_flagged');
  });

  it('flagged:false is treated as clean — matches the inline if(flagged) gate', async () => {
    // In prod (EXTERNAL_MODERATION_CATEGORIES set) moderatePrompt returns
    // flagged===categories.length>0, so flagged:false means no block. Keying off
    // `flagged` alone (not categories) mirrors the inline path exactly and avoids a
    // config-coupled over-block on the CSAM path.
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'bad', userId: 101, attempt: 0 }),
    ] as never);
    moderatePrompt.mockResolvedValueOnce({ flagged: false, categories: ['sexual/minors'] });

    const r = await processPromptRescreenQueue(500);
    expect(r.flagged).toBe(0);
    expect(r.clean).toBe(1);
    expect(
      sysRedis.lPush.mock.calls.some((c) => String(c[0]).startsWith('generation:blocked-prompts'))
    ).toBe(false);
    expect(outcomes()).toContain('rescreen_clean');
  });

  it('flagged item whose consequence write throws is NOT re-enqueued (no auto-mute over-count)', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'bad', userId: 102, attempt: 0 }),
    ] as never);
    moderatePrompt.mockResolvedValueOnce({ flagged: true, categories: ['sexual/minors'] });
    // addBlockedPrompt throws partway (e.g. transient sysRedis blip after the count push).
    sysRedis.lLen.mockRejectedValueOnce(new Error('redis blip'));

    const r = await processPromptRescreenQueue(500);

    // Counted as flagged (the screen DID flag), but the consequence is best-effort:
    // the item is NOT re-enqueued — re-running would call addBlockedPrompt again and
    // double-count toward the mute threshold.
    expect(r.flagged).toBe(1);
    expect(r.requeued).toBe(0);
    expect(sysRedis.rPush.mock.calls.some((c) => c[0] === QUEUE_KEY)).toBe(false);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompt-rescreen-consequence-error' })
    );
    expect(outcomes()).toContain('rescreen_flagged');
  });

  it('clean item does NOT apply any consequence', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'good', userId: 200, attempt: 0 }),
    ] as never);
    moderatePrompt.mockResolvedValueOnce({ flagged: false, categories: [] });

    const r = await processPromptRescreenQueue(500);

    expect(r.clean).toBe(1);
    expect(r.flagged).toBe(0);
    // no blocked-prompt write, no restriction
    expect(
      sysRedis.lPush.mock.calls.some((c) => String(c[0]).startsWith('generation:blocked-prompts'))
    ).toBe(false);
    expect(userRestrictionCreate).not.toHaveBeenCalled();
    expect(outcomes()).toContain('rescreen_clean');
  });

  it('re-screen throw re-enqueues with attempt+1 (under cap)', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'p', userId: 300, attempt: 1 }),
    ] as never);
    moderatePrompt.mockRejectedValueOnce(new Error('still 503'));

    const r = await processPromptRescreenQueue(500);

    expect(r.requeued).toBe(1);
    expect(r.dropped).toBe(0);
    expect(sysRedis.rPush).toHaveBeenCalledWith(QUEUE_KEY, expect.any(String));
    const requeued = JSON.parse(
      sysRedis.rPush.mock.calls.find((c) => c[0] === QUEUE_KEY)![1] as string
    );
    expect(requeued.attempt).toBe(2);
    expect(outcomes()).toContain('rescreen_requeued');
  });

  it('at the attempt cap the item is DROPPED (not re-enqueued) and logged', async () => {
    // attempt:4 → nextAttempt 5 === MAX_ATTEMPTS(5) → drop
    sysRedis.lPopCount.mockResolvedValueOnce([
      JSON.stringify({ prompt: 'p', userId: 400, attempt: 4 }),
    ] as never);
    moderatePrompt.mockRejectedValueOnce(new Error('persistently down'));

    const r = await processPromptRescreenQueue(500);

    expect(r.dropped).toBe(1);
    expect(r.requeued).toBe(0);
    // NOT re-enqueued
    expect(sysRedis.rPush.mock.calls.some((c) => c[0] === QUEUE_KEY)).toBe(false);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompt-rescreen-dropped' })
    );
    expect(outcomes()).toContain('rescreen_dropped');
  });

  it('a single bad (unparseable) item does not abort the batch', async () => {
    sysRedis.lPopCount.mockResolvedValueOnce([
      'not json{',
      JSON.stringify({ prompt: 'good', userId: 500, attempt: 0 }),
    ] as never);
    moderatePrompt.mockResolvedValueOnce({ flagged: false, categories: [] });

    const r = await processPromptRescreenQueue(500);

    expect(r.processed).toBe(2);
    expect(r.dropped).toBe(1); // the bad item
    expect(r.clean).toBe(1); // the good item still processed
  });

  it('never throws even if the pop itself errors', async () => {
    sysRedis.lPopCount.mockRejectedValueOnce(new Error('pop failed'));
    const r = await processPromptRescreenQueue(500);
    expect(r).toEqual({ processed: 0, flagged: 0, clean: 0, requeued: 0, dropped: 0 });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompt-rescreen-pop-error' })
    );
  });
});
