import path from 'node:path';
import type { NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
      // 🔴 Honours `select` for `type` alone, unlike every other read in this fake. The ruling-scope
      // suite turns on the service having asked for it: a version that refuses non-generation rows but
      // forgets `type: true` in its `select` reads `undefined` from the real Prisma client and either
      // refuses everything or nothing. A fake that answered with the column regardless would hide that
      // entirely — the test would pass against code that cannot work.
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: number }; select?: Record<string, unknown> }) => {
          const row = store.restrictions.find((r) => r.id === where.id);
          if (!row) return null;
          const user = store.users.get(row.userId);
          return {
            id: row.id,
            userId: row.userId,
            status: row.status,
            ...(select?.type ? { type: row.type } : {}),
            user: user ? { email: user.email, username: user.username } : null,
          };
        }
      ),
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
  PENDING_REVIEW_MUTE_NOTIFICATION,
  RULINGS_WIRED_FOR,
  USER_RESTRICTION_TYPES,
  unwiredRulingReason,
  type UserRestrictionType,
} from '~/server/services/user-restriction.service';
import {
  overturnPendingReviewMute,
  resolveUserRestriction,
} from '~/server/services/user-restriction-resolve.service';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';

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
    setHeader: () => undefined,
    on: () => undefined,
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

  it('notifies the user that generation access is restricted', async () => {
    const { userRestrictionId } = (await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
    })) as { userRestrictionId: number };

    // Pinned whole rather than by `objectContaining`: the key is the notification service's dedupe
    // handle, so a change to its shape re-notifies every already-notified user.
    expect(createNotification).toHaveBeenCalledExactlyOnceWith({
      type: 'generation-muted',
      key: `generation-muted:${USER_ID}:${userRestrictionId}`,
      category: 'System',
      userId: USER_ID,
      details: {},
    });
  });
});

/**
 * The seam a bot-account detector files through. Nothing raises a non-generation restriction yet — this
 * is the parameter that lets one, and the properties below are what keep it from cannibalising the
 * queue that already exists.
 */
describe('pending-review mute — restriction type', () => {
  beforeEach(seed);

  it('files a generation restriction when no type is given', async () => {
    await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });

    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0]).toMatchObject({ type: 'generation', status: 'Pending' });
  });

  it('files a restriction of the type it was given', async () => {
    await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0]).toMatchObject({
      userId: USER_ID,
      type: 'bot-account',
      status: 'Pending',
    });
    expect(store.restrictions[0].triggers).toEqual(triggers);
  });

  // 🔴 The pair below is the point of the whole change. Dedupe reads "this user already has an open
  // case", and scoped to the user alone it means the FIRST queue to mute someone permanently silences
  // every other queue for that account — a detector's findings would return `deduped: true` against a
  // row about something else entirely, and file nothing a moderator could ever see.
  it('does not let an open generation case swallow a bot-account mute', async () => {
    const first = await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test' });
    const second = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(second).toMatchObject({ muted: true, deduped: false });
    expect((second as { userRestrictionId: number }).userRestrictionId).not.toBe(
      (first as { userRestrictionId: number }).userRestrictionId
    );
    expect(store.restrictions.map((r) => r.type)).toEqual(['generation', 'bot-account']);
  });

  it('does not let an open bot-account case swallow a generation mute', async () => {
    const first = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });
    const second = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
    });

    expect(second).toMatchObject({ muted: true, deduped: false });
    expect((second as { userRestrictionId: number }).userRestrictionId).not.toBe(
      (first as { userRestrictionId: number }).userRestrictionId
    );
    expect(store.restrictions.map((r) => r.type)).toEqual(['bot-account', 'generation']);
  });

  it('still dedupes within a type, so a retry files nothing new', async () => {
    const first = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });
    const second = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(store.restrictions).toHaveLength(1);
    expect(second).toEqual({
      muted: true,
      userRestrictionId: (first as { userRestrictionId: number }).userRestrictionId,
      deduped: true,
    });
  });

  /**
   * 🔴 `createNotification` validates `type` against NOTHING — `z.string()` at the schema, `text` at
   * both tables, and the fan-out worker inserts it verbatim. An unregistered type is persisted and
   * increments the user's unread badge, while the bell dropdown drops it at render, leaving a phantom
   * count with no click target. And `generation-muted` reads "your generation access has been
   * restricted", which is a lie about a bot-account mute. So a type with no notification of its own
   * sends none until someone registers one.
   */
  it('sends no notification for a type that has none mapped', async () => {
    await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(PENDING_REVIEW_MUTE_NOTIFICATION['bot-account']).toBeNull();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('mutes the account and refreshes the session for a non-generation type all the same', async () => {
    const result = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(result).toMatchObject({ muted: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true });
    expect(refreshSession).toHaveBeenCalledWith(USER_ID, { caller: 'moderation' });
  });

  it('writes the mute and a typed restriction in one transaction', async () => {
    await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(dbWrite.$transaction).toHaveBeenCalledOnce();
    expect(dbWrite.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it.each(['generation', 'bot-account'] as const)(
    'never writes mutedAt for a %s restriction',
    async (type) => {
      await applyPendingReviewMute({ userId: USER_ID, triggers, updateSource: 'test', type });

      const dataArgs = dbWrite.user.update.mock.calls.map(([arg]) => arg.data);
      expect(dataArgs).toEqual([{ muted: true }]);
      expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
    }
  );

  it.each([
    ['moderator', MOD_ID, 'moderator'],
    ['banned user', BANNED_ID, 'banned'],
    ['deleted user', DELETED_ID, 'deleted'],
    ['the official brand account', constants.system.officialUserId, 'protected'],
    ['the system actor', constants.system.user.id, 'protected'],
  ])('refuses to file a bot-account restriction against a %s', async (_label, userId, skipped) => {
    const result = await applyPendingReviewMute({
      userId,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(result).toEqual({ muted: false, skipped });
    expect(store.restrictions).toHaveLength(0);
    expect(store.users.get(userId)?.muted ?? false).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('repairs an unmuted user holding an open case of the SAME type only', async () => {
    store.restrictions.push({
      id: 99,
      userId: USER_ID,
      type: 'bot-account',
      status: 'Pending',
      triggers: [],
      createdAt: new Date(),
    });

    const result = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type: 'bot-account',
    });

    expect(result).toEqual({ muted: true, userRestrictionId: 99, deduped: true });
    expect(store.users.get(USER_ID)).toMatchObject({ muted: true, mutedAt: null });
    expect(store.restrictions).toHaveLength(1);
  });
});

/**
 * 🔴 The runtime guard, and what it is actually for. No HTTP boundary supplies this parameter today:
 * neither production caller passes a `type`, and `mute-user-pending-review.ts`'s zod schema has no
 * `type` key, so no request body can reach it. The guard is there for the shape of the NEXT caller —
 * this seam exists so a detector can file into the queue, and the obvious wiring is a route
 * forwarding a JSON field — and for the callers TypeScript already cannot vouch for: an `as` cast, a
 * value read back off the free-text `UserRestriction.type` column, a JS caller.
 */
describe('pending-review mute — type is validated at runtime', () => {
  beforeEach(seed);

  it.each([
    ['a near miss', 'bot-acount'],
    ['a plausible-looking new kind', 'spam-account'],
    ['an empty string', ''],
  ])('refuses %s and mutes nobody', async (_label, type) => {
    await expect(
      applyPendingReviewMute({
        userId: USER_ID,
        triggers,
        updateSource: 'test',
        type: type as UserRestrictionType,
      })
    ).rejects.toThrow(`Unknown user restriction type "${type}"`);

    // The harm the throw prevents, spelled out: an out-of-vocabulary value used to MUTE the account,
    // file a row the queue's `z.enum(...).catch(...)` can never select, and — the notification map
    // returning `undefined` for it — tell the user nothing. A silently muted user, no reviewable case.
    expect(store.users.get(USER_ID)).toMatchObject({ muted: false, mutedAt: null });
    expect(store.restrictions).toHaveLength(0);
    expect(dbWrite.$transaction).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  // The positive control. Without it the guard above could be rejecting every type, and the suite
  // would still be green — `it.each` over the real vocabulary is what makes the refusal specific.
  it.each(USER_RESTRICTION_TYPES)('accepts %s', async (type) => {
    const result = await applyPendingReviewMute({
      userId: USER_ID,
      triggers,
      updateSource: 'test',
      type,
    });

    expect(result).toMatchObject({ muted: true });
    expect(store.restrictions).toHaveLength(1);
    expect(store.restrictions[0].type).toBe(type);
  });
});

/**
 * 🔴 Finding 1 of the adversarial audit on #4609, closed one level BELOW the routes.
 *
 * `resolveUserRestriction` is the single write path for a verdict, and everything it does is
 * generation-shaped: the `generation-restriction-upheld` / `-overturned` notification types, a
 * `moderator:generationRestriction*` update source, a generation-worded email, and — on an overturn —
 * `resetProhibitedRequestCount`, which wipes the account's real PROMPT-violation counter.
 *
 * Five callers reach it: the tRPC router, `/api/mod/restriction/resolve` (which is what BOTH moderator
 * ruling surfaces post through — the audit queue AND the retool User Lookup panel), and
 * `overturnPendingReviewMute`. Only the audit queue checked the type, so three of those five would have
 * run the whole generation-shaped sequence against a bot-account row. The check lives here now, which
 * is why these tests address the SERVICE rather than any one route.
 */
describe('resolveUserRestriction — ruling scope', () => {
  beforeEach(seed);

  const fileRestriction = (type: string, status = 'Pending') => {
    store.restrictions.push({
      id: 1,
      userId: USER_ID,
      type,
      status,
      triggers: [],
      createdAt: new Date(),
    });
    return 1;
  };

  it.each([UserRestrictionStatus.Overturned, UserRestrictionStatus.Upheld] as const)(
    'refuses to %s a restriction whose type has no verdict path',
    async (status) => {
      const id = fileRestriction('bot-account');

      await expect(
        resolveUserRestriction({ userRestrictionId: id, status, moderatorId: MOD_ID })
      ).rejects.toThrow('Rulings are not yet available for "bot-account" restrictions');

      // Nothing at all happened — checked rather than assumed, because the refusal is only worth
      // anything if it lands BEFORE the first write.
      expect(dbWrite.userRestriction.update).not.toHaveBeenCalled();
      expect(store.restrictions[0].status).toBe('Pending');
      expect(dbWrite.user.update).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(reinstateSubscription).not.toHaveBeenCalled();
      // The one with a lasting cost: this counter is the account's real prompt-violation history, and
      // an overturn on an unrelated case used to reset it to zero.
      expect(resetProhibitedRequestCount).not.toHaveBeenCalled();
    }
  );

  /**
   * The positive control for the pair above, and it is doing more work than it looks: the fixture rows
   * differ ONLY in `type`. Without it the refusal could be rejecting every ruling — which is exactly
   * what happens if the service stops selecting `type` and reads `undefined`.
   */
  it('still overturns a generation restriction, with every side effect intact', async () => {
    const id = fileRestriction('generation');

    const result = await resolveUserRestriction({
      userRestrictionId: id,
      status: UserRestrictionStatus.Overturned,
      moderatorId: MOD_ID,
    });

    expect(result).toEqual({ userId: USER_ID });
    expect(store.restrictions[0]).toMatchObject({ status: 'Overturned', resolvedBy: MOD_ID });
    expect(reinstateSubscription).toHaveBeenCalledWith({ userId: USER_ID });
    expect(resetProhibitedRequestCount).toHaveBeenCalledWith(USER_ID);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generation-restriction-overturned' })
    );
  });

  it('still upholds a generation restriction, with every side effect intact', async () => {
    const id = fileRestriction('generation');

    await resolveUserRestriction({
      userRestrictionId: id,
      status: UserRestrictionStatus.Upheld,
      moderatorId: MOD_ID,
    });

    expect(store.restrictions[0]).toMatchObject({ status: 'Upheld' });
    expect(store.users.get(USER_ID)?.mutedAt).toBeInstanceOf(Date);
    expect(cancelSubscription).toHaveBeenCalledWith({ userId: USER_ID, atPeriodEnd: true });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'generation-restriction-upheld' })
    );
  });

  // The refusal precedes the already-resolved check, so a row this path cannot rule on reports the
  // reason it cannot rather than an argument about its status.
  it('refuses an unwired type before it argues about the status', async () => {
    const id = fileRestriction('bot-account', 'Upheld');

    await expect(
      resolveUserRestriction({
        userRestrictionId: id,
        status: UserRestrictionStatus.Overturned,
        moderatorId: MOD_ID,
      })
    ).rejects.toThrow('Rulings are not yet available for "bot-account" restrictions');
  });

  /**
   * 🔴 The SEAM between the refusal and what a moderator actually reads.
   *
   * Both ruling surfaces post through `/api/mod/restriction/resolve`, whose `defineModeratorEndpoint`
   * wrapper hands a throw to `handleEndpointError`. A plain `Error` falls to that helper's catch-all
   * branch and reaches the wire as **500 "An unexpected error occurred"** — the retool panel then
   * renders "Restriction ruling: An unexpected error occurred." and the reason is destroyed. So the
   * service throwing the right words is only half the behaviour; these drive the REAL helper over the
   * REAL thrown value, because a test that asserted only the message would stay green through exactly
   * that 500.
   */
  describe('the refusal survives the REST envelope', () => {
    /**
     * The moderator app's REAL body reader, loaded across the app boundary by filesystem path. It is
     * import-free for exactly this reason — see `apps/moderator/src/lib/server/rest-error-reason.ts`
     * and the note in `moderator-restriction-vocabulary.harness.ts` about the same coupling
     * (resolving a path into `apps/moderator` needs `svelte-kit sync` to have run there).
     */
    let restErrorReason: (body: unknown, status: number) => string | null;

    beforeAll(async () => {
      const file = path.resolve(
        __dirname,
        '../../..',
        'apps/moderator/src/lib/server/rest-error-reason.ts'
      );
      ({ restErrorReason } = await import(/* @vite-ignore */ file));
      // The import resolving is not the same as it being the thing we meant to load.
      expect(typeof restErrorReason).toBe('function');
    });

    const throughRest = async (fn: () => Promise<unknown>) => {
      const res = createRes();
      let threw = false;
      try {
        await fn();
      } catch (e) {
        threw = true;
        handleEndpointError(res as unknown as NextApiResponse, e);
      }
      // Positive control: a call that did NOT throw would leave `state` at its zero value and every
      // assertion below would be about the fake rather than about the error.
      expect(threw).toBe(true);
      return res.state as { status: number; body: Record<string, unknown> & { message?: string } };
    };

    it('reaches REST as a 400 naming the type, not an opaque 500', async () => {
      const id = fileRestriction('bot-account');

      const { status, body } = await throughRest(() =>
        resolveUserRestriction({
          userRestrictionId: id,
          status: UserRestrictionStatus.Overturned,
          moderatorId: MOD_ID,
        })
      );

      expect(status).toBe(400);
      expect(body.message).toContain(
        'Rulings are not yet available for "bot-account" restrictions'
      );
      // The exact sentence the moderator used to get instead. Pinned by value: it is the observable
      // that says the reason was destroyed rather than merely reworded.
      expect(body.message).not.toContain('An unexpected error occurred');
    });

    it('reports a missing row as a 404 rather than a server fault', async () => {
      const { status, body } = await throughRest(() =>
        resolveUserRestriction({
          userRestrictionId: 4242,
          status: UserRestrictionStatus.Upheld,
          moderatorId: MOD_ID,
        })
      );

      expect(status).toBe(404);
      expect(body.message).toBe('Restriction record not found');
    });

    it('reports an already-ruled row as a 400 rather than a server fault', async () => {
      const id = fileRestriction('generation', 'Upheld');

      const { status, body } = await throughRest(() =>
        resolveUserRestriction({
          userRestrictionId: id,
          status: UserRestrictionStatus.Overturned,
          moderatorId: MOD_ID,
        })
      );

      expect(status).toBe(400);
      expect(body.message).toBe('Restriction has already been resolved');
    });

    /**
     * 🔴 The assertions above are about the WIRE. This one is about what the only in-repo consumer
     * gets out of it, and the two are NOT the same claim — which is how the gap below survived a
     * green suite for a whole round.
     *
     * `handleEndpointError`'s 4xx pass-through emits `{ message }` and no `error` key, while every
     * other refusal from `defineModeratorEndpoint` emits `{ error, message, code }`. The moderator
     * app's `readError` read `body.error` and nothing else, so all three refusals above came back
     * `null` and the operator saw `"Restriction ruling returned 400."` — the reason destroyed again,
     * one layer further out than the opaque 500 this endpoint change removed.
     *
     * So this drives the REAL emitter into the REAL reader in one process. Both halves mocked
     * separately is exactly the arrangement that cannot see a disagreement about the field name:
     * `restErrorReason` is loaded across the app boundary by filesystem path, the same mechanism (and
     * the same import-free precondition) as the vocabulary harness.
     */
    it('hands the moderator app a reason it can read, not just a status', async () => {
      const cases: [string, () => Promise<unknown>, number, string][] = [
        [
          'an unwired type',
          () =>
            resolveUserRestriction({
              userRestrictionId: fileRestriction('bot-account'),
              status: UserRestrictionStatus.Overturned,
              moderatorId: MOD_ID,
            }),
          400,
          'Rulings are not yet available for "bot-account" restrictions',
        ],
        [
          'a missing row',
          () =>
            resolveUserRestriction({
              userRestrictionId: 4242,
              status: UserRestrictionStatus.Upheld,
              moderatorId: MOD_ID,
            }),
          404,
          'Restriction record not found',
        ],
        [
          'an already-ruled row',
          () =>
            resolveUserRestriction({
              userRestrictionId: fileRestriction('generation', 'Upheld'),
              status: UserRestrictionStatus.Overturned,
              moderatorId: MOD_ID,
            }),
          400,
          'Restriction has already been resolved',
        ],
      ];

      for (const [label, call, expectedStatus, expectedReason] of cases) {
        // `fileRestriction` hardcodes id 1, so stacked rows would all answer to the same lookup and
        // every case after the first would rule on the previous case's row.
        store.restrictions.length = 0;

        const { status, body } = await throughRest(call);
        expect(status, label).toBe(expectedStatus);

        const reason = restErrorReason(body, status);
        // The discriminating assertion: reading `error` alone returns null here, and null is what
        // collapses the operator's message back to "<label> returned <status>."
        expect(reason, label).not.toBeNull();
        expect(reason, label).toContain(expectedReason);
      }

      // Positive control on the reader itself — it must be capable of returning null, or the three
      // `not.toBeNull()` assertions above would hold against a function that always answers.
      expect(restErrorReason({ nothingReadable: true }, 400)).toBeNull();
    });
  });

  /**
   * An INVARIANT GUARD, not regression coverage — it passes against pre-change code too. Recorded
   * because it is the reason the service-facing overturn was never the reachable half of this hazard,
   * and a later "simplification" that drops the predicate would make it one.
   */
  it('overturnPendingReviewMute cannot reach a non-generation row at all', async () => {
    store.users.set(USER_ID, makeUser(USER_ID, { muted: true }));
    fileRestriction('bot-account');

    const result = await overturnPendingReviewMute({ userId: USER_ID, moderatorId: MOD_ID });

    expect(result).toEqual({ unmuted: false, skipped: 'no-pending-restriction' });
    expect(store.restrictions[0].status).toBe('Pending');
  });

  describe('the wired-for list itself', () => {
    it('is a subset of the types that can be filed', () => {
      // A verdict path for a type nothing can file is dead code; the reverse — a filed type with no
      // verdict path — is the deliberate state this whole guard exists for.
      for (const type of RULINGS_WIRED_FOR) expect(USER_RESTRICTION_TYPES).toContain(type);
    });

    it('names generation and refuses everything else', () => {
      expect([...RULINGS_WIRED_FOR]).toEqual(['generation']);
      expect(unwiredRulingReason('generation')).toBeNull();
      for (const type of USER_RESTRICTION_TYPES.filter((t) => !RULINGS_WIRED_FOR.includes(t)))
        expect(unwiredRulingReason(type)).toContain(`"${type}"`);
    });
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
