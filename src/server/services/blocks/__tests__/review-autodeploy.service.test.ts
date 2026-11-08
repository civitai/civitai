import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AgentReviewService from '~/server/services/blocks/agent-review.service';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as ModAlert from '~/server/common/mod-alert';
import type * as PublishRequestService from '~/server/services/blocks/publish-request.service';

/**
 * The automatic review flow (review-autodeploy.service): the platform build cap and its queue,
 * the submitter's daily automatic-build budget, the moderator alert, and the agent-review
 * auto-start under the platform's daily budget.
 *
 * The build-slot claim runs against an in-memory table behind a fake `$transaction` whose
 * `pg_advisory_xact_lock` really serialises transactions, so the "two claims, one slot" case
 * exercises the lock rather than asserting that a statement was issued.
 */

const m = vi.hoisted(() => ({
  autodeployOn: vi.fn(async () => true),
  agentAutostartOn: vi.fn(async () => true),
  startClaimedReviewBuild: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  startAgentReview: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  notifyModAlert: vi.fn(async (..._a: unknown[]): Promise<string> => 'delivered'),
}));

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksReviewAutodeployEnabled: () => m.autodeployOn(),
  isAppBlocksAgenticReviewAutostartEnabled: () => m.agentAutostartOn(),
}));
vi.mock('~/server/services/blocks/publish-request.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PublishRequestService>()),
  startClaimedReviewBuild: (...a: unknown[]) => m.startClaimedReviewBuild(...a),
}));
vi.mock('~/server/services/blocks/agent-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentReviewService>()),
  startAgentReview: (...a: unknown[]) => m.startAgentReview(...a),
}));
vi.mock('~/server/common/mod-alert', async (importOriginal) => ({
  ...(await importOriginal<typeof ModAlert>()),
  notifyModAlert: (...a: unknown[]) => m.notifyModAlert(...a),
}));

const {
  AUTO_REVIEW_BUILDS_PER_USER_PER_DAY,
  MAX_CONCURRENT_REVIEW_BUILDS,
  REVIEW_BUILD_SLOT_STALE_MS,
  autoStartReviewPreview,
  claimReviewBuildSlot,
  drainReviewPreviewQueue,
  maybeAutoStartAgentReview,
  notifyModsOfNewSubmission,
  onNewPendingSubmission,
  onReviewBuildSettled,
} = await import('~/server/services/blocks/review-autodeploy.service');

// ---------------------------------------------------------------------------
// In-memory publish-request table + a transaction whose advisory lock serialises.
// ---------------------------------------------------------------------------
type Row = {
  id: string;
  slug: string;
  status: string;
  deployState: string | null;
  deployDetail: string | null;
  deployUpdatedAt: Date | null;
  bundleKey: string;
  forgejoCommitSha: string | null;
};
let rows: Row[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Where = Record<string, unknown>;
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gt?: Date; not?: unknown };
      if (c.in) return c.in.includes(value);
      if (c.gt) return value instanceof Date && value.getTime() > c.gt.getTime();
      if ('not' in c) return value !== c.not;
    }
    return value === cond;
  });
}
const table = {
  // The read a statement sees is taken when it STARTS; the delay is how long it then takes.
  // That is what lets an unlocked second claim count the slots before the first claim's
  // write lands.
  count: async ({ where }: { where: Where }) => {
    const n = rows.filter((r) => matches(r, where)).length;
    await sleep(10);
    return n;
  },
  findFirst: async ({ where }: { where: Where }) => {
    const hit = rows
      .filter((r) => matches(r, where))
      .sort((a, b) => (a.deployUpdatedAt?.getTime() ?? 0) - (b.deployUpdatedAt?.getTime() ?? 0))[0];
    return hit
      ? {
          id: hit.id,
          slug: hit.slug,
          bundleKey: hit.bundleKey,
          forgejoCommitSha: hit.forgejoCommitSha,
        }
      : null;
  },
  updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
    const hit = rows.filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, data);
    return { count: hit.length };
  },
};
let lockTail: Promise<void> = Promise.resolve();
const lockCalls = { n: 0 };
function installFakeDb() {
  dbMock.dbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    let release: () => void = () => undefined;
    const tx = {
      $executeRawUnsafe: async () => 0,
      $executeRaw: async (strings: TemplateStringsArray) => {
        if (strings.join('?').includes('pg_advisory_xact_lock')) {
          lockCalls.n++;
          const prev = lockTail;
          lockTail = new Promise<void>((r) => (release = r));
          await prev;
        }
        return 0;
      },
      appBlockPublishRequest: table,
    };
    try {
      return await cb(tx);
    } finally {
      release();
    }
  });
  dbMock.dbRead.appBlockPublishRequest.count.mockImplementation(table.count);
  dbMock.dbWrite.appBlockPublishRequest.updateMany.mockImplementation(table.updateMany);
}

let seq = 0;
function row(over: Partial<Row>): Row {
  seq++;
  return {
    id: `pubreq_${seq}`,
    slug: `app-${seq}`,
    status: 'pending',
    deployState: null,
    deployDetail: null,
    // Distinct, increasing ages so queue order is the insertion order.
    deployUpdatedAt: new Date(Date.now() - 60_000 + seq * 100),
    bundleKey: 'bundles/x.zip',
    forgejoCommitSha: null,
    ...over,
  };
}
const building = () => row({ deployState: 'preview-building' });
const queued = () => row({ deployState: 'preview-queued' });
const states = () => rows.map((r) => r.deployState);

/** sysRedis MULTI whose INCR answers `count` (or throws). */
function budgetCounter(count: number | Error) {
  const chain = {
    set: vi.fn((..._a: unknown[]) => chain),
    incr: vi.fn(() => chain),
    exec: vi.fn(async () => {
      if (count instanceof Error) throw count;
      return ['OK', count];
    }),
  };
  redisMock.sysRedis.multi.mockImplementation(() => chain);
  return chain;
}

beforeEach(() => {
  rows = [];
  seq = 0;
  lockTail = Promise.resolve();
  lockCalls.n = 0;
  installFakeDb();
  m.autodeployOn.mockResolvedValue(true);
  m.agentAutostartOn.mockResolvedValue(true);
  m.startClaimedReviewBuild.mockReset();
  m.startClaimedReviewBuild.mockResolvedValue({});
  m.startAgentReview.mockReset();
  m.startAgentReview.mockResolvedValue({});
  m.notifyModAlert.mockReset();
  m.notifyModAlert.mockResolvedValue('delivered');
  budgetCounter(1);
  envMock.set({
    NEXTAUTH_URL: 'https://civitai.example',
    AGENT_REVIEW_COST_CAP_USD: '2',
    AGENT_REVIEW_AUTOSTART_DAILY_BUDGET_USD: 40,
  });
});

const startedIds = () =>
  m.startClaimedReviewBuild.mock.calls.map((c) => (c[0] as { id: string }).id);

// ---------------------------------------------------------------------------
describe('autoStartReviewPreview', () => {
  it('flag OFF: nothing is queued, the budget is not touched', async () => {
    m.autodeployOn.mockResolvedValue(false);
    const r = row({});
    rows = [r];
    const counter = budgetCounter(1);

    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'disabled'
    );
    expect(r.deployState).toBeNull();
    expect(counter.exec).not.toHaveBeenCalled();
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
  });

  it('flag ON with a free slot: queues the preview and starts its build as the system actor', async () => {
    const r = row({});
    rows = [r];

    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'queued'
    );
    expect(startedIds()).toEqual([r.id]);
    expect(m.startClaimedReviewBuild.mock.calls[0][1]).toEqual({ kind: 'system' });
    expect(r.deployState).toBe('preview-building');
    expect(JSON.parse(r.deployDetail!)).toEqual({ actor: 'system' });
  });

  it('never queues over a preview a moderator already started', async () => {
    const r = row({ deployState: 'preview-live' });
    rows = [r];
    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'not-queued'
    );
    expect(r.deployState).toBe('preview-live');
  });

  it(`the ${
    AUTO_REVIEW_BUILDS_PER_USER_PER_DAY + 1
  }th automatic build of the UTC day waits for a moderator`, async () => {
    const r = row({});
    rows = [r];
    const counter = budgetCounter(AUTO_REVIEW_BUILDS_PER_USER_PER_DAY + 1);

    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'budget-refused'
    );
    expect(r.deployState).toBeNull();
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
    // Keyed on the submitter and the UTC date.
    const day = new Date().toISOString().slice(0, 10);
    expect((counter.set.mock.calls[0] as unknown[])[0]).toBe(
      `system:blocks:review-auto-builds:9:${day}`
    );
  });

  it(`CONTROL: the ${AUTO_REVIEW_BUILDS_PER_USER_PER_DAY}th still starts`, async () => {
    const r = row({});
    rows = [r];
    budgetCounter(AUTO_REVIEW_BUILDS_PER_USER_PER_DAY);
    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'queued'
    );
  });

  it('an unreadable budget fails CLOSED: nothing queued, and no throw', async () => {
    const r = row({});
    rows = [r];
    budgetCounter(new Error('redis down'));
    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'budget-unavailable'
    );
    expect(r.deployState).toBeNull();
  });

  it('INVARIANT: a moderator start does not consult the budget and is admitted with the budget spent and every slot held', async () => {
    rows = [building(), building(), building()];
    const r = row({});
    rows.push(r);
    const counter = budgetCounter(new Error('redis down'));

    const claim = await claimReviewBuildSlot({
      kind: 'request',
      publishRequestId: r.id,
      actor: { kind: 'moderator', userId: 5 },
    });
    expect(claim.claimed?.id).toBe(r.id);
    expect(r.deployState).toBe('preview-building');
    expect(counter.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('the platform build cap', () => {
  it(`with ${MAX_CONCURRENT_REVIEW_BUILDS} builds running, a new automatic start QUEUES rather than starting`, async () => {
    rows = [building(), building(), building()];
    const r = row({});
    rows.push(r);

    expect(await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: 9 })).toBe(
      'queued'
    );
    expect(r.deployState).toBe('preview-queued');
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
  });

  it('a drain fills only the free slots, oldest first; the rest drain when a build finishes', async () => {
    const [a, b, c, d] = [queued(), queued(), queued(), queued()];
    rows = [a, b, c, d];

    expect(await drainReviewPreviewQueue()).toEqual({ started: 3, waiting: true });
    expect(startedIds()).toEqual([a.id, b.id, c.id]);
    expect(d.deployState).toBe('preview-queued');

    // One build goes live: its slot frees, and the queued one starts.
    a.deployState = 'preview-live';
    m.agentAutostartOn.mockResolvedValue(false);
    await onReviewBuildSettled({ publishRequestId: a.id, live: true });
    expect(startedIds()).toEqual([a.id, b.id, c.id, d.id]);
    expect(d.deployState).toBe('preview-building');
  });

  it('a build stuck past the stale window no longer holds its slot', async () => {
    const stuck = row({
      deployState: 'preview-building',
      deployUpdatedAt: new Date(Date.now() - REVIEW_BUILD_SLOT_STALE_MS - 60_000),
    });
    rows = [stuck, building(), building()];
    const q = queued();
    rows.push(q);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 1, waiting: false });
    expect(startedIds()).toEqual([q.id]);
  });

  it('a failed start frees its slot for the next queued preview', async () => {
    rows = [building(), building()];
    const [x, y] = [queued(), queued()];
    rows.push(x, y);
    m.startClaimedReviewBuild.mockImplementation(async (req: unknown) => {
      const r = rows.find((row) => row.id === (req as { id: string }).id)!;
      if (r.id === x.id) {
        r.deployState = 'preview-failed';
        throw new Error('source unavailable');
      }
      return {};
    });
    await drainReviewPreviewQueue();
    expect(startedIds()).toEqual([x.id, y.id]);
    expect(y.deployState).toBe('preview-building');
  });

  it('two simultaneous claims cannot both take the last slot', async () => {
    rows = [building(), building()];
    const [x, y] = [queued(), queued()];
    rows.push(x, y);

    const first = claimReviewBuildSlot({ kind: 'next-queued' });
    // The second starts while the first is still counting (count takes 10ms).
    await sleep(5);
    const second = claimReviewBuildSlot({ kind: 'next-queued' });
    const results = await Promise.all([first, second]);

    expect(results.map((r) => (r.claimed ? 'claimed' : r.reason)).sort()).toEqual([
      'claimed',
      'full',
    ]);
    expect(states().filter((s) => s === 'preview-building')).toHaveLength(
      MAX_CONCURRENT_REVIEW_BUILDS
    );
    expect(y.deployState).toBe('preview-queued');
    expect(lockCalls.n).toBe(2);
  });

  it('flag OFF: queued previews are left queued (the flag is the kill switch)', async () => {
    rows = [queued()];
    m.autodeployOn.mockResolvedValue(false);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 0, waiting: false });
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('moderator alert', () => {
  const sub = {
    publishRequestId: 'pubreq_01ABC',
    slug: 'my-app',
    version: '1.2.0',
    appName: 'My App',
    submittedByUserId: 9,
    origin: 'upload' as const,
  };

  it('posts the app name, slug, version, author and the civitai review page link', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'alice' });
    expect(await notifyModsOfNewSubmission(sub)).toBe('delivered');
    expect(m.notifyModAlert).toHaveBeenCalledTimes(1);
    expect(m.notifyModAlert).toHaveBeenCalledWith(
      'New app submission: My App',
      [
        '**My App** `my-app` v1.2.0',
        'Author: alice',
        'Submitted by bundle upload',
        'Review: https://civitai.example/apps/review/pubreq_01ABC',
      ].join('\n')
    );
  });

  it('author-written text cannot break out of the code span or add lines', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'bob' });
    await notifyModsOfNewSubmission({ ...sub, appName: 'Evil`\n@everyone', origin: 'push' });
    const [title, description] = m.notifyModAlert.mock.calls[0] as [string, string];
    expect(title).toBe('New app submission: Evil @everyone');
    expect(description.split('\n')).toHaveLength(4);
    expect(description).toContain('Submitted by git push');
  });

  it('a webhook failure (rejected, or a throw) is reported, never thrown, and the auto-start still runs', async () => {
    m.notifyModAlert.mockRejectedValue(new Error('webhook 500'));
    const r = row({ id: sub.publishRequestId });
    rows = [r];
    await expect(onNewPendingSubmission(sub)).resolves.toBeUndefined();
    expect(r.deployState).toBe('preview-building');

    m.notifyModAlert.mockResolvedValue('rejected');
    expect(await notifyModsOfNewSubmission(sub)).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
describe('agent review auto-start', () => {
  const PUBREQ = 'pubreq_live';
  function spend(costedUsd: number, runningUncosted = 0) {
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({
      _sum: { costUsd: costedUsd },
    });
    dbMock.dbWrite.appReviewAgentReport.count.mockResolvedValue(runningUncosted);
  }
  beforeEach(() => {
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue(null);
  });

  it('within the daily budget: starts one with no moderator (system start)', async () => {
    spend(30);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('started');
    expect(m.startAgentReview).toHaveBeenCalledWith({ publishRequestId: PUBREQ, modUserId: null });
  });

  it('refuses when one more review at its cap would pass the budget ($39 spent + $2 > $40)', async () => {
    spend(39);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('budget-refused');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('counts a running review with no reported cost at its cap ($30 + 5 x $2 running + $2 > $40)', async () => {
    spend(30, 5);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('budget-refused');
    // Landing exactly ON the budget fits ($30 + 4 x $2 + $2 = $40)…
    spend(30, 4);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('started');
    // …and the same spend with nothing running fits.
    spend(30, 0);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('started');
  });

  it('the budget is env-configurable', async () => {
    envMock.set({ AGENT_REVIEW_AUTOSTART_DAILY_BUDGET_USD: 100 });
    spend(90);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('started');
  });

  it('once per request: an existing report (any status) means no auto-start', async () => {
    spend(0);
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue({ id: 'arar_1' });
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('already-reviewed');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('flag OFF: no auto-start', async () => {
    spend(0);
    m.agentAutostartOn.mockResolvedValue(false);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('disabled');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('a live preview triggers it; a failed one does not', async () => {
    spend(0);
    await onReviewBuildSettled({ publishRequestId: PUBREQ, live: false });
    expect(m.startAgentReview).not.toHaveBeenCalled();
    await onReviewBuildSettled({ publishRequestId: PUBREQ, live: true });
    expect(m.startAgentReview).toHaveBeenCalledTimes(1);
  });

  it('a start failure is reported, never thrown', async () => {
    spend(0);
    m.startAgentReview.mockRejectedValue(new Error('k8s down'));
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('error');
  });
});
