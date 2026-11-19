import type * as ModerationModule from '~/server/services/commentv3/moderation.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { recordTx, useTxClients } from '~/__tests__/tx-client';
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
    chatAudit: vi.fn(),
    article: vi.fn(),
  },
  deleteChatMessage: vi.fn(),
  unpublishPostAsModerator: vi.fn(),
  bulkSetCommentV3TosViolation: vi.fn(),
  toggleBan: vi.fn(),
  clearUserProfileFields: vi.fn(),
  createStrike: vi.fn(),
  unpublishModelById: vi.fn(),
  unpublishArticleById: vi.fn(),
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
    chatAudit = mocks.tracker.chatAudit;
    article = mocks.tracker.article;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => mocks.hasModeratorGrant(...a),
}));
// Hand-listed: the real services pull search-index and cache graphs that build clients at load.
vi.mock('~/server/services/commentv3/moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationModule>()),
  bulkSetCommentV3TosViolation: mocks.bulkSetCommentV3TosViolation,
}));
vi.mock('~/server/services/user.service', () => ({
  toggleBan: mocks.toggleBan,
  clearUserProfileFields: mocks.clearUserProfileFields,
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: mocks.createStrike }));
vi.mock('~/server/services/model.service', () => ({
  unpublishModelById: mocks.unpublishModelById,
}));
vi.mock('~/server/services/post.service', () => ({
  unpublishPostAsModerator: mocks.unpublishPostAsModerator,
}));
vi.mock('~/server/services/article.service', () => ({
  unpublishArticleById: mocks.unpublishArticleById,
}));
vi.mock('~/server/services/chat.service', () => ({ deleteChatMessage: mocks.deleteChatMessage }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mocks.refreshModelCache },
}));

const hold = dbMock.dbWrite.textScanHold;
const updateMany = hold.updateMany;
const findFirst = hold.findFirst;

import handler from '~/pages/api/mod/text-scan/csam-hold/resolve';
import markReportedHandler from '~/pages/api/mod/text-scan/csam-hold/mark-reported';
import referHandler from '~/pages/api/mod/text-scan/csam-hold/refer';
import setReportChoiceHandler from '~/pages/api/mod/text-scan/csam-hold/set-report-choice';

function call(body: Record<string, unknown>, endpoint: typeof handler = handler) {
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
  return endpoint(req, res).then(() => ({ status: statusCode, body: payload }));
}

/** Filing a report needs a reportable category; every other confirm can say none. */
const choiceFor = (decision: string) => (decision === 'remove_ban_report' ? 'imagery' : 'none');

const pendingHold = (over: Record<string, unknown> = {}) => ({
  id: 12,
  status: 'Pending',
  entityType: 'CommentV3',
  entityId: 55,
  userId: 900,
  text: 'held text',
  textHash: 'h-1',
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
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: readonly string[]) =>
    strings.join('?').includes('decisionClaim') ? [{ at: '2026-10-20T10:00:00Z' }] : []
  );
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ bannedAt: null });
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ meta: {}, nsfw: false });
  dbMock.dbWrite.article.findUnique.mockResolvedValue({ status: 'Published', metadata: {} });
  mocks.bulkSetCommentV3TosViolation.mockResolvedValue({ count: 1 });
  mocks.deleteChatMessage.mockResolvedValue({ messageId: 55, chatId: 3 });
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
  it('refuses a decision on text that changed since the moderator opened the hold', async () => {
    const { status, body } = await call({
      holdId: 12,
      textHash: 'h-old',
      decision: 'remove',
      reportChoice: 'none',
    });
    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain('Reload');
    expect(mocks.bulkSetCommentV3TosViolation).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a dismissal with a report choice, and an unknown choice, before reading', async () => {
    expect(
      (await call({ holdId: 12, textHash: 'h-1', decision: 'dismiss', reportChoice: 'none' }))
        .status
    ).toBe(400);
    expect(
      (await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'bogus' }))
        .status
    ).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('decides a confirm from an older moderator app without a choice, and counts it', async () => {
    const res = await call({ holdId: 12, textHash: 'h-1', decision: 'remove' });
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateMany.mock.calls[0])).not.toContain('reportChoice');
    const missing = loggingMock.logToAxiom.mock.calls
      .map(([entry]) => entry as Record<string, unknown>)
      .filter((entry) => entry.type === 'reportChoice-missing');
    expect(missing).toEqual([expect.objectContaining({ payload: { decision: 'remove' } })]);
    expect(missing[0]).not.toHaveProperty('holdId');
    expect(missing[0]).not.toHaveProperty('userId');
  });

  it('does not count a confirm that carries a choice', async () => {
    await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
    expect(
      loggingMock.logToAxiom.mock.calls.filter(([entry]) => entry.type === 'reportChoice-missing')
    ).toEqual([]);
  });

  it('refuses the report decision with "none", before reading or acting', async () => {
    const res = await call({
      holdId: 12,
      textHash: 'h-1',
      decision: 'remove_ban_report',
      reportChoice: 'none',
    });
    expect(res.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(mocks.toggleBan).not.toHaveBeenCalled();
  });

  it('refuses a single-hold decision without the text hash', async () => {
    const { status } = await call({ holdId: 12, decision: 'dismiss' });
    expect(status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each(['none', 'imagery'] as const)(
    'records no report choice on any hold of a batch, even when %s is sent',
    async (reportChoice) => {
      const res = await call({
        holds: [12, 13, 14].map((holdId) => ({ holdId, textHash: 'h-1' })),
        decision: 'remove',
        reportChoice,
      });
      expect(res.status).toBe(200);
      expect(updateMany).toHaveBeenCalledTimes(3);
      for (const [args] of updateMany.mock.calls) {
        const meta = (args as { data: { meta: Record<string, unknown> } }).data.meta;
        expect(meta).not.toHaveProperty('reportChoice');
        expect(meta).toMatchObject({ reviewedDecision: false });
      }
    }
  );

  it('does not count a batch without a choice as an older app', async () => {
    await call({ holds: [{ holdId: 12, textHash: 'h-1' }], decision: 'remove' });
    expect(
      loggingMock.logToAxiom.mock.calls.filter(([entry]) => entry.type === 'reportChoice-missing')
    ).toEqual([]);
  });

  it('accepts a batch whose holds carry their own text hash, with none at the top level', async () => {
    const { status } = await call({
      holds: [{ holdId: 12, textHash: 'h-1' }],
      decision: 'dismiss',
    });
    expect(status).toBe(200);
  });

  describe('do nothing (dismiss)', () => {
    it('closes the hold as Dismissed and touches nothing else', async () => {
      const { status, body } = await call({
        holdId: 12,
        textHash: 'h-1',
        decision: 'dismiss',
        note: 'fine',
      });
      expect(status).toBe(200);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: 12, label: 'csam', status: 'Pending', textHash: 'h-1' },
        data: expect.objectContaining({
          status: 'Dismissed',
          decidedAt: expect.any(Date),
          decidedById: 7,
          decisionNote: 'fine',
        }),
      });
      expect(body).toMatchObject({ holdId: 12, status: 'Dismissed', decision: 'dismiss' });
      for (const effect of [
        mocks.bulkSetCommentV3TosViolation,
        mocks.createStrike,
        mocks.toggleBan,
      ])
        expect(effect).not.toHaveBeenCalled();
    });

    it('records a dismissal without a note as no note', async () => {
      await call({ holdId: 12, textHash: 'h-1', decision: 'dismiss', note: '  ' });
      expect(updateMany.mock.calls[0][0].data.decisionNote).toBeNull();
    });
  });

  describe('the four removal decisions', () => {
    it('remove: removes the content and nothing else', async () => {
      const { status, body } = await call({
        holdId: 12,
        textHash: 'h-1',
        decision: 'remove',
        reportChoice: 'imagery',
        note: 'gone',
      });
      expect(status).toBe(200);
      expect(mocks.bulkSetCommentV3TosViolation).toHaveBeenCalledWith({
        ids: [55],
        actor: { id: 7, ip: undefined },
      });
      expect(mocks.createStrike).not.toHaveBeenCalled();
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data).toMatchObject({
        status: 'Confirmed',
        decidedById: 7,
        decisionNote: 'gone',
        meta: { chatId: 3, decision: 'remove', reportChoice: 'imagery' },
      });
      expect(body).toMatchObject({ holdId: 12, status: 'Confirmed', decision: 'remove' });
    });

    it('remove_strike: removes the content, then strikes the author', async () => {
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove_strike', reportChoice: 'none' });
      expect(mocks.bulkSetCommentV3TosViolation).toHaveBeenCalled();
      expect(mocks.createStrike).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 900,
          reason: 'ManualModAction',
          issuedBy: 7,
          entityType: 'CommentV3',
          entityId: 55,
        })
      );
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data.status).toBe('Confirmed');
    });

    it('remove_ban: removes the content, then bans the author', async () => {
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove_ban', reportChoice: 'none' });
      expect(mocks.bulkSetCommentV3TosViolation).toHaveBeenCalled();
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
      const { body } = await call({
        holdId: 12,
        textHash: 'h-1',
        decision: 'remove_ban_report',
        reportChoice: 'imagery',
      });
      expect(mocks.bulkSetCommentV3TosViolation).toHaveBeenCalled();
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
      const { status } = await call({
        holdId: 12,
        textHash: 'h-1',
        decision: 'remove_ban',
        reportChoice: 'none',
      });
      expect(status).toBe(200);
      expect(mocks.toggleBan).not.toHaveBeenCalled();
      expect(updateMany.mock.calls[0][0].data.status).toBe('Confirmed');
    });
  });

  describe('removal per entity type', () => {
    it('clears the profile text of a user profile hold', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'UserProfile', entityId: 900 }));
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
      expect(mocks.clearUserProfileFields).toHaveBeenCalledWith({ userId: 900 });
    });

    it('soft-deletes a chat message as a moderator, auditing it', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'ChatMessage' }));
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
      expect(mocks.deleteChatMessage).toHaveBeenCalledWith({
        messageId: 55,
        actorId: 7,
        isModerator: true,
        audit: expect.any(Function),
      });
      expect(mocks.deleteChatMessage).toHaveBeenCalledTimes(1);
      const { audit } = mocks.deleteChatMessage.mock.calls[0][0];
      await audit({ type: 'delete' });
      expect(mocks.tracker.chatAudit).toHaveBeenCalledWith({ type: 'delete' });
    });

    it('deletes every message of the judged chat window, the held one included', async () => {
      findFirst.mockResolvedValue(
        pendingHold({ entityType: 'ChatMessage', meta: { chatId: 3, messageIds: [54, 53] } })
      );
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
      expect(mocks.deleteChatMessage.mock.calls.map(([a]) => a.messageId).sort()).toEqual([
        53, 54, 55,
      ]);
    });

    it('unpublishes a model as a violation and refreshes its cache', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Model' }));
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
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

    describe('article', () => {
      const articleUpdate = () => dbMock.dbWrite.article.updateMany;
      beforeEach(() => {
        findFirst.mockResolvedValue(pendingHold({ entityType: 'Article' }));
        articleUpdate().mockResolvedValue({ count: 1 });
      });

      it('unpublishes a published article as a violation, keeping its content', async () => {
        dbMock.dbWrite.article.findUnique.mockResolvedValue({
          status: 'Published',
          metadata: { foo: 1 },
        });
        const { status } = await call({
          holdId: 12,
          textHash: 'h-1',
          decision: 'remove',
          reportChoice: 'none',
        });
        expect(status).toBe(200);
        expect(mocks.unpublishArticleById).toHaveBeenCalledTimes(1);
        expect(mocks.unpublishArticleById).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 55,
            reason: 'csam-text-hold',
            metadata: { foo: 1 },
            userId: 7,
            isModerator: true,
          })
        );
        expect(mocks.tracker.article).toHaveBeenCalledTimes(1);
        expect(mocks.tracker.article).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'Unpublish', articleId: 55 })
        );
        expect(articleUpdate()).not.toHaveBeenCalled();
        expect(labelCalls()).toHaveLength(1);
      });

      // A Draft (scheduled or not) or Unpublished one records its status, so a moderator's restore
      // returns it to its author as it was. Processing was a publish the author asked for, and
      // records that, since it need have no publishedAt to restore by.
      it.each([
        ['a draft', { status: 'Draft', scheduledAt: null }, { statusBeforeViolation: 'Draft' }],
        [
          'a scheduled draft',
          { status: 'Draft', scheduledAt: new Date('2027-01-01') },
          { statusBeforeViolation: 'Draft' },
        ],
        [
          'a processing article',
          { status: 'Processing', scheduledAt: null },
          { statusBeforeViolation: 'Published' },
        ],
        [
          'an owner-unpublished article',
          { status: 'Unpublished', scheduledAt: null },
          { statusBeforeViolation: 'Unpublished' },
        ],
      ])('marks %s as a violation so it cannot go live later', async (_name, row, recorded) => {
        dbMock.dbWrite.article.findUnique.mockResolvedValue({ ...row, metadata: { foo: 1 } });
        const { status } = await call({
          holdId: 12,
          textHash: 'h-1',
          decision: 'remove',
          reportChoice: 'none',
        });
        expect(status).toBe(200);
        expect(mocks.unpublishArticleById).not.toHaveBeenCalled();
        expect(articleUpdate()).toHaveBeenCalledTimes(1);
        expect(articleUpdate()).toHaveBeenCalledWith({
          where: { id: 55, status: row.status },
          data: {
            status: 'UnpublishedViolation',
            metadata: {
              foo: 1,
              ...recorded,
              unpublishedReason: 'csam-text-hold',
              unpublishedAt: expect.any(String),
              unpublishedBy: 7,
            },
          },
        });
        expect(labelCalls()).toHaveLength(1);
      });

      it('takes the ingestion lock before reading and writing the article', async () => {
        dbMock.dbWrite.article.findUnique.mockResolvedValue({
          status: 'Processing',
          metadata: {},
        });
        await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
        const lock = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0];
        expect(lock).toBeDefined();
        expect(lock).toBeLessThan(dbMock.dbWrite.article.findUnique.mock.invocationCallOrder[0]);
        expect(lock).toBeLessThan(articleUpdate().mock.invocationCallOrder[0]);
      });

      // Each transaction gets its own client (`useTxClients`), so a write made on dbWrite instead
      // of through the transaction shows as transaction 0.
      it.each(['Draft', 'Published'])(
        "revokes a %s article's share links in the transaction that takes it down",
        async (status) => {
          useTxClients();
          const locks = recordTx(dbMock.dbWrite.$executeRaw, 0);
          const revokes = recordTx(dbMock.dbWrite.accessToken.updateMany, { count: 1 });
          const writes = recordTx(articleUpdate(), { count: 1 });
          const reads = recordTx(dbMock.dbWrite.article.findUnique, { status, metadata: {} });
          await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
          expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith({
            where: { resourceType: 'Article', resourceId: 55, revokedAt: null },
            data: { revokedAt: expect.any(Date) },
          });
          expect(revokes[0]).toBeGreaterThan(0);
          expect(revokes[0]).toBe(reads[0]);
          if (status === 'Draft') expect(revokes[0]).toBe(writes[0]);
          // The share-link lock in that transaction, after the ingestion lock (the order every
          // holder of both takes them in) and before the article is read.
          const raw = dbMock.dbWrite.$executeRaw.mock;
          const tokenLock = raw.calls.findIndex((c: unknown[]) => c[1] === 0x41544b && c[2] === 55);
          const ingestionLock = raw.calls.findIndex(
            (c: unknown[]) => c.length === 2 && c[1] === 55
          );
          expect([tokenLock, ingestionLock].every((i) => i >= 0)).toBe(true);
          expect(locks[tokenLock]).toBe(reads[0]);
          expect(locks[ingestionLock]).toBe(reads[0]);
          expect(raw.invocationCallOrder[ingestionLock]).toBeLessThan(
            raw.invocationCallOrder[tokenLock]
          );
          expect(raw.invocationCallOrder[tokenLock]).toBeLessThan(
            dbMock.dbWrite.article.findUnique.mock.invocationCallOrder[0]
          );
        }
      );

      // Else the next restore would send a published article back to its author.
      it('drops the status an earlier block recorded when it unpublishes a published article', async () => {
        dbMock.dbWrite.article.findUnique.mockResolvedValue({
          status: 'Published',
          scheduledAt: null,
          metadata: { foo: 1, statusBeforeViolation: 'Draft' },
        });
        await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
        expect(mocks.unpublishArticleById).toHaveBeenCalledWith(
          expect.objectContaining({ metadata: { foo: 1 } })
        );
      });

      it.each([
        ['already removed', { status: 'UnpublishedViolation', metadata: {} }],
        ['missing', null],
      ])('records the decision for an article that is %s, without writing', async (_name, row) => {
        dbMock.dbWrite.article.findUnique.mockResolvedValue(row);
        const { status } = await call({
          holdId: 12,
          textHash: 'h-1',
          decision: 'remove',
          reportChoice: 'none',
        });
        expect(status).toBe(200);
        expect(mocks.unpublishArticleById).not.toHaveBeenCalled();
        expect(articleUpdate()).not.toHaveBeenCalled();
        expect(labelCalls()).toHaveLength(1);
      });
    });

    it('unpublishes a post instead of deleting it', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Post' }));
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' });
      expect(mocks.unpublishPostAsModerator).toHaveBeenCalledWith({
        id: 55,
        userId: 7,
        reason: 'csam-text-hold',
      });
    });

    // `Comment`/`CommentV2`: a hold whose v1 id never reached CommentV3 keeps its old type.
    it.each(['Image', 'Comment', 'CommentV2'])(
      'refuses a removal of a %s hold, which has no removal path, before doing anything',
      async (entityType) => {
        findFirst.mockResolvedValue(pendingHold({ entityType }));
        const { status } = await call({
          holdId: 12,
          textHash: 'h-1',
          decision: 'remove_ban',
          reportChoice: 'none',
        });
        expect(status).toBe(400);
        expect(mocks.toggleBan).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
      }
    );

    it('still lets a hold of that type be dismissed', async () => {
      findFirst.mockResolvedValue(pendingHold({ entityType: 'Image' }));
      expect((await call({ holdId: 12, textHash: 'h-1', decision: 'dismiss' })).status).toBe(200);
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
        await call({
          holdId: 12,
          textHash: 'h-1',
          decision,
          ...(decision === 'dismiss' ? {} : { reportChoice: choiceFor(decision) }),
        });
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
      expect(
        (await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' }))
          .status
      ).toBe(409);
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
        await call({
          holdId: 12,
          textHash: 'h-1',
          decision,
          ...(decision === 'dismiss' ? {} : { reportChoice: choiceFor(decision) }),
        });
      expect(dbMock.dbWrite.report.create).not.toHaveBeenCalled();
    });

    it('logs the decision to Axiom', async () => {
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove_ban', reportChoice: 'none' });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'csam-hold-decision',
          holdId: 12,
          entityType: 'CommentV3',
          entityId: 55,
          decision: 'remove_ban',
          moderatorId: 7,
          payload: { reportChoice: 'none' },
        })
      );
    });
  });

  describe('refusals', () => {
    it('refuses a moderator without the csam permission, before reading or acting', async () => {
      mocks.hasModeratorGrant.mockResolvedValue(false);
      expect(
        (await call({ holdId: 12, textHash: 'h-1', decision: 'remove_ban', reportChoice: 'none' }))
          .status
      ).toBe(403);
      expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        'csam.report.file'
      );
      expect(findFirst).not.toHaveBeenCalled();
      expect(mocks.toggleBan).not.toHaveBeenCalled();
    });

    it('refuses a batch from a moderator without the csam permission, before reading or acting', async () => {
      const batch = {
        holds: [{ holdId: 12, textHash: 'h-1' }],
        decision: 'remove',
        reportChoice: 'none',
      };
      mocks.hasModeratorGrant.mockResolvedValue(false);
      expect((await call(batch)).status).toBe(403);
      expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        'csam.report.file'
      );
      expect(findFirst).not.toHaveBeenCalled();
      expect(mocks.bulkSetCommentV3TosViolation).not.toHaveBeenCalled();
      expect(labelCalls()).toHaveLength(0);

      // The same batch with the permission is decided, and recorded as a batch decision.
      mocks.hasModeratorGrant.mockResolvedValue(true);
      expect((await call(batch)).status).toBe(200);
      expect(mocks.bulkSetCommentV3TosViolation).toHaveBeenCalledTimes(1);
      expect(labelCalls()[0].slice(1)).toEqual(
        expect.arrayContaining(['csam', 'batch_apply', 'TextScanHold:12'])
      );
    });

    it.each([
      ['missing', null],
      ['already dismissed', pendingHold({ status: 'Dismissed' })],
      ['already confirmed', pendingHold({ status: 'Confirmed' })],
    ])('answers 409 when the hold is %s, without acting', async (_, row) => {
      findFirst.mockResolvedValue(row);
      expect(
        (await call({ holdId: 12, textHash: 'h-1', decision: 'remove_ban', reportChoice: 'none' }))
          .status
      ).toBe(409);
      expect(mocks.bulkSetCommentV3TosViolation).not.toHaveBeenCalled();
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
      expect(
        (await call({ holdId: 12, textHash: 'h-1', decision, reportChoice: choiceFor(decision) }))
          .status
      ).toBe(403);
      expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        grant
      );
      expect(findFirst).not.toHaveBeenCalled();
      expect(mocks.bulkSetCommentV3TosViolation).not.toHaveBeenCalled();
    });

    it('does not ask for the ban or strike grant on a removal or a dismissal', async () => {
      mocks.hasModeratorGrant.mockImplementation(async (_, id) => id === 'csam.report.file');
      expect(
        (await call({ holdId: 12, textHash: 'h-1', decision: 'remove', reportChoice: 'none' }))
          .status
      ).toBe(200);
      expect((await call({ holdId: 12, textHash: 'h-1', decision: 'dismiss' })).status).toBe(200);
    });

    it('refuses a strike or ban when the hold has no recorded author', async () => {
      findFirst.mockResolvedValue(pendingHold({ userId: null }));
      expect(
        (
          await call({
            holdId: 12,
            textHash: 'h-1',
            decision: 'remove_strike',
            reportChoice: 'none',
          })
        ).status
      ).toBe(400);
      expect(mocks.bulkSetCommentV3TosViolation).not.toHaveBeenCalled();
    });

    it('leaves the hold pending when an action fails, so the decision can be retried', async () => {
      mocks.createStrike.mockRejectedValue(new Error('strike store down'));
      const { status } = await call({
        holdId: 12,
        textHash: 'h-1',
        decision: 'remove_strike',
        reportChoice: 'none',
      });
      expect(status).toBeGreaterThanOrEqual(500);
      expect(updateMany).not.toHaveBeenCalled();
      expect(labelCalls()).toHaveLength(0);
    });

    it('does not strike or ban when the content could not be removed', async () => {
      mocks.bulkSetCommentV3TosViolation.mockRejectedValue(new Error('db down'));
      await call({ holdId: 12, textHash: 'h-1', decision: 'remove_ban', reportChoice: 'none' });
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

// The SQL of both is pinned against Postgres in csam-hold-mark.pglite.test.ts; these pin the endpoint.
describe.each([
  ['textScan.referCsamHold', referHandler, { holdId: 12, textHash: 'h-1', note: 'unsure' }],
  ['textScan.markCsamHoldReported', markReportedHandler, { holdId: 12 }],
  ['textScan.markCsamHoldReported (undo)', markReportedHandler, { holdId: 12, included: false }],
  [
    'textScan.setCsamHoldReportChoice',
    setReportChoiceHandler,
    { holdId: 12, reportChoice: 'none' },
  ],
] as const)('%s', (_, endpoint, body) => {
  it('refuses a moderator without the csam permission, before writing', async () => {
    mocks.hasModeratorGrant.mockResolvedValue(false);
    expect((await call(body, endpoint)).status).toBe(403);
    expect(mocks.hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      'csam.report.file'
    );
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('writes as the calling moderator', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 12 }] as never);
    expect((await call(body, endpoint)).status).toBe(200);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const values = dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1);
    expect(values).toContain(12);
    if (!('included' in body)) expect(values).toContain(7);
  });
});
