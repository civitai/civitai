import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';
import type * as CommentsService from '~/server/services/feature-pages/comments.service';
import {
  AUTHOR,
  bootFpDatabase,
  decided,
  fetchFake,
  json,
  mirrorRow,
  OTHER,
  pg,
  platform,
  posts,
  q,
  resetFpState,
  runMirror,
  scanClean,
  SIGNER,
  SUBJECT,
  UNKNOWN,
  FEATURE,
  urnOf,
  verdicts,
} from '~/server/services/feature-pages/__tests__/fp-harness';

// The post path (post, edit) against real Postgres, with the platform faked at fetch.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb', () => ({
  get kyselyRead() {
    return holder.kysely;
  },
  get kyselyWrite() {
    return holder.kysely;
  },
}));
const flags = vi.hoisted(() => ({ mirror: true, textScan: true }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async (flag: string) =>
    flag === 'feature-pages-mirror' ? flags.mirror : flag === 'text-scan' ? flags.textScan : false,
}));

let comments: typeof CommentsService;
let mirror: typeof MirrorService;
let moderation: typeof ModerationService;
beforeAll(async () => {
  await bootFpDatabase(holder);
  comments = await import('~/server/services/feature-pages/comments.service');
  mirror = await import('~/server/services/feature-pages/mirror.service');
  moderation = await import('~/server/services/commentv3/moderation.service');
});
afterAll(async () => {
  await pg.db.close();
});
beforeEach(() => resetFpState(flags));

const ctxFor = (id: number, isModerator = false) =>
  ({
    user: { id, username: id === AUTHOR ? 'author' : 'other', isModerator },
    track: {},
  } as never);
let seq = 0;
/** The comment's scan finishes clean and the mirror takes it up: what the platform then holds. */
const scannedAndPushed = async <T extends { comment: { sourceId: number; urn: string | null } }>(
  reply: T
) => {
  await scanClean(reply.comment.sourceId);
  await mirror.pushNewFpComment(reply.comment.sourceId);
  return {
    ...reply,
    comment: {
      ...reply.comment,
      urn: (await mirrorRow(reply.comment.sourceId)).urn as string | null,
    },
  };
};
/** A post; unless `unscanned`, its scan then finishes clean and the mirror pushes it. */
const post = async (
  text: string,
  over: { userId?: number; subject?: string; parent?: string; unscanned?: boolean } = {}
) => {
  const reply = await comments.postFeaturePageComment(ctxFor(over.userId ?? AUTHOR), {
    requestId: `r${++seq}`,
    subject: over.subject ?? SUBJECT,
    parent: over.parent,
    text,
  });
  return over.unscanned ? reply : scannedAndPushed(reply);
};

const UNKNOWN_LATER = 'urn:data.civitai.com:feature-pages/requests/dropped-later';

describe('posting', () => {
  it('refuses an account with no username before anything is written or sent, moderators included', async () => {
    const parent = await post('a parent');
    for (const [username, isModerator] of [
      [null, false],
      ['', false],
      ['  ', false],
      [null, true],
    ] as const) {
      const ctx = { user: { id: OTHER, username, isModerator }, track: {} } as never;
      for (const over of [{}, { parent: parent.comment.urn! }])
        await expect(
          comments.postFeaturePageComment(ctx, {
            requestId: `nameless-${++seq}`,
            subject: SUBJECT,
            text: 'no name yet',
            ...over,
          })
        ).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Set a username on your account to comment.',
        });
    }
    expect(
      await q(`SELECT count(*)::int AS n FROM "CommentV3" WHERE "userId" = $1`, [OTHER])
    ).toEqual([{ n: 0 }]);
    expect(posts().map((p) => p.uid)).not.toContain(OTHER);
  });

  it('writes one comment and one mirror row, and once its scan is clean posts it once under a mirror key, not the client requestId', async () => {
    const reply = await comments.postFeaturePageComment(ctxFor(AUTHOR), {
      requestId: 'req-1',
      subject: SUBJECT,
      text: 'Dark mode <please> & thanks',
    });
    // Answered before any scan: nothing sent yet.
    expect(reply.comment).toMatchObject({ urn: null, text: 'Dark mode <please> & thanks' });
    expect(posts()).toEqual([]);
    const { comment } = await scannedAndPushed(reply);
    expect(comment.urn).toBe(urnOf(comment.sourceId));
    expect(
      await q(`SELECT id FROM "CommentV3" WHERE "entityType"::text = 'featurePage'`)
    ).toHaveLength(1);
    expect(await mirrorRow(comment.sourceId)).toMatchObject({
      urn: urnOf(comment.sourceId),
      pushedState: 'visible',
    });
    expect(posts()).toEqual([
      expect.objectContaining({
        uid: AUTHOR,
        sourceId: comment.sourceId,
        subject: SUBJECT,
        text: 'Dark mode <please> & thanks',
        authorName: 'author',
        siteVerdict: 'visible',
        idempotencyKey: expect.stringMatching(new RegExp(`^c${comment.sourceId}:s0:`)),
      }),
    ]);
  });

  it('two concurrent sends of one requestId: one comment, one scan, one push, the same comment back', async () => {
    const queued = vi.spyOn(
      await import('~/server/services/text-scan/scam-scan-queue'),
      'queueScamScan'
    );
    const input = { requestId: 'req-twice', subject: SUBJECT, text: 'once' };
    const [a, b] = await Promise.all([
      comments.postFeaturePageComment(ctxFor(AUTHOR), input),
      comments.postFeaturePageComment(ctxFor(AUTHOR), input),
    ]);
    expect(a.comment.sourceId).toBe(b.comment.sourceId);
    expect(a.comment.text).toBe(b.comment.text);
    expect(
      await q(`SELECT id FROM "CommentV3" WHERE "entityType"::text = 'featurePage'`)
    ).toHaveLength(1);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
    await scannedAndPushed(a);
    expect(posts()).toHaveLength(1);
    // A later resend answers the same, writing nothing.
    const again = await comments.postFeaturePageComment(ctxFor(AUTHOR), input);
    expect(again.comment).toMatchObject({
      sourceId: a.comment.sourceId,
      urn: urnOf(a.comment.sourceId),
    });
    expect(posts()).toHaveLength(1);
    // Control: another requestId is another comment.
    await post('twice');
    expect(posts()).toHaveLength(2);
    queued.mockRestore();
  });

  it("refuses a reply or a reply's edit to an author who blocked the writer; a moderator's and an unblocked reply go through", async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
    // Read by the blocked-by cache; the write gate then confirms on the primary (mocked below).
    await q(`DO $$ BEGIN CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
             EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await q(`CREATE TABLE IF NOT EXISTS "UserEngagement"
             ("userId" int, "targetUserId" int, type "UserEngagementType")`);
    const { comment: root } = await post('root by the author');
    const { comment: reply } = await post('a reply', { userId: OTHER, parent: root.urn! });
    // The author blocks OTHER after the reply.
    dbMock.dbWrite.userEngagement.findFirst.mockImplementation((async (args: {
      where: { userId: number; targetUserId: number };
    }) =>
      args.where.userId === AUTHOR && args.where.targetUserId === OTHER
        ? { userId: AUTHOR }
        : null) as never);
    await expect(post('again', { userId: OTHER, parent: root.urn! })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      comments.editFeaturePageComment(ctxFor(OTHER), {
        requestId: `e${++seq}`,
        comment: reply.urn!,
        text: 'edited',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      comments.postFeaturePageComment(ctxFor(OTHER, true), {
        requestId: `r${++seq}`,
        subject: SUBJECT,
        parent: root.urn!,
        text: 'as a moderator',
      })
    ).resolves.toMatchObject({ comment: { text: 'as a moderator' } });
    dbMock.dbWrite.userEngagement.findFirst.mockResolvedValue(null as never);
    await expect(post('unblocked', { userId: OTHER, parent: root.urn! })).resolves.toMatchObject({
      comment: { text: 'unblocked' },
    });
  });

  const written = async (subject: string) => ({
    topics: (await q(`SELECT id FROM "FeaturePageTopic" WHERE urn = $1`, [subject])).length,
    comments: (await q(`SELECT id FROM "CommentV3" WHERE "entityType"::text = 'featurePage'`))
      .length,
  });

  // civitai/civitai#10318: an unknown request or feature is refused before any write.
  it.each([
    ['a request', UNKNOWN, true],
    ['a request', UNKNOWN, false],
    ['a feature', FEATURE, true],
    ['a feature', FEATURE, false],
  ])(
    '%s the platform does not hold is refused with nothing written (mirror on: %s)',
    async (_, subject, mirrorOn) => {
      flags.mirror = mirrorOn;
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(
          comments.postFeaturePageComment(ctxFor(AUTHOR), {
            requestId: 'r-unknown',
            subject,
            text: 'hello',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await written(subject)).toEqual({ topics: 0, comments: 0 });
      expect(posts()).toEqual([]);
      platform.unknown.delete(subject);
      platform.features.add(subject);
      await expect(post('hello', { subject })).resolves.toMatchObject({
        comment: { text: 'hello' },
      });
      expect(await written(subject)).toEqual({ topics: 1, comments: 1 });
    }
  );

  it('a subject the platform drops after the lookup: the push is refused, the comment hidden, a resend refused', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null as never);
    const { comment } = await post('hello', { subject: UNKNOWN_LATER, unscanned: true });
    platform.unknown.add(UNKNOWN_LATER);
    await scannedAndPushed({ comment });
    expect(
      await q(`SELECT hidden FROM "CommentV3" WHERE "entityType"::text = 'featurePage'`)
    ).toEqual([{ hidden: true }]);
    expect(posts()).toEqual([]);
    // Known again to the lookup, so only the stored refusal refuses the resend.
    platform.unknown.delete(UNKNOWN_LATER);
    await expect(
      comments.postFeaturePageComment(ctxFor(AUTHOR), {
        requestId: `r${seq}`,
        subject: UNKNOWN_LATER,
        text: 'hello',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['down', () => void (platform.down = true)],
    ['without the lookup route', () => void (platform.subjectLookup = 'no-route')],
    ['answering a 200 that is not an answer', () => void (platform.subjectLookup = 'bad')],
  ])(
    'with the subject lookup %s, a post is refused to try again, nothing written',
    async (_, fail) => {
      fail();
      await expect(
        comments.postFeaturePageComment(ctxFor(AUTHOR), {
          requestId: 'r-down',
          subject: SUBJECT,
          text: 'while down',
        })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(await written(SUBJECT)).toEqual({ topics: 0, comments: 0 });
    }
  );

  it('takes a feature subject only by its slug, and no text longer than the platform takes', async () => {
    const { featurePageCommentSchema } = await import('~/server/schema/feature-pages.schema');
    const valid = (subject: string, text = 'hi') =>
      featurePageCommentSchema.safeParse({ requestId: 'r', subject, text }).success;
    expect(valid(FEATURE)).toBe(true);
    expect(valid('urn:data.civitai.com:feature-pages/features/Dark_Mode')).toBe(false);
    expect(valid('urn:data.civitai.com:feature-pages/requests/Any.Request_1')).toBe(true);
    expect(valid(FEATURE, 'x'.repeat(4001))).toBe(false);
  });

  it('a hide landing while the first post is in flight ends hidden on the platform', async () => {
    platform.onPost = async (body) => {
      platform.onPost = null;
      await q(`UPDATE "CommentV3" SET hidden = true WHERE id = $1`, [body.sourceId]);
      // The cron runs meanwhile.
      await runMirror(mirror);
    };
    const { comment } = await post('hidden mid-post');
    await runMirror(mirror);
    expect(decided(comment.sourceId)).toBe('hidden');
    expect(posts()).toHaveLength(1);
  });

  it('refuses a post into a thread a moderator locked, and posts into an open one', async () => {
    const { comment } = await post('first');
    await q(`UPDATE "CommentTopic" SET locked = true WHERE "entityType"::text = 'featurePage'`);
    await expect(post('second')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await q(`UPDATE "CommentTopic" SET locked = false WHERE "entityType"::text = 'featurePage'`);
    const reply = await post('second', { parent: urnOf(comment.sourceId) });
    expect(
      await q(`SELECT 1 FROM "CommentV3" WHERE id = $1 AND "deletedAt" IS NULL`, [
        reply.comment.sourceId,
      ])
    ).toHaveLength(1);
  });

  it('with the platform down after the lookup, answers ok with no urn, and the cron posts it once when it is back', async () => {
    const { comment } = await post('while down', { unscanned: true });
    platform.down = true;
    await scannedAndPushed({ comment });
    expect((await mirrorRow(comment.sourceId)).urn).toBeNull();
    platform.down = false;
    await runMirror(mirror);
    await runMirror(mirror);
    expect(posts()).toHaveLength(1);
    expect((await mirrorRow(comment.sourceId)).urn).toBe(urnOf(comment.sourceId));
  });
});

describe('edits', () => {
  /** An edit; its rescan then finishes clean and the mirror pushes it. */
  const edit = async (urn: string, text: string, userId = AUTHOR) => {
    const reply = await comments.editFeaturePageComment(ctxFor(userId), {
      requestId: `e${++seq}`,
      comment: urn,
      text,
    });
    const id = reply.comment.sourceId;
    await scanClean(id);
    await mirror.pushNewFpComment(id);
    return reply;
  };
  beforeEach(() => {
    // csamHoldState reads the verdict through Prisma: clear unless a test says otherwise.
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
  });

  it('posts a new version under the same urn, shown, under a key of its own', async () => {
    const { comment } = await post('first words');
    const urn = comment.urn!;
    await expect(edit(urn, 'better words')).resolves.toMatchObject({
      comment: { urn, text: 'better words' },
    });
    await runMirror(mirror);
    expect(posts().map((p) => [p.sourceId, p.text, p.siteVerdict, p.idempotencyKey])).toEqual([
      [comment.sourceId, 'first words', 'visible', posts()[0].idempotencyKey],
      [
        comment.sourceId,
        'better words',
        'visible',
        expect.stringMatching(new RegExp(`^c${comment.sourceId}:s1:`)),
      ],
    ]);
    expect((await mirrorRow(comment.sourceId)).platformDigest).toBe(`sha256:${comment.sourceId}:2`);
  });

  it('edit A, edit B, then a resend of A: the text stays B and no version is added', async () => {
    const { comment } = await post('start');
    const send = (requestId: string, text: string) =>
      comments.editFeaturePageComment(ctxFor(AUTHOR), { requestId, comment: comment.urn!, text });
    await send('edit-a', 'A');
    await send('edit-b', 'B');
    await expect(send('edit-a', 'A')).resolves.toMatchObject({ comment: { text: 'B' } });
    expect(
      (
        await q<{ content: string }>(`SELECT content FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].content
    ).toBe('<p>B</p>');
    expect((await mirrorRow(comment.sourceId)).version).toBe(3);
  });

  it('A, B, A, B makes four versions, the last B', async () => {
    const { comment } = await post('A');
    for (const text of ['B', 'A', 'B']) {
      await edit(comment.urn!, text);
      await runMirror(mirror);
    }
    expect(posts().map((p) => p.text)).toEqual(['A', 'B', 'A', 'B']);
    expect(platform.versions.get(comment.sourceId)).toBe(4);
  });

  it("refuses another user's edit, a locked thread, a csam hold and an open report; the author's goes through", async () => {
    const { comment } = await post('guarded');
    const urn = comment.urn!;
    await expect(edit(urn, 'not mine', OTHER)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await q(`UPDATE "CommentTopic" SET locked = true WHERE "entityType"::text = 'featurePage'`);
    await expect(edit(urn, 'locked')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await q(`UPDATE "CommentTopic" SET locked = false WHERE "entityType"::text = 'featurePage'`);

    dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
      { status: 'Pending', textHash: 'h', meta: {} },
    ] as never);
    await expect(edit(urn, 'held')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A hold the queue confirmed still bars it, whatever the verdict on the text says since.
    await q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Confirmed')`,
      [comment.sourceId]
    );
    await expect(edit(urn, 'confirmed held')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await q(`UPDATE "TextScanHold" SET status = 'Dismissed'`);
    // Not yet verified clear: still refused, with a retry for the frame.
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValueOnce(null as never);
    await expect(edit(urn, 'unverified')).rejects.toMatchObject({ code: 'CONFLICT' });

    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      comment.sourceId,
      id,
    ]);
    await expect(edit(urn, 'cleaned up')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [id]);

    await expect(edit(urn, 'allowed')).resolves.toMatchObject({ comment: { text: 'allowed' } });
    await runMirror(mirror);
    expect(posts().map((p) => p.text)).toEqual(['guarded', 'allowed']);
  });

  it('an edit under a moderator hide sends no text, and the hide is sent again', async () => {
    const { comment } = await post('hidden by a mod');
    await q(`UPDATE "CommentV3" SET hidden = true WHERE id = $1`, [comment.sourceId]);
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([['hidden', null]]);
    await edit(comment.urn!, 'edited while hidden');
    await runMirror(mirror);
    expect(posts().map((p) => p.text)).toEqual(['hidden by a mod']);
    expect(verdicts('mod')).toEqual([
      ['hidden', null],
      ['hidden', null],
    ]);
  });

  it('an edit the platform answers 409 removed is recorded removed: no retry, nothing stuck', async () => {
    const { comment } = await post('removed on the platform');
    platform.removed.add(comment.sourceId);
    await edit(comment.urn!, 'too late');
    await runMirror(mirror);
    expect(await mirrorRow(comment.sourceId)).toMatchObject({
      pushedState: 'mod-removed',
      nextPushAt: null,
      pushAttempts: 0,
    });
    const calls = fetchFake.mock.calls.length;
    await runMirror(mirror);
    expect(fetchFake.mock.calls.length).toBe(calls);
  });

  it('an edit whose rescan flags it sends no text and is hidden, never shown', async () => {
    const { comment } = await post('clean at first');
    await comments.editFeaturePageComment(ctxFor(AUTHOR), {
      requestId: `e${++seq}`,
      comment: comment.urn!,
      text: 'now a scam',
    });
    await runMirror(mirror);
    // The rescan flags it: the same hide a scan callback applies.
    await moderation.hideFlaggedFpComment(comment.sourceId, {
      createReport: async () =>
        (
          await q<{ id: number }>(`INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`)
        )[0],
    });
    await runMirror(mirror);
    expect(posts().map((p) => p.text)).toEqual(['clean at first']);
    expect(verdicts('mod')).toEqual([['hidden', null]]);
    expect((await mirrorRow(comment.sourceId)).pushedState).toBe('mod-hidden');
  });
});

describe('retracts', () => {
  const retract = (urn: string, userId = AUTHOR, isModerator = false) =>
    comments.retractFeaturePageComment(
      {
        ...(ctxFor(userId, isModerator) as object),
        track: { commentEvent: vi.fn(async () => undefined) },
      } as never,
      { requestId: `retract-${urn}`, comment: urn }
    );
  const scannedClear = () =>
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
  const kept = async (id: number) =>
    (await q<{ content: string }>(`SELECT content FROM "CommentV3" WHERE id = $1`, [id]))[0];

  const handlerCtx = (userId: number, isModerator: boolean) =>
    ({
      ...(ctxFor(userId, isModerator) as object),
      track: { commentEvent: vi.fn(async () => undefined) },
      features: {},
    } as never);
  const reportOn = async (id: number) => {
    const [{ id: reportId }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      id,
      reportId,
    ]);
  };

  it("the comment delete of a moderator's own reported comment is refused, the text kept; unreported, it retracts", async () => {
    scannedClear();
    const { deleteCommentV3Handler } = await import('~/server/controllers/commentv3.controller');
    const reported = (await post('my own, reported')).comment;
    const clean = (await post('my own, clean')).comment;
    await reportOn(reported.sourceId);
    await expect(
      deleteCommentV3Handler({ ctx: handlerCtx(AUTHOR, true), input: { id: reported.sourceId } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await kept(reported.sourceId)).toEqual({ content: expect.stringContaining('<p>') });
    await deleteCommentV3Handler({ ctx: handlerCtx(AUTHOR, true), input: { id: clean.sourceId } });
    expect((await mirrorRow(clean.sourceId)).goneCause).toBe('author');
  });

  it('the hide toggle hides a Feature Pages comment and answers an error on the unhide, which leaves it hidden', async () => {
    const { toggleHideCommentV3Handler } = await import(
      '~/server/controllers/commentv3.controller'
    );
    const { comment } = await post('to hide');
    await toggleHideCommentV3Handler({
      ctx: handlerCtx(OTHER, true),
      input: { id: comment.sourceId },
    });
    await expect(
      toggleHideCommentV3Handler({ ctx: handlerCtx(OTHER, true), input: { id: comment.sourceId } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(
      (
        await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].hidden
    ).toBe(true);
  });

  it("an author's retract takes the comment away", async () => {
    scannedClear();
    const { comment } = await post('mine to take back');
    await expect(retract(comment.urn!)).resolves.toEqual({ comment: comment.urn });
    expect((await mirrorRow(comment.sourceId)).goneCause).toBe('author');
  });

  it("a ToS-removed or reported comment is kept as evidence, a moderator's own included", async () => {
    scannedClear();
    const tos = (await post('removed for ToS')).comment;
    const reported = (await post('reported')).comment;
    await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [tos.sourceId]);
    const [{ id: reportId }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      reported.sourceId,
      reportId,
    ]);
    for (const isModerator of [false, true])
      for (const c of [tos, reported]) {
        await expect(retract(c.urn!, AUTHOR, isModerator)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        expect(await kept(c.sourceId)).toEqual({ content: expect.stringContaining('<p>') });
      }
  });

  it('a comment not yet scanned clear is refused with a retryable conflict', async () => {
    const { comment } = await post('not scanned yet');
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null as never);
    await expect(retract(comment.urn!)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await mirrorRow(comment.sourceId)).goneCause).toBeNull();
  });
});

describe('reports from the frame', () => {
  const reporter = (isModerator = false) =>
    ({
      user: { id: OTHER, username: 'other', isModerator },
      track: { report: vi.fn(async () => undefined) },
      features: {},
    } as never);
  const report = (urn: string, isModerator = false) =>
    comments.reportFeaturePageComment(reporter(isModerator), { comment: urn, reason: 'Spam' });
  beforeEach(() => {
    dbMock.dbWrite.report.create.mockClear();
    dbMock.dbWrite.report.create.mockResolvedValue({ id: 1 } as never);
  });
  const filed = () =>
    dbMock.dbWrite.report.create.mock.calls.map(
      ([args]) => (args as { data: { commentV3?: { create: { commentId: number } } } }).data
    );

  it("files a member's report on a comment the frame shows, through the report path", async () => {
    const { comment } = await post('worth reporting');
    await expect(report(comment.urn!)).resolves.toEqual({ comment: comment.urn });
    expect(filed()).toEqual([
      expect.objectContaining({
        userId: OTHER,
        reason: 'Spam',
        commentV3: { create: { commentId: comment.sourceId } },
      }),
    ]);
  });

  it('answers NOT_FOUND for a hidden, ToS-removed, deleted or unknown comment; a moderator still reports a hidden one', async () => {
    const hidden = (await post('hidden')).comment;
    const tos = (await post('removed for ToS')).comment;
    const gone = (await post('deleted')).comment;
    await q(`UPDATE "CommentV3" SET hidden = true WHERE id = $1`, [hidden.sourceId]);
    await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [tos.sourceId]);
    await dbMock.dbWrite.$transaction((tx: never) =>
      moderation.deleteCommentsV3(tx, [gone.sourceId])
    );
    for (const urn of [hidden.urn!, tos.urn!, gone.urn!, urnOf(999_999)])
      await expect(report(urn)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(filed()).toEqual([]);
    await expect(report(hidden.urn!, true)).resolves.toBeTruthy();
  });

  it('answers NOT_FOUND for an unhidden comment the frame does not show again yet (mirror braked)', async () => {
    const { comment } = await post('hidden, unhidden while braked');
    await q(`UPDATE "CommentV3" SET hidden = true WHERE id = $1`, [comment.sourceId]);
    await runMirror(mirror);
    flags.mirror = false;
    await q(`UPDATE "CommentV3" SET hidden = false WHERE id = $1`, [comment.sourceId]);
    await expect(report(comment.urn!)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    flags.mirror = true;
    await runMirror(mirror);
    await expect(report(comment.urn!)).resolves.toBeTruthy();
  });

  it("keeps the site's generic comment report closed to members for a Feature Pages comment", async () => {
    const { comment } = await post('reported the generic way');
    const { createReportHandler } = await import('~/server/controllers/report.controller');
    await expect(
      createReportHandler({
        input: { type: 'commentV3', id: comment.sourceId, reason: 'Spam', details: {} } as never,
        ctx: reporter(),
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(filed()).toEqual([]);
  });
});

describe('the edit write', () => {
  it("takes the caller's first lock before the comment's row lock", async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
    const { comment } = await post('lock order');
    const { writeCommentEdit } = await import('~/server/services/commentv3/comment-write.service');
    const { getStoredComment, prismaRunner } = await import(
      '~/server/services/commentv3/write.service'
    );
    const stored = await getStoredComment(prismaRunner(dbMock.dbWrite as never), comment.sourceId);
    const seen: string[] = [];
    await writeCommentEdit({
      userId: AUTHOR,
      comment: stored!,
      content: '<p>lock order, edited</p>',
      beforeLock: async (tx) => {
        seen.push('first lock');
        const query = tx.$queryRawUnsafe.bind(tx);
        Object.assign(tx, {
          $queryRawUnsafe: (sql: string, ...params: unknown[]) => {
            if (/FOR UPDATE/.test(sql)) seen.push('row lock');
            return query(sql, ...params);
          },
        });
      },
    });
    expect(seen).toEqual(['first lock', 'row lock']);
  });
});
