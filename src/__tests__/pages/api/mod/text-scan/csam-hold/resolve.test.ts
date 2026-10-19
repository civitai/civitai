import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null, roles: [] } },
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  tracker: {
    retoolAudit: vi.fn(),
    userActivity: vi.fn(),
    post: vi.fn(),
    modelEvent: vi.fn(),
  },
  bulkSetCommentTosViolation: vi.fn(),
  bulkSetCommentV2TosViolation: vi.fn(),
  toggleBan: vi.fn(),
  clearUserProfileFields: vi.fn(),
  createStrike: vi.fn(),
  unpublishModelById: vi.fn(),
  deletePost: vi.fn(),
  closeAppealsDeletedByOwner: vi.fn(),
  refreshModelCache: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => mocks.session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mocks.tracker.retoolAudit;
    userActivity = mocks.tracker.userActivity;
    post = mocks.tracker.post;
    modelEvent = mocks.tracker.modelEvent;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => mocks.hasModeratorGrant(...a),
}));
// Hand-listed: the real services pull search-index and cache graphs that build clients at load.
vi.mock('~/server/services/comment.service', () => ({
  bulkSetCommentTosViolation: mocks.bulkSetCommentTosViolation,
}));
vi.mock('~/server/services/commentsv2.service', () => ({
  bulkSetCommentV2TosViolation: mocks.bulkSetCommentV2TosViolation,
}));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: mocks.toggleBan,
  clearUserProfileFields: mocks.clearUserProfileFields,
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: mocks.createStrike }));
vi.mock('~/server/services/model.service', () => ({
  unpublishModelById: mocks.unpublishModelById,
}));
vi.mock('~/server/services/post.service', () => ({ deletePost: mocks.deletePost }));
vi.mock('~/server/services/report.service', () => ({
  closeAppealsDeletedByOwner: mocks.closeAppealsDeletedByOwner,
}));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mocks.refreshModelCache },
}));

const hold = dbMock.dbWrite.textScanHold;
const updateMany = hold.updateMany;
const findFirst = hold.findFirst;

import handler from '~/pages/api/mod/text-scan/csam-hold/resolve';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

const pendingHold = (over: Record<string, unknown> = {}) => ({
  id: 12,
  status: 'Pending',
  entityType: 'CommentV2',
  entityId: 55,
  userId: 900,
  text: 'held text',
  meta: { chatId: 3 },
  ...over,
});

/** The label-store write, found by its SQL: the tagged template reaches the mock as (strings, ...values). */
const labelCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.filter(([strings]) =>
    (strings as readonly string[]).join('?').includes('label_store.record_label')
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasModeratorGrant.mockResolvedValue(true);
  findFirst.mockResolvedValue(pendingHold());
  updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null });
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: {}, nsfw: false });
  mocks.bulkSetCommentTosViolation.mockResolvedValue({ count: 1 });
  mocks.bulkSetCommentV2TosViolation.mockResolvedValue({ count: 1 });
  mocks.deletePost.mockResolvedValue({ id: 55, nsfwLevel: 1, deletedImageIds: [1, 2] });
  mocks.createStrike.mockResolvedValue({ id: 31 });
  mocks.toggleBan.mockResolvedValue({ id: 900, bannedAt: new Date() });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('textScan.resolveCsamHold', () => {
  describe('do nothing (dismiss)', () => {
    it('closes the hold as Dismissed and touches nothing else', async () => {
      const { status, body } = await call({ holdId: 12, decision: 'dismiss', note: 'fine' });
      expect(status).toBe(200);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 12, label: 'csam', status: 'Pending' },
        data: expect.objectContaining({
          status: 'Dismissed',
          decidedAt: expect.any(Date),
          decidedById: 7,
          decisionNote: 'fine',
        }),
      });
      expect(body).toMatchObject({ holdId: 12, status: 'Dismissed', decision: 'dismiss' });
      for (const effect of [
        mocks.bulkSetCommentV2TosViolation,
        mocks.createStrike,
        mocks.toggleBan,
      ])
        expect(effect).not.toHaveBeenCalled();
    });

    it('records a dismissal without a note as no note', async () => {
      await call({ holdId: 12, decision: 'dismiss', note: '  ' });
      expect(updateMany.mock.calls[0][0].data.decisionNote).toBeNull();
    });
  });

  describe('the four removal decisions', () => {
    it('remove: removes the content and nothing else', async () => {
      const { status, body } = await call({ holdId: 12, decision: 'remove', note: 'gone' });
      expect(status).toBe(200);
      expect(mocks.bulkSetCommentV2TosViolation).toHaveBeenCalledWith({
        ids: [55],
        actor: { id: 7, ip: undefined },
      });
      expect(mocks.createStrike).not.toHaveBeenCalled();
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'Confirmed',
        decidedById: 7,
        decisionNote: 'gone',
        meta: { chatId: 3, decision: 'remove' },
      });
      expect(body).toMatchObject({ holdId: 12, status: 'Confirmed', decision: 'remove' });
    });

    it('remove_strike: removes the content, then strikes the author', async () => {
      await call({ holdId: 12, decision: 'remove_strike' });
      expect(mocks.bulkSetCommentV2TosViolation).toHaveBeenCalled();
      expect(mocks.createStrike).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 900,
          reason: 'ManualModAction',
          issuedBy: 7,
          entityType: 'CommentV2',
          entityId: 55,
        })
      );
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data.status).toBe('Confirmed');
    });

    it('remove_ban: removes the content, then bans the author', async () => {
      await call({ holdId: 12, decision: 'remove_ban' });
      expect(mocks.bulkSetCommentV2TosViolation).toHaveBeenCalled();
      expect(mocks.toggleBan).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 900,
          reasonCode: 'SexualMinor',
          userId: 7,
          isModerator: true,
        })
      );
      expect(mocks.createStrike).not.toHaveBeenCalled();
      expect(mocks.tracker.userActivity).toHaveBeenCalledWith({
        type: 'Banned',
        targetUserId: 900,
      });
    });

    it('remove_ban_report: removes and bans, and leaves the report to the existing form', async () => {
      const { body } = await call({ holdId: 12, decision: 'remove_ban_report' });
      expect(mocks.bulkSetCommentV2TosViolation).toHaveBeenCalled();
      expect(mocks.toggleBan).toHaveBeenCalledTimes(1);
      expect(body).toMatchObject({
        status: 'Confirmed',
        decision: 'remove_ban_report',
        userId: 900,
      });
      expect(dbMock.dbWrite.report.create).not.toHaveBeenCalled();
    });

    it('does not unban an author who is already banned', async () => {
      dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: new Date() });
      const { status } = await call({ holdId: 12, decision: 'remove_ban' });
      expect(status).toBe(200);
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data.status).toBe('Confirmed');
    });
  });

  describe('removal per entity type', () => {
    it('removes a legacy model comment', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Comment' }));
      await call({ holdId: 12, decision: 'remove' });
      expect(mocks.bulkSetCommentTosViolation).toHaveBeenCalledWith({
        ids: [55],
        actor: { id: 7, ip: undefined },
      });
    });

    it('clears the profile text of a user profile hold', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'UserProfile', entityId: 900 }));
      await call({ holdId: 12, decision: 'remove' });
      expect(mocks.clearUserProfileFields).toHaveBeenCalledWith({ userId: 900 });
    });

    it('deletes a post as a moderator and tracks it', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Post' }));
      await call({ holdId: 12, decision: 'remove' });
      expect(mocks.deletePost).toHaveBeenCalledWith({ id: 55, isModerator: true });
      expect(mocks.tracker.post).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Delete', postId: 55 })
      );
    });

    it('unpublishes a model as a violation and refreshes its cache', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Model' }));
      await call({ holdId: 12, decision: 'remove' });
      expect(mocks.unpublishModelById).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 55,
          reason: 'mature-underage',
          userId: 7,
          isModerator: true,
        })
      );
      expect(mocks.tracker.modelEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Unpublish', modelId: 55 })
      );
      expect(mocks.refreshModelCache).toHaveBeenCalledWith(55);
    });

    it('refuses a removal for a type with no removal path, before doing anything', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'ChatMessage' }));
      const { status } = await call({ holdId: 12, decision: 'remove_ban' });
      expect(status).toBe(400);
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('still lets a hold of that type be dismissed', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'ChatMessage' }));
      expect((await call({ holdId: 12, decision: 'dismiss' })).status).toBe(200);
    });
  });

  describe('the decision record', () => {
    it.each([
      ['dismiss', 'not_csam'],
      ['remove', 'csam'],
      ['remove_strike', 'csam'],
      ['remove_ban', 'csam'],
      ['remove_ban_report', 'csam'],
    ])(
      '%s is recorded in the label store as %s, in the same transaction',
      async (decision, value) => {
        await call({ holdId: 12, decision });
        expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
        expect(labelCalls()).toHaveLength(1);
        const values = labelCalls()[0].slice(1);
        expect(values).toEqual(
          expect.arrayContaining([value, decision, 'TextScanHold:12', 7, 900])
        );
      }
    );

    it('records nothing when the hold was decided between the read and the write', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      expect((await call({ holdId: 12, decision: 'remove' })).status).toBe(409);
      expect(labelCalls()).toHaveLength(0);
    });

    it('creates no Report row on any path', async () => {
      for (const decision of [
        'dismiss',
        'remove',
        'remove_strike',
        'remove_ban',
        'remove_ban_report',
      ])
        await call({ holdId: 12, decision });
      expect(dbMock.dbWrite.report.create).not.toHaveBeenCalled();
    });

    it('logs the decision to Axiom', async () => {
      await call({ holdId: 12, decision: 'remove_ban' });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csam-hold-decision',
          holdId: 12,
          entityType: 'CommentV2',
          entityId: 55,
          decision: 'remove_ban',
          moderatorId: 7,
        })
      );
    });
  });

  describe('refusals', () => {
    it('refuses a moderator without the csam permission, before reading or acting', async () => {
      mocks.hasModeratorGrant.mockResolvedValue(false);
      expect((await call({ holdId: 12, decision: 'remove_ban' })).status).toBe(403);
      expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        'csam.report.file'
      );
      expect(findFirst).not.toHaveBeenCalled();
      expect(mocks.toggleBan).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', null],
      ['already dismissed', pendingHold({ status: 'Dismissed' })],
      ['already confirmed', pendingHold({ status: 'Confirmed' })],
    ])('answers 409 when the hold is %s, without acting', async (_, row) => {
      findFirst.mockResolvedValue(row);
      expect((await call({ holdId: 12, decision: 'remove_ban' })).status).toBe(409);
      expect(mocks.bulkSetCommentV2TosViolation).not.toHaveBeenCalled();
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'csam-hold-decision' })
      );
    });

    it.each([
      ['remove_strike', 'user.strike'],
      ['remove_ban', 'user.ban'],
      ['remove_ban_report', 'user.ban'],
    ])('refuses %s without the %s grant, before reading or acting', async (decision, grant) => {
      mocks.hasModeratorGrant.mockImplementation(async (_, id) => id !== grant);
      expect((await call({ holdId: 12, decision })).status).toBe(403);
      expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        grant
      );
      expect(findFirst).not.toHaveBeenCalled();
      expect(mocks.bulkSetCommentV2TosViolation).not.toHaveBeenCalled();
    });

    it('does not ask for the ban or strike grant on a removal or a dismissal', async () => {
      mocks.hasModeratorGrant.mockImplementation(async (_, id) => id === 'csam.report.file');
      expect((await call({ holdId: 12, decision: 'remove' })).status).toBe(200);
      expect((await call({ holdId: 12, decision: 'dismiss' })).status).toBe(200);
    });

    it('refuses a strike or ban when the hold has no recorded author', async () => {
      findFirst.mockResolvedValue(pendingHold({ userId: null }));
      expect((await call({ holdId: 12, decision: 'remove_strike' })).status).toBe(400);
      expect(mocks.bulkSetCommentV2TosViolation).not.toHaveBeenCalled();
    });

    it('leaves the hold pending when an action fails, so the decision can be retried', async () => {
      mocks.createStrike.mockRejectedValue(new Error('strike store down'));
      const { status } = await call({ holdId: 12, decision: 'remove_strike' });
      expect(status).toBeGreaterThanOrEqual(500);
      expect(updateMany).not.toHaveBeenCalled();
      expect(labelCalls()).toHaveLength(0);
    });

    it('does not strike or ban when the content could not be removed', async () => {
      mocks.bulkSetCommentV2TosViolation.mockRejectedValue(new Error('db down'));
      await call({ holdId: 12, decision: 'remove_ban' });
      expect(mocks.toggleBan).not.toHaveBeenCalled();
    });

    it.each([
      ['an undefined decision', { holdId: 12, decision: 'confirm' }],
      ['no hold id', { decision: 'dismiss' }],
      ['a note over the limit', { holdId: 12, decision: 'dismiss', note: 'x'.repeat(501) }],
    ])('refuses %s before reading', async (_, body) => {
      expect((await call(body)).status).toBe(400);
      expect(findFirst).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });
  });
});
