import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { matches, type Where } from './prisma-where.fixture';
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
  agentBaseOn: vi.fn(async () => true),
  automationOn: vi.fn(async (): Promise<boolean> => true),
  startClaimedReviewBuild: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  startAgentReview: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  notifyModAlert: vi.fn(async (..._a: unknown[]): Promise<string> => 'delivered'),
}));

vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksReviewAutodeployEnabled: () => m.autodeployOn(),
  isAppBlocksAgenticReviewAutostartEnabled: () => m.agentAutostartOn(),
  isAppBlocksAgenticReviewEnabled: () => m.agentBaseOn(),
  isAgentReviewAutomationEnabled: () => m.automationOn(),
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
  readAutoBuildBudget,
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
/**
 * Today's agent-review auto-start reservation, in cents: a real counter shared by the MULTI's
 * INCRBY and the plain INCRBY that releases it, so concurrent starts see each other.
 */
const reservation = { cents: 0, fail: false };

function budgetCounter(count: number | Error) {
  let incrByCents: number | null = null;
  const chain = {
    set: vi.fn((..._a: unknown[]) => chain),
    incr: vi.fn(() => chain),
    incrBy: vi.fn((_k: string, cents: number) => {
      incrByCents = cents;
      return chain;
    }),
    exec: vi.fn(async () => {
      if (incrByCents !== null) {
        const cents = incrByCents;
        incrByCents = null;
        if (reservation.fail) throw new Error('redis down');
        reservation.cents += cents;
        return ['OK', reservation.cents];
      }
      if (count instanceof Error) throw count;
      return ['OK', count];
    }),
  };
  redisMock.sysRedis.multi.mockImplementation(() => chain);
  redisMock.sysRedis.incrBy.mockImplementation(async (_k: string, cents: number) => {
    reservation.cents += cents;
    return reservation.cents;
  });
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
  m.agentBaseOn.mockResolvedValue(true);
  // The shared pair, as the real helper composes it, so tests that flip one flag still work.
  m.automationOn.mockImplementation(
    async () => (await m.agentAutostartOn()) && (await m.agentBaseOn())
  );
  m.startClaimedReviewBuild.mockReset();
  m.startClaimedReviewBuild.mockResolvedValue({});
  m.startAgentReview.mockReset();
  m.startAgentReview.mockResolvedValue({});
  m.notifyModAlert.mockReset();
  m.notifyModAlert.mockResolvedValue('delivered');
  reservation.cents = 0;
  reservation.fail = false;
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

    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('disabled');
    expect(r.deployState).toBeNull();
    expect(counter.exec).not.toHaveBeenCalled();
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
  });

  it('flag ON with a free slot: queues the preview and starts its build as the system actor', async () => {
    const r = row({});
    rows = [r];

    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('queued');
    expect(startedIds()).toEqual([r.id]);
    expect(m.startClaimedReviewBuild.mock.calls[0][1]).toEqual({ kind: 'system' });
    expect(r.deployState).toBe('preview-building');
    // The claim stamps the build start, so a teardown before the build's first write still
    // leaves the row holding its slot.
    expect(JSON.parse(r.deployDetail!)).toEqual({
      actor: 'system',
      buildStartedAt: expect.any(String),
    });
  });

  it('never queues over a preview a moderator already started', async () => {
    const r = row({ deployState: 'preview-live' });
    rows = [r];
    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('not-queued');
    expect(r.deployState).toBe('preview-live');
  });

  it(`the ${
    AUTO_REVIEW_BUILDS_PER_USER_PER_DAY + 1
  }th automatic build of the UTC day waits for a moderator`, async () => {
    const r = row({});
    rows = [r];
    const counter = budgetCounter(AUTO_REVIEW_BUILDS_PER_USER_PER_DAY + 1);

    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('budget-refused');
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
    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('queued');
  });

  it('an unreadable budget fails CLOSED: nothing queued, and no throw', async () => {
    const r = row({});
    rows = [r];
    budgetCounter(new Error('redis down'));
    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('budget-unavailable');
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

    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('queued');
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

  // The flag is the kill switch for automatic builds, so nothing queued is built with it off. But
  // a queued row never expires and nothing else starts it: left queued it would be stranded.
  it('flag OFF: queued previews are not built, and are handed back to "waiting for a moderator"', async () => {
    const q = queued();
    rows = [q];
    m.autodeployOn.mockResolvedValue(false);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 0, waiting: false });
    expect(m.startClaimedReviewBuild).not.toHaveBeenCalled();
    expect(q.deployState).toBeNull();
    expect(q.deployDetail).toBeNull();
  });

  it('a superseded or decided request whose build is still running keeps its slot', async () => {
    rows = [row({ status: 'withdrawn', deployState: 'preview-building' }), building(), building()];
    const q = queued();
    rows.push(q);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 0, waiting: true });
    expect(q.deployState).toBe('preview-queued');
  });

  // Torn down mid-build: no preview (deploy_state null), its started-build detail kept.
  const tornDownMidBuild = () =>
    row({
      deployState: null,
      deployDetail: JSON.stringify({ actor: 'system', buildStartedAt: new Date().toISOString() }),
    });

  it('a preview torn down mid-build (no preview, build detail kept) keeps its slot', async () => {
    rows = [tornDownMidBuild(), building(), building()];
    const q = queued();
    rows.push(q);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 0, waiting: true });
    expect(q.deployState).toBe('preview-queued');
  });

  it('CONTROL: a torn-down row whose build settled (detail cleared) holds no slot', async () => {
    const torn = tornDownMidBuild();
    rows = [torn, building(), building()];
    const q = queued();
    rows.push(q);
    torn.deployDetail = null;
    expect(await drainReviewPreviewQueue()).toEqual({ started: 1, waiting: false });
    expect(startedIds()).toEqual([q.id]);
  });

  it('a torn-down row past the stale window holds no slot', async () => {
    const torn = tornDownMidBuild();
    torn.deployUpdatedAt = new Date(Date.now() - 46 * 60_000);
    rows = [torn, building(), building()];
    const q = queued();
    rows.push(q);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 1, waiting: false });
  });

  it('a pending row that never started a review build holds no slot', async () => {
    rows = [row({ deployState: null, deployDetail: null }), building(), building()];
    const q = queued();
    rows.push(q);
    expect(await drainReviewPreviewQueue()).toEqual({ started: 1, waiting: false });
  });

  it('CONTROL: once that build settles (row cleared), the queued preview starts', async () => {
    const settled = row({ status: 'withdrawn', deployState: 'preview-building' });
    rows = [settled, building(), building()];
    const q = queued();
    rows.push(q);
    settled.deployState = null;
    expect(await drainReviewPreviewQueue()).toEqual({ started: 1, waiting: false });
    expect(startedIds()).toEqual([q.id]);
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
        '**My App** my\\-app v1.2.0',
        'Author: alice',
        'Submitted by bundle upload',
        'Review: https://civitai.example/apps/review/pubreq_01ABC',
      ].join('\n'),
      { noMentions: true }
    );
  });

  it('a manifest name written as a markdown link renders as text, not a masked link', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'alice' });
    const appName = '[Open review](https://evil.example/phish)';
    await notifyModsOfNewSubmission({ ...sub, appName });
    const [title, description] = m.notifyModAlert.mock.calls[0] as [string, string];
    const escaped = '\\[Open review\\]\\(https\\://evil.example/phish\\)';
    expect(description.split('\n')[0]).toBe(`**${escaped}** my\\-app v1.2.0`);
    expect(title).toBe(`New app submission: ${escaped}`);
    // No unescaped `](`, so Discord has no link to render; the only URL is our review link.
    expect(description).not.toMatch(/(?<!\\)\]\(/);
    expect(description.match(/https:\/\//g)).toHaveLength(1);
  });

  it('author-written text cannot add lines, break formatting or mention anyone', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'bob' });
    await notifyModsOfNewSubmission({ ...sub, appName: 'Evil`\n@everyone', origin: 'push' });
    const [title, description] = m.notifyModAlert.mock.calls[0] as [string, string];
    expect(title).toBe('New app submission: Evil\\` @\u200beveryone');
    expect(description.split('\n')).toHaveLength(4);
    expect(description).toContain('Submitted by git push');
  });

  it('flag OFF: a new submission posts no alert and queues nothing', async () => {
    m.autodeployOn.mockResolvedValue(false);
    const r = row({ id: sub.publishRequestId });
    rows = [r];
    await expect(onNewPendingSubmission(sub)).resolves.toBeUndefined();
    expect(m.notifyModAlert).not.toHaveBeenCalled();
    expect(r.deployState).toBeNull();
  });

  it('CONTROL: flag ON, the same submission posts exactly one alert', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'alice' });
    rows = [row({ id: sub.publishRequestId })];
    await onNewPendingSubmission(sub);
    expect(m.notifyModAlert).toHaveBeenCalledTimes(1);
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

  it("🔴 listing-edit impersonation checks' spend counts against the same daily budget", async () => {
    // $37 of reviews + $2 cap = $39 fits; add $1.50 of listing-edit checks and it no longer does.
    spend(37);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('started');
    redisMock.sysRedis.get.mockImplementation((async (key: string) =>
      key.includes('listing-check-spend') ? '150' : null) as never);
    try {
      expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('budget-refused');
    } finally {
      redisMock.sysRedis.get.mockImplementation((async () => null) as never);
    }
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

  it('🔴 reads the ONE shared switch pair (isAgentReviewAutomationEnabled), not its own copy', async () => {
    spend(0);
    m.automationOn.mockResolvedValue(false);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('disabled');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('flag OFF: no auto-start', async () => {
    spend(0);
    m.agentAutostartOn.mockResolvedValue(false);
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('disabled');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('🔴 every settled review build triggers it — a failed preview too (the agent reads the bundle)', async () => {
    spend(0);
    await onReviewBuildSettled({ publishRequestId: PUBREQ, live: false });
    expect(m.startAgentReview).toHaveBeenCalledTimes(1);
    await onReviewBuildSettled({ publishRequestId: 'pubreq_other', live: true });
    expect(m.startAgentReview).toHaveBeenCalledTimes(2);
    expect(m.startAgentReview).toHaveBeenLastCalledWith({
      publishRequestId: 'pubreq_other',
      modUserId: null,
    });
  });

  it('a start failure is reported, never thrown', async () => {
    spend(0);
    m.startAgentReview.mockRejectedValue(new Error('k8s down'));
    expect(await maybeAutoStartAgentReview(PUBREQ)).toBe('error');
  });
});

// ---------------------------------------------------------------------------
describe('moderator alert throttle', () => {
  const sub = {
    publishRequestId: 'pubreq_01ABC',
    slug: 'my-app',
    version: '1.2.0',
    appName: 'My App',
    submittedByUserId: 9,
    origin: 'upload' as const,
  };
  /** One counter per Redis key, like the real INCR: the alert key and the budget key apart. */
  function countersByKey(fail?: (key: string) => boolean) {
    const counts = new Map<string, number>();
    redisMock.sysRedis.multi.mockImplementation(() => {
      let key = '';
      const chain = {
        set: vi.fn((k: string) => {
          key = k;
          return chain;
        }),
        incr: vi.fn(() => chain),
        exec: vi.fn(async () => {
          if (fail?.(key)) throw new Error('redis down');
          const n = (counts.get(key) ?? 0) + 1;
          counts.set(key, n);
          return ['OK', n];
        }),
      };
      return chain;
    });
    return counts;
  }
  beforeEach(() => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'alice' });
  });

  it('posts 10 alerts per submitter per hour, then ONE roll-up, then nothing', async () => {
    const counts = countersByKey();
    const outcomes: string[] = [];
    for (let i = 0; i < 13; i++) outcomes.push(await notifyModsOfNewSubmission(sub));

    expect(outcomes.slice(0, 11)).toEqual(Array(11).fill('delivered'));
    expect(outcomes.slice(11)).toEqual(['throttled', 'throttled']);
    const titles = m.notifyModAlert.mock.calls.map((c) => c[0]);
    expect(titles).toHaveLength(11);
    expect(titles.slice(0, 10)).toEqual(Array(10).fill('New app submission: My App'));
    expect(titles[10]).toBe('More app submissions from alice');
    const hour = new Date().toISOString().slice(0, 13);
    expect([...counts.keys()]).toEqual([`system:blocks:review-submission-alerts:9:${hour}`]);
  });

  it('counts per submitter: another account still gets its alerts', async () => {
    countersByKey();
    for (let i = 0; i < 12; i++) await notifyModsOfNewSubmission(sub);
    m.notifyModAlert.mockClear();
    expect(await notifyModsOfNewSubmission({ ...sub, submittedByUserId: 10 })).toBe('delivered');
    expect(m.notifyModAlert).toHaveBeenCalledTimes(1);
  });

  it('an unreadable throttle posts NOTHING (fails silent, never floods)', async () => {
    countersByKey((key) => key.includes('review-submission-alerts'));
    expect(await notifyModsOfNewSubmission(sub)).toBe('throttled');
    expect(m.notifyModAlert).not.toHaveBeenCalled();
  });
});

describe('automatic-build budget refund', () => {
  beforeEach(() => redisMock.sysRedis.decr.mockClear());
  it('a submit a moderator already previewed gives its budget token back', async () => {
    const r = row({ deployState: 'preview-live' });
    rows = [r];
    budgetCounter(1);
    const day = new Date().toISOString().slice(0, 10);
    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: 9,
        slug: 'some-app',
      })
    ).toBe('not-queued');
    expect(redisMock.sysRedis.decr).toHaveBeenCalledWith(
      `system:blocks:review-auto-builds:9:${day}`
    );
  });

  it('CONTROL: a queued submit keeps its token', async () => {
    rows = [row({})];
    budgetCounter(1);
    await autoStartReviewPreview({
      publishRequestId: rows[0].id,
      submittedByUserId: 9,
      slug: 'some-app',
    });
    expect(redisMock.sysRedis.decr).not.toHaveBeenCalled();
  });
});

describe('agent review budget counts runs that ended with no cost report', () => {
  type Report = { status: string; costUsd: number | null; startedAt: Date };
  function reportsTable(reports: Report[]) {
    const where = (r: Report, w: Record<string, unknown>) =>
      matches(r as unknown as Row, w as Where);
    dbMock.dbWrite.appReviewAgentReport.count.mockImplementation(
      async ({ where: w }: { where: Record<string, unknown> }) =>
        reports.filter((r) => where(r, w)).length
    );
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockImplementation(
      async ({ where: w }: { where: Record<string, unknown> }) => ({
        _sum: {
          costUsd: reports.filter((r) => where(r, w)).reduce((a, r) => a + (r.costUsd ?? 0), 0),
        },
      })
    );
  }
  beforeEach(() => {
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue(null);
  });

  it('a torn-down run with no cost counts at the per-review cap', async () => {
    // 20 runs started today and torn down before reporting: 20 x $2 = $40 already committed.
    reportsTable(
      Array.from({ length: 20 }, () => ({
        status: 'torn-down',
        costUsd: null,
        startedAt: new Date(),
      }))
    );
    expect(await maybeAutoStartAgentReview('pubreq_live')).toBe('budget-refused');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('CONTROL: the same runs with their real (low) cost reported leave room', async () => {
    reportsTable(
      Array.from({ length: 20 }, () => ({
        status: 'complete',
        costUsd: 0.5,
        startedAt: new Date(),
      }))
    );
    expect(await maybeAutoStartAgentReview('pubreq_live')).toBe('started');
  });

  it('a run from yesterday does not count', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    reportsTable(
      Array.from({ length: 30 }, () => ({ status: 'failed', costUsd: null, startedAt: yesterday }))
    );
    expect(await maybeAutoStartAgentReview('pubreq_live')).toBe('started');
  });
});

describe('agent review auto-start needs the agent-review feature on', () => {
  it('base agent-review flag OFF: no auto-start even with the autostart flag on', async () => {
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
    dbMock.dbWrite.appReviewAgentReport.count.mockResolvedValue(0);
    m.agentBaseOn.mockResolvedValue(false);
    expect(await maybeAutoStartAgentReview('pubreq_live')).toBe('disabled');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });
});

describe('agent review auto-start: concurrent go-lives share the budget', () => {
  /** Runs started today with no cost yet; each start adds one after its I/O. */
  let running = 0;
  // Flags and the start are INJECTED here, and the two calls do not import modules at the same
  // instant: under the suite's module sharing, one of two CONCURRENT first-time dynamic imports
  // of a mocked module was measured resolving the real module (its env failed to validate).
  const deps = {
    automationOn: async () => true,
    startAgentReview: (...a: unknown[]) => m.startAgentReview(...a),
  };
  beforeEach(() => {
    running = 0;
    dbMock.dbRead.appReviewAgentReport.findFirst.mockResolvedValue(null);
    // $38 already reported today: room for exactly one more $2 review under the $40 budget.
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({ _sum: { costUsd: 38 } });
    dbMock.dbWrite.appReviewAgentReport.count.mockImplementation(async () => running);
    m.startAgentReview.mockImplementation(async () => {
      await sleep(20); // stage the bundle, provision the Job...
      running++; // ...then its running report row exists
      return {};
    });
  });

  // The race the reservation closes: B decides while A is INSIDE its start — A has passed the
  // budget check, but its running row does not exist yet, so a spend read alone sees room.
  it('a second go-live while the first is mid-start (no row yet): exactly one starts', async () => {
    let releaseA: () => void = () => undefined;
    const aGate = new Promise<void>((r) => (releaseA = r));
    m.startAgentReview.mockImplementationOnce(async () => {
      await aGate; // A is mid-start until B has decided
      running++;
      return {};
    });
    const a = maybeAutoStartAgentReview('pubreq_a', deps);
    await vi.waitFor(() => expect(m.startAgentReview).toHaveBeenCalledTimes(1));
    expect(running).toBe(0);
    const b = await maybeAutoStartAgentReview('pubreq_b', deps);
    releaseA();
    expect([await a, b]).toEqual(['started', 'budget-refused']);
    expect(m.startAgentReview).toHaveBeenCalledTimes(1);
    // Every reservation is released once its start is over.
    expect(reservation.cents).toBe(0);
  });

  it('CONTROL: one at a time, the second sees the first one running and is refused', async () => {
    expect(await maybeAutoStartAgentReview('pubreq_a', deps)).toBe('started');
    expect(await maybeAutoStartAgentReview('pubreq_b', deps)).toBe('budget-refused');
  });

  it('an unreadable reservation refuses rather than starting uncounted', async () => {
    reservation.fail = true;
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
    expect(await maybeAutoStartAgentReview('pubreq_a', deps)).toBe('budget-refused');
    expect(m.startAgentReview).not.toHaveBeenCalled();
  });

  it('a start that throws still releases its reservation', async () => {
    dbMock.dbWrite.appReviewAgentReport.aggregate.mockResolvedValue({ _sum: { costUsd: 0 } });
    m.startAgentReview.mockRejectedValue(new Error('k8s down'));
    expect(await maybeAutoStartAgentReview('pubreq_a', deps)).toBe('error');
    expect(reservation.cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('test-fixture accounts: an automatic-build budget per app slug', () => {
  const FIXTURE = 2000000001;
  // A literal, not the exported constant: the expectation must not come from the code under test.
  const AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY = 20;
  const AUTO_REVIEW_BUILDS_PER_FIXTURE_PER_DAY = 200;
  const day = () => new Date().toISOString().slice(0, 10);
  const slugKey = (slug: string) =>
    `system:blocks:review-auto-builds:fixture:${FIXTURE}:${slug}:${day()}`;
  const totalKey = () => `system:blocks:review-auto-builds:fixture:${FIXTURE}:${day()}`;

  /** A real counter per Redis key, shared by the MULTI's INCR, DECR (refund) and GET (read). */
  function realCounters() {
    const counts = new Map<string, number>();
    redisMock.sysRedis.multi.mockImplementation(() => {
      // Like a real MULTI: commands queue, EXEC answers one reply per queued command, in order.
      const queued: string[] = [];
      const chain = {
        set: vi.fn(() => {
          queued.push('');
          return chain;
        }),
        incr: vi.fn((k: string) => {
          queued.push(k);
          return chain;
        }),
        exec: vi.fn(async () =>
          queued.map((k) => {
            if (!k) return 'OK';
            const n = (counts.get(k) ?? 0) + 1;
            counts.set(k, n);
            return n;
          })
        ),
      };
      return chain;
    });
    redisMock.sysRedis.decr.mockImplementation(async (k: string) => {
      const n = (counts.get(k) ?? 0) - 1;
      counts.set(k, n);
      return n;
    });
    redisMock.sysRedis.get.mockImplementation(async (k: string) =>
      counts.has(k) ? String(counts.get(k)) : null
    );
    return counts;
  }

  /** Submit `n` times as `userId` for `slug`; each submit is a fresh pending row. */
  async function submitN(n: number, userId: number, slug: string) {
    const outcomes: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = row({ slug });
      rows.push(r);
      outcomes.push(
        await autoStartReviewPreview({ publishRequestId: r.id, submittedByUserId: userId, slug })
      );
    }
    return outcomes;
  }

  beforeEach(() => {
    // A submit past the build cap still answers `queued`; these cases are about the budget.
    envMock.set({ APP_REVIEW_AUTO_BUILD_FIXTURE_USER_IDS: [FIXTURE] });
  });

  it('a fixture account is charged per slug, in its own key space, with its own limit', async () => {
    const counts = realCounters();
    const outcomes = await submitN(
      AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY + 1,
      FIXTURE,
      'ci-a'
    );
    expect(outcomes.slice(0, AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY)).toEqual(
      Array(AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY).fill('queued')
    );
    expect(outcomes[AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY]).toBe('budget-refused');
    expect([...counts.keys()]).toEqual([slugKey('ci-a'), totalKey()]);
  });

  it("a fixture account's total across slugs is capped, so test runs cannot grow without bound", async () => {
    const counts = realCounters();
    // The day's total already at its ceiling, from other slugs.
    counts.set(totalKey(), AUTO_REVIEW_BUILDS_PER_FIXTURE_PER_DAY);
    expect(await submitN(1, FIXTURE, 'ci-new')).toEqual(['budget-refused']);
    expect(await readAutoBuildBudget(FIXTURE, 'ci-new')).toEqual({
      available: true,
      scope: 'fixture-slug',
      counter: 'fixture-total',
      limit: AUTO_REVIEW_BUILDS_PER_FIXTURE_PER_DAY,
      remaining: 0,
    });
  });

  it("a refused fixture attempt charges nothing: the slug and the fixture's total are unchanged", async () => {
    const counts = realCounters();
    counts.set(slugKey('ci-a'), AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY);
    counts.set(totalKey(), 37);
    expect(await submitN(3, FIXTURE, 'ci-a')).toEqual([
      'budget-refused',
      'budget-refused',
      'budget-refused',
    ]);
    expect(counts.get(slugKey('ci-a'))).toBe(AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY);
    expect(counts.get(totalKey())).toBe(37);
  });

  it('CONTROL: one build under the total ceiling still starts', async () => {
    const counts = realCounters();
    counts.set(totalKey(), AUTO_REVIEW_BUILDS_PER_FIXTURE_PER_DAY - 1);
    expect(await submitN(1, FIXTURE, 'ci-new')).toEqual(['queued']);
  });

  it('one slug spending its allowance leaves another slug of the same fixture account untouched', async () => {
    realCounters();
    const spent = await submitN(AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY + 1, FIXTURE, 'ci-a');
    expect(spent.at(-1)).toBe('budget-refused');
    expect(await submitN(1, FIXTURE, 'ci-b')).toEqual(['queued']);
  });

  it('INVARIANT: a real account keeps ONE per-account budget across its slugs, with the fixture list set', async () => {
    const counts = realCounters();
    const outcomes = [
      ...(await submitN(AUTO_REVIEW_BUILDS_PER_USER_PER_DAY, 9, 'app-one')),
      ...(await submitN(1, 9, 'app-two')),
    ];
    expect(outcomes.slice(0, AUTO_REVIEW_BUILDS_PER_USER_PER_DAY)).toEqual(
      Array(AUTO_REVIEW_BUILDS_PER_USER_PER_DAY).fill('queued')
    );
    expect(outcomes[AUTO_REVIEW_BUILDS_PER_USER_PER_DAY]).toBe('budget-refused');
    expect([...counts.keys()]).toEqual([`system:blocks:review-auto-builds:9:${day()}`]);
  });

  it("INVARIANT: a fixture's builds never touch a real account's budget", async () => {
    const counts = realCounters();
    await submitN(3, FIXTURE, 'ci-a');
    await submitN(1, 9, 'app-one');
    expect(counts.get(`system:blocks:review-auto-builds:9:${day()}`)).toBe(1);
  });

  it("a fixture's refund goes back to the slug it was taken from", async () => {
    const counts = realCounters();
    const r = row({ slug: 'ci-a', deployState: 'preview-live' });
    rows = [r];
    expect(
      await autoStartReviewPreview({
        publishRequestId: r.id,
        submittedByUserId: FIXTURE,
        slug: 'ci-a',
      })
    ).toBe('not-queued');
    expect(counts.get(slugKey('ci-a'))).toBe(0);
    expect(counts.get(totalKey())).toBe(0);
  });

  it('readAutoBuildBudget reports what is left without spending any', async () => {
    const counts = realCounters();
    expect(await readAutoBuildBudget(FIXTURE, 'ci-a')).toEqual({
      available: true,
      scope: 'fixture-slug',
      counter: 'fixture-slug',
      limit: AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY,
      remaining: AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY,
    });
    await submitN(3, FIXTURE, 'ci-a');
    expect(await readAutoBuildBudget(FIXTURE, 'ci-a')).toMatchObject({
      remaining: AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY - 3,
    });
    // At the limit it reads 0; the refused takes past it were given back, so it never goes negative.
    await submitN(AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY, FIXTURE, 'ci-a');
    expect(await readAutoBuildBudget(FIXTURE, 'ci-a')).toMatchObject({ remaining: 0 });
    // The reads themselves took nothing.
    expect(counts.get(slugKey('ci-a'))).toBe(AUTO_REVIEW_BUILDS_PER_FIXTURE_SLUG_PER_DAY);
    expect(await readAutoBuildBudget(9, 'app-one')).toEqual({
      available: true,
      scope: 'account',
      counter: 'account',
      limit: AUTO_REVIEW_BUILDS_PER_USER_PER_DAY,
      remaining: AUTO_REVIEW_BUILDS_PER_USER_PER_DAY,
    });
  });

  it('readAutoBuildBudget on an unreadable counter says so, as the take would refuse', async () => {
    redisMock.sysRedis.get.mockRejectedValue(new Error('redis down'));
    expect(await readAutoBuildBudget(FIXTURE, 'ci-a')).toEqual({
      available: false,
      scope: 'fixture-slug',
    });
  });
});
