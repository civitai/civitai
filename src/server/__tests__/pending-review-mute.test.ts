import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as PromClient from '~/server/prom/client';

type UserRow = { id: number; isModerator: boolean; muted: boolean; mutedAt: Date | null };
type RestrictionRow = {
  id: number;
  userId: number;
  type: string;
  status: string;
  triggers: unknown;
};

const {
  store,
  dbRead,
  dbWrite,
  cancelSubscription,
  cancelSubscriptionPlan,
  lastQuery,
  trackModActivity,
  trackUserActivity,
  userUpdateCounterInc,
} = vi.hoisted(() => {
  const store = {
    users: new Map<number, UserRow>(),
    restrictions: [] as RestrictionRow[],
    jobDate: new Date(0),
  };
  const lastQuery = { sql: '' };

  const dbRead = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
        const user = store.users.get(where.id);
        return user ? { ...user } : null;
      }),
    },
  };

  const dbWrite = {
    user: {
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
      create: vi.fn(async ({ data }: { data: Omit<RestrictionRow, 'id' | 'status'> }) => {
        const row: RestrictionRow = {
          id: store.restrictions.length + 1,
          status: 'Pending',
          ...data,
        };
        store.restrictions.push(row);
        return { id: row.id };
      }),
    },
    keyValue: {
      findUnique: vi.fn(async () => ({ value: store.jobDate.getTime() })),
      upsert: vi.fn(async () => undefined),
    },
    // confirm-mutes' only query. Mirrors `WHERE "muted" AND "mutedAt" > $lastRan`;
    // the shape assertion below is what keeps this in step with the real SQL.
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, lastRan: Date) => {
      lastQuery.sql = strings.join('?');
      return [...store.users.values()]
        .filter((u) => u.muted && u.mutedAt && u.mutedAt > lastRan)
        .map((u) => ({ id: u.id }));
    }),
  };

  return {
    store,
    dbRead,
    dbWrite,
    cancelSubscription: vi.fn(async () => undefined),
    cancelSubscriptionPlan: vi.fn(async () => undefined),
    lastQuery,
    trackModActivity: vi.fn(async () => undefined),
    trackUserActivity: vi.fn(async () => undefined),
    userUpdateCounterInc: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead, dbWrite, dbKV: dbWrite }));
vi.mock('~/server/services/stripe.service', () => ({ cancelSubscription }));
vi.mock('~/server/services/paddle.service', () => ({ cancelSubscriptionPlan }));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity,
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  userUpdateCounter: { inc: userUpdateCounterInc },
}));
// endpoint-helpers spreads `env.TRPC_ORIGINS` at module load, so an unmocked
// import pulls the whole env + axiom chain into a unit test.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    userActivity = trackUserActivity;
  },
}));

import muteUserPendingReviewHandler from '~/pages/api/mod/mute-user-pending-review';
import { confirmMutes } from '~/server/jobs/confirm-mutes';
import { setUserMuted } from '~/server/services/user.service';
import {
  applyPendingReviewMute,
  buildManualMuteTriggers,
} from '~/server/services/user-restriction.service';

const USER_ID = 101;
const MOD_ID = 102;

function seed() {
  store.users.clear();
  store.restrictions.length = 0;
  store.jobDate = new Date(Date.now() - 60 * 60 * 1000);
  store.users.set(USER_ID, { id: USER_ID, isModerator: false, muted: false, mutedAt: null });
  store.users.set(MOD_ID, { id: MOD_ID, isModerator: true, muted: false, mutedAt: null });
}

async function runConfirmMutes() {
  const { result } = confirmMutes.run({});
  await result;
}

const triggers = buildManualMuteTriggers({ reason: 'csam-block strike threshold', source: 'test' });

describe('pending-review mute', () => {
  beforeEach(() => {
    seed();
    vi.clearAllMocks();
  });

  it('mutes without writing mutedAt', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    const [{ data }] = dbWrite.user.update.mock.calls.map(([arg]) => arg);
    expect(data).toEqual({ muted: true });
    expect(data).not.toHaveProperty('mutedAt');
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

  it('is not picked up by confirm-mutes, so no subscription is cancelled', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    await runConfirmMutes();

    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(cancelSubscriptionPlan).not.toHaveBeenCalled();
  });

  it('skips moderators', async () => {
    const result = await applyPendingReviewMute({ userId: MOD_ID, triggers, updateSource: 'test' });

    expect(result).toEqual({ muted: false, skipped: 'moderator' });
    expect(store.restrictions).toHaveLength(0);
    expect(store.users.get(MOD_ID)).toMatchObject({ muted: false, mutedAt: null });
  });
});

describe('POST /api/mod/mute-user-pending-review', () => {
  const REASON = 'csam-block strike threshold';

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
      state,
    };
    return res;
  }

  async function post(body: unknown) {
    const res = createRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (muteUserPendingReviewHandler as any)(
      { method: 'POST', query: {}, body, headers: {} },
      res
    );
    return res.state;
  }

  beforeEach(() => {
    seed();
    vi.clearAllMocks();
  });

  it('mutes pending review and leaves mutedAt unset', async () => {
    const { status, body } = await post({ userId: USER_ID, reason: REASON });

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: USER_ID, muted: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
  });

  it('records the reason on the restriction the moderator reviews', async () => {
    await post({ userId: USER_ID, reason: REASON, prompts: ['bad prompt'] });

    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0].triggers).toEqual([
      expect.objectContaining({
        prompt: 'bad prompt',
        matchedWord: REASON,
        source: 'orchestrator',
      }),
    ]);
  });

  it('attributes the mute to the system actor in ModActivity', async () => {
    await post({ userId: USER_ID, reason: REASON });

    expect(trackModActivity).toHaveBeenCalledWith(-1, {
      entityType: 'user',
      entityId: USER_ID,
      activity: 'mutePendingReview',
    });
    expect(trackUserActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Muted', targetUserId: USER_ID })
    );
  });

  it('tags the user write with a fixed, caller-independent updateSource', async () => {
    await post({ userId: USER_ID, reason: REASON, source: 'anything-the-caller-likes' });

    expect(userUpdateCounterInc).toHaveBeenCalledWith({
      location: 'user.service:updateUserById:webhook:mutePendingReview',
    });
  });

  it('rejects a payload with no reason and mutes nobody', async () => {
    const { status } = await post({ userId: USER_ID });

    expect(status).toBe(400);
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false });
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

describe('confirmed mute', () => {
  beforeEach(() => {
    seed();
    vi.clearAllMocks();
  });

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

  // The two jobs above read through a hand-written stand-in for confirm-mutes'
  // raw SQL. Pin the shape so the stand-in cannot silently diverge from it.
  it('selects on muted AND a mutedAt newer than the last run', async () => {
    await runConfirmMutes();

    expect(lastQuery.sql.replace(/\s+/g, ' ')).toContain('WHERE "muted" AND "mutedAt" > ?');
  });
});
