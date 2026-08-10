import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as PromClient from '~/server/prom/client';
import type * as EmailTemplates from '~/server/email/templates';
import type * as PromptAuditing from '~/server/services/orchestrator/promptAuditing';

type UserRow = {
  id: number;
  isModerator: boolean;
  muted: boolean;
  mutedAt: Date | null;
  bannedAt: Date | null;
  deletedAt: Date | null;
  email: string | null;
  username: string;
};
type RestrictionRow = {
  id: number;
  userId: number;
  type: string;
  status: string;
  triggers: unknown;
  createdAt: Date;
  resolvedBy?: number;
  resolvedMessage?: string;
};

const {
  store,
  dbWrite,
  cancelSubscription,
  reinstateSubscription,
  cancelSubscriptionPlan,
  resetProhibitedRequestCount,
  lastQuery,
  trackModActivity,
  trackUserActivity,
  userUpdateCounterInc,
  refreshSession,
  createNotification,
} = vi.hoisted(() => {
  const store = {
    users: new Map<number, UserRow>(),
    restrictions: [] as RestrictionRow[],
    jobDate: new Date(0),
  };
  const lastQuery = { sql: '' };

  const findRestriction = (predicate: (r: RestrictionRow) => boolean) =>
    [...store.restrictions].sort((a, b) => +b.createdAt - +a.createdAt).find(predicate) ?? null;

  const dbWrite = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
        const user = store.users.get(where.id);
        return user ? { ...user } : null;
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(
        async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
          const user = store.users.get(where.id);
          if (!user) throw new Error(`no user ${where.id}`);
          if ('muted' in data) user.muted = data.muted as boolean;
          if ('mutedAt' in data) user.mutedAt = (data.mutedAt as Date | null) ?? null;
          return { ...user };
        }
      ),
    },
    userRestriction: {
      create: vi.fn(
        async ({ data }: { data: Omit<RestrictionRow, 'id' | 'status' | 'createdAt'> }) => {
          const row: RestrictionRow = {
            id: store.restrictions.length + 1,
            status: 'Pending',
            createdAt: new Date(),
            ...data,
          };
          store.restrictions.push(row);
          return { id: row.id };
        }
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { userId: number; type: string; status: string } }) => {
          const row = findRestriction(
            (r) => r.userId === where.userId && r.type === where.type && r.status === where.status
          );
          return row ? { id: row.id } : null;
        }
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
        const row = store.restrictions.find((r) => r.id === where.id);
        if (!row) return null;
        const user = store.users.get(row.userId);
        return {
          id: row.id,
          userId: row.userId,
          status: row.status,
          user: user ? { email: user.email, username: user.username } : null,
        };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
          const row = store.restrictions.find((r) => r.id === where.id);
          if (!row) throw new Error(`no restriction ${where.id}`);
          Object.assign(row, data);
          return { ...row };
        }
      ),
    },
    keyValue: {
      findUnique: vi.fn(async () => ({ value: store.jobDate.getTime() })),
      upsert: vi.fn(async () => undefined),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    // confirm-mutes' only query. Mirrors `WHERE "muted" AND "mutedAt" > $lastRan`;
    // the equality assertion below is what keeps this in step with the real SQL.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, lastRan: Date) => {
      lastQuery.sql = strings.join('?');
      return [...store.users.values()]
        .filter((u) => u.muted && u.mutedAt && u.mutedAt > lastRan)
        .map((u) => ({ id: u.id }));
    }),
  };

  return {
    store,
    dbWrite,
    cancelSubscription: vi.fn(async () => undefined),
    reinstateSubscription: vi.fn(async () => undefined),
    cancelSubscriptionPlan: vi.fn(async () => undefined),
    resetProhibitedRequestCount: vi.fn(async () => undefined),
    lastQuery,
    trackModActivity: vi.fn(async () => undefined),
    trackUserActivity: vi.fn(async () => undefined),
    userUpdateCounterInc: vi.fn(),
    refreshSession: vi.fn(async () => undefined),
    createNotification: vi.fn(async () => undefined),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: dbWrite, dbWrite, dbKV: dbWrite }));
vi.mock('~/server/services/stripe.service', () => ({ cancelSubscription, reinstateSubscription }));
vi.mock('~/server/services/paddle.service', () => ({ cancelSubscriptionPlan }));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession,
  invalidateSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  userUpdateCounter: { inc: userUpdateCounterInc },
}));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailTemplates>()),
  moderationActionEmail: { send: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/orchestrator/promptAuditing', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptAuditing>()),
  resetProhibitedRequestCount,
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    userActivity = trackUserActivity;
  },
}));

import muteHandler from '~/pages/api/mod/mute-user-pending-review';
import overturnHandler from '~/pages/api/mod/overturn-user-mute';
import { confirmMutes } from '~/server/jobs/confirm-mutes';
import { constants } from '~/server/common/constants';
import { env } from '~/env/server';
import { setUserMuted } from '~/server/services/user.service';
import {
  applyPendingReviewMute,
  buildManualMuteTriggers,
} from '~/server/services/user-restriction.service';
import { overturnPendingReviewMute } from '~/server/services/user-restriction-resolve.service';

const USER_ID = 101;
const MOD_ID = 102;
const BANNED_ID = 103;
const DELETED_ID = 104;
const REASON = 'csam-block strike threshold';

function makeUser(id: number, over: Partial<UserRow> = {}): UserRow {
  return {
    id,
    isModerator: false,
    muted: false,
    mutedAt: null,
    bannedAt: null,
    deletedAt: null,
    email: `u${id}@example.com`,
    username: `user${id}`,
    ...over,
  };
}

function seed() {
  store.users.clear();
  store.restrictions.length = 0;
  store.jobDate = new Date(Date.now() - 60 * 60 * 1000);
  store.users.set(USER_ID, makeUser(USER_ID));
  store.users.set(MOD_ID, makeUser(MOD_ID, { isModerator: true }));
  store.users.set(BANNED_ID, makeUser(BANNED_ID, { bannedAt: new Date() }));
  store.users.set(DELETED_ID, makeUser(DELETED_ID, { deletedAt: new Date() }));
  store.users.set(constants.system.officialUserId, makeUser(constants.system.officialUserId));
  vi.clearAllMocks();
}

async function runConfirmMutes() {
  const { result } = confirmMutes.run({});
  await result;
}

function createRes() {
  const state: { status: number; body: unknown } = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
    setHeader() {},
    on() {},
    state,
  };
  return res;
}

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

// `token: null` means OMIT it. A `token?: string` default would silently send the
// valid token for an explicit `undefined`, making the no-token test vacuous.
async function call(
  handler: unknown,
  opts: { method?: string; token?: string | null; body?: unknown } = {}
) {
  const { method = 'POST', body = {} } = opts;
  const token = 'token' in opts ? opts.token : env.WEBHOOK_TOKEN;
  const res = createRes();
  const query: Record<string, unknown> = {};
  if (token !== null) query.token = token;
  await (handler as Handler)(
    { method, query, body, headers: {}, url: '/api/mod/test', socket: {} },
    res
  );
  return res.state;
}

const triggers = buildManualMuteTriggers({ reason: REASON, source: 'test' });

describe('pending-review mute', () => {
  beforeEach(seed);

  it('mutes without writing mutedAt', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    const dataArgs = dbWrite.user.update.mock.calls.map(([arg]) => arg.data);
    expect(dataArgs).toEqual([{ muted: true }]);
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
  });

  it('files a Pending generation restriction so the review queue sees it', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0]).toMatchObject({
      userId: USER_ID,
      type: 'generation',
      status: 'Pending',
    });
    expect(store.restrictions[0].triggers).toEqual(triggers);
  });

  it('writes the mute and the restriction in one transaction', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    expect(dbWrite.$transaction).toHaveBeenCalledOnce();
    expect(dbWrite.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('is not picked up by confirm-mutes, so no subscription is cancelled', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    await runConfirmMutes();

    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(cancelSubscriptionPlan).not.toHaveBeenCalled();
  });

  it('is idempotent — a retry reuses the open restriction instead of filing another', async () => {
    const first = await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });
    const second = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
    });

    expect(store.restrictions).toHaveLength(1);
    expect(second).toEqual({
      muted: true,
      userRestrictionId: (first as { userRestrictionId: number }).userRestrictionId,
      deduped: true,
    });
  });

  it('repairs a Pending restriction left on an unmuted user', async () => {
    store.restrictions.push({
      id: 99,
      userId: USER_ID,
      type: 'generation',
      status: 'Pending',
      triggers: [],
      createdAt: new Date(),
    });

    const result = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
    });

    expect(result).toEqual({ muted: true, userRestrictionId: 99, deduped: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
    expect(store.restrictions).toHaveLength(1);
  });

  it.each([
    ['moderator', MOD_ID, 'moderator'],
    ['banned user', BANNED_ID, 'banned'],
    ['deleted user', DELETED_ID, 'deleted'],
    ['the official brand account', constants.system.officialUserId, 'protected'],
    ['the system actor', constants.system.user.id, 'protected'],
  ])('refuses to mute a %s', async (_label, userId, skipped) => {
    const result = await applyPendingReviewMute({ userId, triggers, updateSource: 'test' });

    expect(result).toEqual({ muted: false, skipped });
    expect(store.restrictions).toHaveLength(0);
    expect(store.users.get(userId)?.muted ?? false).toBe(false);
  });

  it('still reports success when the session refresh fails', async () => {
    refreshSession.mockRejectedValueOnce(new Error('redis down'));

    const result = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
    });

    expect(result).toMatchObject({ muted: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true });
  });
});

describe('POST /api/mod/mute-user-pending-review', () => {
  beforeEach(seed);

  it.each([
    ['no token', null],
    ['a wrong token', 'not-the-webhook-token'],
  ])('rejects a request with %s and mutes nobody', async (_label, token) => {
    const { status } = await call(muteHandler, {
      token,
      body: { userId: USER_ID, reason: REASON },
    });

    expect(status).toBe(401);
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false });
    expect(store.restrictions).toHaveLength(0);
  });

  it('rejects a GET even with a valid token, so the token cannot ride in a URL', async () => {
    const { status } = await call(muteHandler, {
      method: 'GET',
      body: { userId: USER_ID, reason: REASON },
    });

    expect(status).toBe(405);
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false });
  });

  it('mutes pending review and leaves mutedAt unset', async () => {
    const { status, body } = await call(muteHandler, { body: { userId: USER_ID, reason: REASON } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: USER_ID, muted: true, deduped: false });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
  });

  it('records the reason on the restriction the moderator reviews', async () => {
    await call(muteHandler, {
      body: { userId: USER_ID, reason: REASON, prompts: ['bad prompt'] },
    });

    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0].triggers).toEqual([
      expect.objectContaining({
        prompt: 'bad prompt',
        matchedWord: REASON,
        source: 'orchestrator',
      }),
    ]);
  });

  it('attributes the mute to the system actor', async () => {
    await call(muteHandler, { body: { userId: USER_ID, reason: REASON } });

    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: USER_ID,
      activity: 'mutePendingReview',
    });
    expect(trackUserActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Muted', targetUserId: USER_ID })
    );
  });

  it('audits the mute even when the session refresh fails', async () => {
    refreshSession.mockRejectedValueOnce(new Error('redis down'));

    const { status } = await call(muteHandler, { body: { userId: USER_ID, reason: REASON } });

    expect(status).toBe(200);
    expect(trackModActivity).toHaveBeenCalledOnce();
    expect(trackUserActivity).toHaveBeenCalledOnce();
  });

  it('tags the user write with a fixed, caller-independent updateSource', async () => {
    await call(muteHandler, {
      body: { userId: USER_ID, reason: REASON, source: 'anything-the-caller-likes' },
    });

    expect(userUpdateCounterInc).toHaveBeenCalledWith({
      location: 'user-restriction.service:webhook:mutePendingReview',
    });
  });

  it('rejects a payload with no reason and mutes nobody', async () => {
    const { status } = await call(muteHandler, { body: { userId: USER_ID } });

    expect(status).toBe(400);
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false });
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

describe('POST /api/mod/overturn-user-mute', () => {
  beforeEach(seed);

  it.each([
    ['no token', null],
    ['a wrong token', 'not-the-webhook-token'],
  ])('rejects a request with %s', async (_label, token) => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    const { status } = await call(overturnHandler, {
      token,
      body: { userId: USER_ID, reason: 'mistake' },
    });

    expect(status).toBe(401);
    expect(store.restrictions[0].status).toBe('Pending');
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true });
  });

  it('rejects a GET even with a valid token', async () => {
    const { status } = await call(overturnHandler, {
      method: 'GET',
      body: { userId: USER_ID, reason: 'mistake' },
    });

    expect(status).toBe(405);
  });

  it('unmutes and overturns the open restriction so the queue is cleared', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    const { status, body } = await call(overturnHandler, {
      body: { userId: USER_ID, reason: 'mistake' },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: USER_ID, unmuted: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false });
    expect(store.restrictions[0]).toMatchObject({ status: 'Overturned', resolvedBy: -1 });
  });

  it('reinstates the subscription and resets the violation count', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    await call(overturnHandler, { body: { userId: USER_ID, reason: 'mistake' } });

    expect(reinstateSubscription).toHaveBeenCalledWith({ userId: USER_ID });
    expect(resetProhibitedRequestCount).toHaveBeenCalledWith(USER_ID);
  });

  it('audits the overturn', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    await call(overturnHandler, { body: { userId: USER_ID, reason: 'mistake' } });

    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: USER_ID,
      activity: 'overturnPendingReviewMute',
    });
    expect(trackUserActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Unmuted', targetUserId: USER_ID })
    );
  });

  it('audits the overturn even when the notification fails', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });
    createNotification.mockRejectedValueOnce(new Error('notification service down'));

    const { status, body } = await call(overturnHandler, {
      body: { userId: USER_ID, reason: 'mistake' },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: USER_ID, unmuted: true });
    expect(trackModActivity).toHaveBeenCalledOnce();
    expect(trackUserActivity).toHaveBeenCalledOnce();
  });

  it.each([
    ['the system actor', constants.system.user.id, 'protected'],
    ['the official brand account', constants.system.officialUserId, 'protected'],
    ['a moderator', MOD_ID, 'moderator'],
  ])('refuses to overturn %s', async (_label, userId, skipped) => {
    store.users.set(userId, makeUser(userId, { isModerator: userId === MOD_ID, muted: true }));
    store.restrictions.push({
      id: 1,
      userId,
      type: 'generation',
      status: 'Pending',
      triggers: [],
      createdAt: new Date(),
    });

    const result = await overturnPendingReviewMute({ userId, moderatorId: -1 });

    expect(result).toEqual({ unmuted: false, skipped });
    expect(store.restrictions[0].status).toBe('Pending');
    expect(store.users.get(userId)).toMatchObject({ muted: true });
  });

  it('refuses to overturn a mute a moderator made by hand, which mutedAt marks', async () => {
    await setUserMuted({ userId: USER_ID, muted: true });
    store.restrictions.push({
      id: 1,
      userId: USER_ID,
      type: 'generation',
      status: 'Pending',
      triggers: [],
      createdAt: new Date(),
    });

    const result = await overturnPendingReviewMute({ userId: USER_ID, moderatorId: -1 });

    expect(result).toEqual({ unmuted: false, skipped: 'manually-muted' });
    expect(store.restrictions[0].status).toBe('Pending');
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true });
    expect(reinstateSubscription).not.toHaveBeenCalled();
  });

  it('is a no-op when there is nothing open to overturn', async () => {
    const result = await overturnPendingReviewMute({ userId: USER_ID, moderatorId: -1 });

    expect(result).toEqual({ unmuted: false, skipped: 'no-pending-restriction' });
    expect(reinstateSubscription).not.toHaveBeenCalled();
  });
});

describe('confirmed mute', () => {
  beforeEach(seed);

  it('writes mutedAt', async () => {
    await setUserMuted({ userId: USER_ID, muted: true });

    expect(store.users.get(USER_ID)?.mutedAt).toBeInstanceOf(Date);
  });

  it('is picked up by confirm-mutes, which cancels the subscription', async () => {
    await setUserMuted({ userId: USER_ID, muted: true });

    await runConfirmMutes();

    expect(cancelSubscriptionPlan).toHaveBeenCalledWith({ userId: USER_ID });
    expect(cancelSubscription).toHaveBeenCalledWith({ userId: USER_ID, atPeriodEnd: true });
  });

  // The confirm-mutes tests above read through a hand-written stand-in for the
  // job's raw SQL. Pin the predicate EXACTLY: `toContain` would still pass if the
  // job were widened to `OR "mutedAt" IS NULL`, which is the regression that
  // would start cancelling pending-review-muted users' subscriptions.
  it('selects on muted AND a mutedAt newer than the last run, and nothing else', async () => {
    await runConfirmMutes();

    const sql = lastQuery.sql.replace(/\s+/g, ' ').trim();
    expect(sql).toBe('SELECT id FROM "User" WHERE "muted" AND "mutedAt" > ?');
  });
});
