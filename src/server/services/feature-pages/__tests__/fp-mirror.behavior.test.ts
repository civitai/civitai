import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';
import { ReportEntity } from '~/shared/utils/report-helpers';
import {
  AUTHOR,
  bootFpDatabase,
  decided,
  fetchFake,
  mirrorRow,
  OTHER,
  pg,
  platform,
  posts,
  q,
  resetFpState,
  runMirror,
  scanClean,
  seedFpComment,
  SIGNER,
  UNKNOWN,
  FEATURE,
  urnOf,
  verdicts,
} from '~/server/services/feature-pages/__tests__/fp-harness';

// The mirror, the sweep and the reconcile against real Postgres, with the platform faked at fetch.
// Comments are seeded as the post path leaves them, so these tests stand without it.
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
const flags = vi.hoisted(() => ({ mirror: true, textScan: true as boolean | 'throw' }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async (flag: string) => {
    if (flag === 'feature-pages-mirror') return flags.mirror;
    if (flag !== 'text-scan') return false;
    if (flags.textScan === 'throw') throw new Error('flag read failed');
    return flags.textScan;
  },
}));

let mirror: typeof MirrorService;
let moderation: typeof ModerationService;
beforeAll(async () => {
  await bootFpDatabase(holder);
  mirror = await import('~/server/services/feature-pages/mirror.service');
  moderation = await import('~/server/services/commentv3/moderation.service');
});
afterAll(async () => {
  await pg.db.close();
});
beforeEach(() => resetFpState(flags));

// The migration is applied here, so the jobs return their counts.
type Migrated<T> = Exclude<T, { migrated: false }>;
const sweep = async () =>
  (await mirror.runFpSweep()) as Migrated<Awaited<ReturnType<typeof MirrorService.runFpSweep>>>;
const reconcile = async () =>
  (await mirror.runFpReconcile()) as Migrated<
    Awaited<ReturnType<typeof MirrorService.runFpReconcile>>
  >;
const seed = (text: string, opts?: { userId?: number; subject?: string; scanned?: boolean }) =>
  seedFpComment(mirror, text, opts);
/** Its earlier post attempt is known never to have reached the platform. */
const neverSent = (id: number) =>
  q(`UPDATE "FeaturePageCommentMirror" SET "postAttemptedAt" = NULL WHERE "commentId" = $1`, [id]);

describe('before the migration is applied', () => {
  it('the mirror, the sweep and the reconcile each return without touching the missing tables', async () => {
    const { commentSchemaDatabase, dialect } = await import(
      '~/server/services/feature-pages/__tests__/fp-harness'
    );
    const { Kysely } = await import('kysely');
    const bare = await commentSchemaDatabase();
    const migrated = holder.kysely;
    holder.kysely = new Kysely({ dialect: dialect(bare) });
    try {
      for (const run of [mirror.runFpMirror, mirror.runFpSweep, mirror.runFpReconcile])
        await expect(run()).resolves.toEqual({ migrated: false });
    } finally {
      holder.kysely = migrated;
      await bare.close();
    }
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('hiding, unhiding and deleting a model comment work without the new tables', async () => {
    const { commentSchemaDatabase } = await import(
      '~/server/services/feature-pages/__tests__/fp-harness'
    );
    const { setCommentFlags, deleteComments } = await import(
      '~/server/services/commentv3/write.service'
    );
    const bare = await commentSchemaDatabase();
    try {
      const db = {
        query: async (sql: string, params: unknown[] = []) => ({
          rows: (await bare.query(sql, params)).rows as never[],
        }),
      };
      await bare.exec(
        `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model', 1) ON CONFLICT DO NOTHING`
      );
      const [{ id }] = (
        await bare.query<{ id: number }>(
          `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content) VALUES ('model', 1, 2, 'x') RETURNING id`
        )
      ).rows;
      expect(await setCommentFlags(db, [id], { hidden: true })).toEqual([{ id, userId: 2 }]);
      expect(await setCommentFlags(db, [id], { hidden: false })).toEqual([{ id, userId: 2 }]);
      expect((await deleteComments(db, [id])).map((r) => r.id)).toEqual([id]);
    } finally {
      await bare.close();
    }
  });
});

describe('the text-scan gate', () => {
  it('keeps a comment off the platform while its scan is off or unreadable or has no clean verdict for its text, and posts it after one', async () => {
    try {
      flags.textScan = false;
      const { comment } = await seed('while scanning is off', { scanned: false });
      await runMirror(mirror);
      flags.textScan = 'throw';
      await runMirror(mirror);
      expect(posts()).toEqual([]);
      expect((await mirrorRow(comment.sourceId)).pushAttempts).toBe(0);
      flags.textScan = true;
      expect(await q(`SELECT 1 FROM "EntityModeration"`)).toEqual([]);
      await runMirror(mirror);
      expect(posts()).toEqual([]);
      await scanClean(comment.sourceId);
      await runMirror(mirror);
      expect(posts().map((p) => p.sourceId)).toEqual([comment.sourceId]);
    } finally {
      flags.textScan = true;
    }
  });

  it('still pushes a retraction and a moderator removal while text scan is off', async () => {
    const a = (await seed('retracted')).comment;
    const b = (await seed('removed')).comment;
    flags.textScan = false;
    try {
      await dbMock.dbWrite.$transaction((tx: never) =>
        moderation.deleteCommentsV3(tx, [a.sourceId], 'author' as never)
      );
      await dbMock.dbWrite.$transaction((tx: never) =>
        moderation.deleteCommentsV3(tx, [b.sourceId])
      );
      await runMirror(mirror);
      expect(platform.posts.filter((p) => p.text === null).map((p) => p.sourceId)).toEqual([
        a.sourceId,
      ]);
      expect(verdicts('mod')).toEqual([['removed', null]]);
    } finally {
      flags.textScan = true;
    }
  });
});

describe('the brake', () => {
  it('pushes nothing of any kind while featurePagesMirror is off, and posts the row once when on', async () => {
    flags.mirror = false;
    const { comment } = await seed('braked');
    expect(comment.urn).toBeNull();
    await runMirror(mirror);
    expect(fetchFake.mock.calls.filter(([u]) => String(u).startsWith(SIGNER))).toHaveLength(0);
    // The sweep is not braked, and counts it as overdue once it has waited 15 minutes.
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() - interval '16 minutes'`);
    expect((await sweep()).overdue).toBe(1);
    flags.mirror = true;
    await runMirror(mirror);
    await runMirror(mirror);
    expect(posts()).toHaveLength(1);
    expect((await sweep()).overdue).toBe(0);
  });
});

describe('moderation changes the mirror carries', () => {
  it('a scam flag: hidden with a moderator hide on the platform and a system report; dismissing the report leaves it hidden', async () => {
    const { comment } = await seed('flagged');
    const hidden = async () =>
      (
        await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].hidden;
    // The system report, filed in the existing queue as createReport would.
    const createReport = vi.fn(async () => {
      const [report] = await q<{ id: number }>(
        `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
      );
      return report;
    });
    expect(await moderation.hideFlaggedFpComment(comment.sourceId, { createReport })).toBe(true);
    expect(createReport).toHaveBeenCalledOnce();
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        id: comment.sourceId,
        type: ReportEntity.CommentV3,
        reason: 'AdminAttention',
      })
    );
    expect(await hidden()).toBe(true);
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([['hidden', null]]);
    expect(
      (await q<{ muted: boolean }>(`SELECT muted FROM "User" WHERE id = $1`, [AUTHOR]))[0].muted
    ).toBe(false);

    await q(`UPDATE "Report" SET status = 'Unactioned'`);
    await sweep();
    await runMirror(mirror);
    expect(await hidden()).toBe(true);
    expect(decided(comment.sourceId)).toBe('hidden');
  });

  it('a csam hold: removed on the platform (purged), for good', async () => {
    const { comment } = await seed('held');
    await q(`UPDATE "CommentV3" SET hidden = true WHERE id = $1`, [comment.sourceId]);
    await q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [comment.sourceId]
    );
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([['removed', null]]);
    // Civitai clearing the hold later does not bring the text back on the platform.
    await q(`DELETE FROM "TextScanHold"`);
    await q(`UPDATE "CommentV3" SET hidden = false WHERE id = $1`, [comment.sourceId]);
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([['removed', null]]);
    // Only the first post's approval.
    expect(verdicts('site')).toEqual([['visible', null]]);
  });

  it("a ban's ToS flag on an FP comment pushes a moderator hide", async () => {
    const { comment } = await seed('banned soon');
    await q(
      `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model', 1) ON CONFLICT DO NOTHING`
    );
    const [{ id: modelComment }] = await q<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content) VALUES ('model', 1, $1, 'x') RETURNING id`,
      [AUTHOR]
    );
    const flagsOf = async (id: number) =>
      (
        await q<{ hidden: boolean; tosViolation: boolean }>(
          `SELECT hidden, "tosViolation" FROM "CommentV3" WHERE id = $1`,
          [id]
        )
      )[0];
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    await runMirror(mirror);
    // A ban without removeComments changes no comment, so no hide is pushed, and the same user's
    // model comment is as it was.
    expect(verdicts('mod')).toEqual([]);
    expect(await flagsOf(modelComment)).toEqual({ hidden: false, tosViolation: false });
    await moderation.setUserCommentsV3Tos(AUTHOR);
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([['hidden', null]]);
    expect((await mirrorRow(comment.sourceId)).pushedState).toBe('mod-hidden');
    await q(`DELETE FROM "CommentV3" WHERE id = $1`, [modelComment]);
  });

  it("the author's delete retracts; a moderator's removes; an account deletion erases once", async () => {
    const a = (await seed('mine')).comment;
    const b = (await seed('removed by a mod')).comment;
    const c = (await seed('erased with the account')).comment;
    const d = (await seed('also erased')).comment;
    await dbMock.dbWrite.$transaction((tx: any) =>
      moderation.deleteCommentsV3(tx, [a.sourceId], 'author' as never)
    );
    await dbMock.dbWrite.$transaction((tx: any) => moderation.deleteCommentsV3(tx, [b.sourceId]));
    await runMirror(mirror);
    expect(platform.posts.filter((p) => p.text === null).map((p) => p.sourceId)).toEqual([
      a.sourceId,
    ]);
    expect(verdicts('mod')).toEqual([['removed', null]]);
    expect(platform.erased).toEqual([]);

    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [AUTHOR]);
    await runMirror(mirror);
    await runMirror(mirror);
    expect(platform.erased).toEqual([AUTHOR]);
    for (const id of [a, b, c, d].map((x) => x.sourceId))
      expect((await mirrorRow(id)).pushedState).toBe('erased');
  });

  it('an account whose only comment is already retracted on the platform is still erased', async () => {
    const { comment } = await seed('retracted, then the account goes', { userId: OTHER });
    await dbMock.dbWrite.$transaction((tx: any) =>
      moderation.deleteCommentsV3(tx, [comment.sourceId], 'author' as never)
    );
    await runMirror(mirror);
    expect((await mirrorRow(comment.sourceId)).pushedState).toBe('retracted');
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
    await runMirror(mirror);
    expect(platform.erased).toEqual([OTHER]);
    await q(`UPDATE "User" SET "deletedAt" = NULL WHERE id = $1`, [OTHER]);
  });
});

describe('a refusal from the platform', () => {
  const kept = async (id: number) =>
    (
      await q<{ hidden: boolean; deletedAt: Date | null }>(
        `SELECT hidden, "deletedAt" FROM "CommentV3" WHERE id = $1`,
        [id]
      )
    )[0];
  // Posted while the platform was down, so the refusal comes from a later run.
  const seedDeferred = async (text: string) => {
    platform.down = true;
    const { comment } = await seed(text, { subject: UNKNOWN });
    platform.down = false;
    await neverSent(comment.sourceId);
    return comment.sourceId;
  };
  const clear = () =>
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);

  it('deletes a comment verified clear with no open report, and its empty topic', async () => {
    clear();
    const id = await seedDeferred('on a subject the platform does not know');
    await runMirror(mirror);
    expect(await kept(id)).toBeUndefined();
    expect(await q(`SELECT 1 FROM "FeaturePageTopic" WHERE urn = $1`, [UNKNOWN])).toEqual([]);
  });

  it('keeps, hidden, a comment held in the csam queue since its state was read', async () => {
    clear();
    const id = await seedDeferred('held while the post was in flight');
    dbMock.dbWrite.textScanHold.findMany.mockResolvedValueOnce([
      { status: 'Pending', textHash: 'h', meta: {} },
    ] as never);
    await runMirror(mirror);
    expect(await kept(id)).toEqual({ hidden: true, deletedAt: null });
  });

  it('keeps, hidden, a comment not yet verified clear', async () => {
    clear();
    const id = await seedDeferred('not scanned yet');
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValueOnce(null as never);
    await runMirror(mirror);
    expect(await kept(id)).toEqual({ hidden: true, deletedAt: null });
  });

  it('keeps, hidden, a comment with an open report', async () => {
    clear();
    const id = await seedDeferred('reported while the post was in flight');
    const [{ id: reportId }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      id,
      reportId,
    ]);
    await runMirror(mirror);
    expect(await kept(id)).toEqual({ hidden: true, deletedAt: null });
  });
});

describe('the reconcile', () => {
  it('finds a site verdict changed on the platform by hand, and the next run re-pushes it', async () => {
    const { comment } = await seed('reconciled');
    expect((await reconcile()).mismatched).toBe(0);
    platform.readback = (items) =>
      items.map((i) => ({
        ...(i as object),
        verdict: { source: 'site', verdict: 'hidden', at: null },
      }));
    expect((await reconcile()).mismatched).toBe(1);
    platform.readback = null;
    await runMirror(mirror);
    expect(verdicts('site')).toEqual([['visible', null]]);
    expect((await mirrorRow(comment.sourceId)).pushedState).toBe('visible');
  });

  it("counts a moderator's hide made on the platform by hand and never answers it", async () => {
    const { comment } = await seed('hidden on the platform');
    platform.readback = (items) =>
      items.map((i) => ({
        ...(i as object),
        verdict: { source: 'moderator', verdict: 'hidden', at: null },
      }));
    const before = fetchFake.mock.calls.length;
    expect((await reconcile()).mismatched).toBe(1);
    platform.readback = null;
    await runMirror(mirror);
    expect(
      fetchFake.mock.calls
        .slice(before)
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    ).toEqual([]);
    expect((await mirrorRow(comment.sourceId)).nextPushAt).toBeNull();
  });

  it('counts a visible comment the platform reads back with no verdict (withheld) as a mismatch, and approves it again', async () => {
    const { comment } = await seed('withheld');
    platform.readback = (items) => items.map((i) => ({ ...(i as object), verdict: null }));
    expect((await reconcile()).mismatched).toBe(1);
    platform.readback = null;
    await runMirror(mirror);
    expect(verdicts('site')).toEqual([
      ['visible', null],
      ['visible', null],
    ]);
    expect((await mirrorRow(comment.sourceId)).pushedState).toBe('visible');
  });
});

describe('the sweep', () => {
  it('re-queues a live comment with no verdict for its current text, up to the cap, and not a scanned one', async () => {
    const { comment } = await seed('never scanned', { scanned: false });
    const scanned = (await seed('scanned', { scanned: false })).comment;
    await q(`UPDATE "CommentV3" SET "updatedAt" = now() - interval '6 minutes'`);
    const hashes = await (
      await import('~/server/services/text-scan/submit')
    ).currentScanContentHashes('CommentV3', [scanned.sourceId]);
    await q(
      `INSERT INTO "EntityModeration"("entityType", "entityId", status, "contentHash") VALUES ('CommentV3', $1, 'Succeeded', $2)`,
      [scanned.sourceId, hashes.get(scanned.sourceId)]
    );
    // Re-queued once it is 5 minutes old; counted for the alert only from 15.
    expect(await sweep()).toMatchObject({ requeued: 1, unscanned: 0 });
    expect((await mirrorRow(comment.sourceId)).scanAttempts).toBe(1);
    expect((await mirrorRow(scanned.sourceId)).scanAttempts).toBe(0);
    await q(`UPDATE "CommentV3" SET "updatedAt" = now() - interval '16 minutes' WHERE id = $1`, [
      comment.sourceId,
    ]);
    expect((await sweep()).unscanned).toBe(1);
    for (let i = 0; i < 5; i++) await mirror.runFpSweep();
    expect((await mirrorRow(comment.sourceId)).scanAttempts).toBe(5);
    expect(await sweep()).toMatchObject({ requeued: 0, capped: 1 });
  });

  it('counts an overdue comment as unscanned while text scan is off for it', async () => {
    await seed('scanning is off', { scanned: false });
    await q(`UPDATE "CommentV3" SET "updatedAt" = now() - interval '16 minutes'`);
    flags.textScan = false;
    try {
      expect((await sweep()).unscanned).toBe(1);
    } finally {
      flags.textScan = true;
    }
  });

  it('counts an overdue comment as unscanned while scanning is on but has no prompt to scan it with', async () => {
    await seed('no prompt', { scanned: false });
    await q(`UPDATE "CommentV3" SET "updatedAt" = now() - interval '16 minutes'`);
    const prompts = await q<{ key: string; content: string }>(
      `DELETE FROM "TextScanPrompt" RETURNING key, content`
    );
    try {
      expect((await sweep()).unscanned).toBe(1);
    } finally {
      for (const p of prompts)
        await q(`INSERT INTO "TextScanPrompt"(key, content) VALUES ($1, $2)`, [p.key, p.content]);
    }
  });

  it('counts a comment scanned at an old text as unscanned, once its text changes', async () => {
    const { comment } = await seed('version one', { scanned: false });
    await q(`UPDATE "CommentV3" SET "updatedAt" = now() - interval '16 minutes'`);
    const submit = await import('~/server/services/text-scan/submit');
    const before = (await submit.currentScanContentHashes('CommentV3', [comment.sourceId])).get(
      comment.sourceId
    );
    await q(
      `INSERT INTO "EntityModeration"("entityType", "entityId", status, "contentHash") VALUES ('CommentV3', $1, 'Succeeded', $2)`,
      [comment.sourceId, before]
    );
    expect((await sweep()).unscanned).toBe(0);
    await q(`UPDATE "CommentV3" SET content = '<p>version two</p>' WHERE id = $1`, [
      comment.sourceId,
    ]);
    expect((await sweep()).unscanned).toBe(1);
  });
});

describe('a scan flag', () => {
  const outcome = (labels: { scam?: boolean; csam?: boolean }) => ({
    scam: { detected: !!labels.scam, reason: 'r' },
    csam: { detected: !!labels.csam, reason: 'r' },
    triggeredLabels: [...(labels.scam ? ['scam'] : []), ...(labels.csam ? ['csam'] : [])],
    nsfwLevel: null,
  });
  const apply = async (
    entityId: number,
    labels: { scam?: boolean; csam?: boolean },
    { noSubject = false } = {}
  ) => {
    const { scamModerationAdapters } = await import('~/server/services/text-scan/scam.adapter');
    const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
    // A model comment has no Feature Pages text profile row here; any subject serves it.
    const subject =
      (await getTextScanProfile('CommentV3')!.load([entityId])).get(entityId) ??
      (await getTextScanProfile('CommentV3')!.load([firstSeeded!])).get(firstSeeded!);
    return scamModerationAdapters.CommentV3.applyTextScan!({
      entityId,
      workflowId: `wf-${entityId}`,
      outcome: outcome(labels),
      subject: noSubject ? undefined : subject,
      textHash: 'h',
    } as never);
  };
  let firstSeeded: number | undefined;
  const hiddenOf = async (id: number) =>
    (await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [id]))[0].hidden;

  it('through the CommentV3 adapter: scam and csam hide a Feature Pages comment, clean does not, a model comment is left alone', async () => {
    const scam = (await seed('a scam link')).comment.sourceId;
    firstSeeded = scam;
    const csam = (await seed('worse')).comment.sourceId;
    const clean = (await seed('fine')).comment.sourceId;
    await q(
      `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model', 1) ON CONFLICT DO NOTHING`
    );
    const [{ id: model }] = await q<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content) VALUES ('model', 1, 2, 'x') RETURNING id`
    );
    dbMock.dbWrite.textScanHold.create.mockResolvedValue({ id: 1 } as never);
    const results = await Promise.allSettled([
      apply(scam, { scam: true }),
      apply(csam, { csam: true }),
      apply(clean, {}),
      apply(model, { scam: true }),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect([
      await hiddenOf(scam),
      await hiddenOf(csam),
      await hiddenOf(clean),
      await hiddenOf(model),
    ]).toEqual([true, true, false, false]);
    await runMirror(mirror);
    const pushed = async (id: number) => (await mirrorRow(id)).pushedState;
    expect(await pushed(scam)).toMatch(/hidden/);
    // Held for the csam queue as well: purged from the platform.
    expect(await pushed(csam)).toBe('mod-removed');
    expect(await pushed(clean)).toBe('visible');
    await q(`DELETE FROM "CommentV3" WHERE id = $1`, [model]);
  });

  it('hides the comment even when the scam account action fails, and the apply still fails', async () => {
    const { comment } = await seed('a scam link');
    firstSeeded = comment.sourceId;
    // With no subject the account action throws on its first read.
    await expect(apply(comment.sourceId, { scam: true }, { noSubject: true })).rejects.toThrow();
    expect(await hiddenOf(comment.sourceId)).toBe(true);
  });

  it('hides a Feature Pages comment and leaves a model comment to the site rules', async () => {
    const { hideFlaggedFpComment } = moderation;
    const { comment } = await seed('a scam link');
    await q(
      `INSERT INTO "CommentTopic"("entityType", "entityId") VALUES ('model', 1) ON CONFLICT DO NOTHING`
    );
    const [{ id: modelComment }] = await q<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content) VALUES ('model', 1, 2, 'x') RETURNING id`
    );
    dbMock.dbWrite.$transaction.mockClear();
    expect(await hideFlaggedFpComment(modelComment)).toBe(false);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    await hideFlaggedFpComment(comment.sourceId);
    const hidden = async (id: number) =>
      (await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [id]))[0]
        .hidden;
    expect(await hidden(comment.sourceId)).toBe(true);
    expect(await hidden(modelComment)).toBe(false);
    await q(`DELETE FROM "CommentV3" WHERE id = $1`, [modelComment]);
  });

  it("a scan finding's report is filed before the comment is hidden", async () => {
    const { comment } = await seed('flagged');
    const hiddenWhenFiled: boolean[] = [];
    await moderation.hideFlaggedFpComment(comment.sourceId, {
      createReport: async () => {
        hiddenWhenFiled.push(
          (
            await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
              comment.sourceId,
            ])
          )[0].hidden
        );
        return { id: 1 };
      },
    });
    expect(hiddenWhenFiled).toEqual([false]);
    expect(
      (
        await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].hidden
    ).toBe(true);
  });

  it('a scan finding whose report fails is hidden all the same, and thrown so the retry files it', async () => {
    const { comment } = await seed('flagged, report down');
    const filed: number[] = [];
    await expect(
      moderation.hideFlaggedFpComment(comment.sourceId, {
        createReport: async () => {
          throw new Error('report path down');
        },
      })
    ).rejects.toThrow('report path down');
    expect(
      (
        await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].hidden
    ).toBe(true);
    await moderation.hideFlaggedFpComment(comment.sourceId, {
      createReport: async ({ id }) => {
        filed.push(id);
        return { id: 1 };
      },
    });
    expect(filed).toEqual([comment.sourceId]);
    expect(
      (
        await q<{ hidden: boolean }>(`SELECT hidden FROM "CommentV3" WHERE id = $1`, [
          comment.sourceId,
        ])
      )[0].hidden
    ).toBe(true);
  });
});

// What the platform ends up showing, by its own rank rule (`decided`), after races and failures.
describe('the platform ends on what civitai decided', () => {
  /** A moderator's hide, as the hide toggle writes it. */
  const setHidden = async (id: number, hidden: boolean) => {
    const { prismaRunner, setCommentFlags } = await import(
      '~/server/services/commentv3/write.service'
    );
    await setCommentFlags(prismaRunner(dbMock.dbWrite as never), [id], { hidden });
  };
  // As the edit path leaves it: new text and time, and the mirror's version bumped. Unless
  // `unscanned`, its rescan then finishes clean.
  const edit = async (id: number, text: string, { unscanned = false } = {}) => {
    await q(`UPDATE "CommentV3" SET content = $2, "updatedAt" = now() WHERE id = $1`, [
      id,
      `<p>${text}</p>`,
    ]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    if (!unscanned) await scanClean(id);
  };
  const rename = (userId: number, username: string) =>
    q(`UPDATE "User" SET username = $2 WHERE id = $1`, [userId, username]);
  /** Seeded with the first post's reply lost: the platform holds it, civitai has no urn. */
  const seedLost = async (text: string, opts?: { userId?: number }) => {
    platform.loseReply = true;
    const { comment } = await seed(text, opts);
    expect(comment.urn).toBeNull();
    return comment.sourceId;
  };
  const minutesUntil = (at: Date | null) => (at ? (+new Date(at) - Date.now()) / 60_000 : null);

  it.each([
    ['answered', false],
    ['lost', true],
  ])('a change marked while a push is in flight keeps the row due (reply %s)', async (_, lose) => {
    platform.down = true;
    const id = (await seed('changed mid-send')).comment.sourceId;
    platform.down = false;
    platform.onPost = async (body) => {
      platform.onPost = null;
      await setHidden(body.sourceId, true);
      await mirror.markChangedFpRows();
      platform.loseReply = lose;
    };
    await runMirror(mirror);
    const row = await mirrorRow(id);
    expect(row.pushAttempts).toBe(0);
    expect(minutesUntil(row.nextPushAt)).toBeLessThanOrEqual(0);
    if (!lose) {
      await runMirror(mirror);
      expect(decided(id)).toBe('hidden');
    }
  });

  it('a lost first-post reply: the resend after a rename gets the urn back', async () => {
    const id = await seedLost('posted, reply lost');
    await rename(AUTHOR, 'renamed');
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ urn: urnOf(id), pushedState: 'visible' });
    expect(posts().map((p) => p.authorName)).toEqual(['author', 'renamed']);
  });

  it('a lost first-post reply on a comment hidden since: nothing sent, retried hourly, counted stuck', async () => {
    const id = await seedLost('posted, reply lost, then hidden');
    await setHidden(id, true);
    const before = fetchFake.mock.calls.length;
    await runMirror(mirror);
    expect(
      fetchFake.mock.calls.slice(before).filter(([u]) => String(u).startsWith(SIGNER))
    ).toEqual([]);
    const row = await mirrorRow(id);
    expect(row.pushAttempts).toBeGreaterThanOrEqual(mirror.FP_MAX_PUSH_ATTEMPTS);
    expect(minutesUntil(row.nextPushAt)).toBeGreaterThan(55);
  });

  it('a lost first-post reply on a retracted or removed comment: the retract by sourceId finds the urn, a removal follows', async () => {
    const a = await seedLost('retracted');
    const b = await seedLost('removed by a moderator');
    await dbMock.dbWrite.$transaction((tx: never) =>
      moderation.deleteCommentsV3(tx, [a], 'author' as never)
    );
    await dbMock.dbWrite.$transaction((tx: never) => moderation.deleteCommentsV3(tx, [b]));
    await runMirror(mirror);
    await runMirror(mirror);
    expect(
      platform.posts
        .filter((p) => p.text === null)
        .map((p) => p.sourceId)
        .sort()
    ).toEqual([a, b].sort());
    expect(await mirrorRow(a)).toMatchObject({ urn: urnOf(a), pushedState: 'retracted' });
    expect(await mirrorRow(b)).toMatchObject({ urn: urnOf(b), pushedState: 'mod-removed' });
    expect(verdicts('mod')).toEqual([['removed', null]]);
  });

  it('renamed A, B, then A again: three posts, the third not a replay of the first', async () => {
    const id = (await seed('renamed twice')).comment.sourceId;
    await rename(AUTHOR, 'B');
    await runMirror(mirror);
    await rename(AUTHOR, 'author');
    await runMirror(mirror);
    expect(posts().map((p) => p.authorName)).toEqual(['author', 'B', 'author']);
    expect(platform.versions.get(id)).toBe(3);
  });

  it('at the attempt cap a hide keeps retrying hourly and a post gives up', async () => {
    const hidden = (await seed('hide keeps going')).comment.sourceId;
    platform.down = true;
    const shown = (await seed('post gives up', { userId: OTHER })).comment.sourceId;
    await setHidden(hidden, true);
    await mirror.markChangedFpRows();
    await q(`UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 19`);
    await runMirror(mirror);
    const h = await mirrorRow(hidden);
    expect(h.pushAttempts).toBe(mirror.FP_MAX_PUSH_ATTEMPTS);
    expect(minutesUntil(h.nextPushAt)).toBeGreaterThan(55);
    expect((await mirrorRow(shown)).nextPushAt).toBeNull();
    platform.down = false;
    await runMirror(mirror);
    expect(posts().filter((p) => p.sourceId === shown)).toEqual([]);
    expect(await mirrorRow(shown)).toMatchObject({ nextPushAt: null, pushAttempts: 20 });
  });

  it('a reply waits for its parent without spending attempts, and is posted after it', async () => {
    platform.down = true;
    const parent = (await seed('the parent')).comment.sourceId;
    const [{ id: reply }] = await q<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content, "parentId")
       SELECT "entityType", "entityId", $2, '<p>the reply</p>', id FROM "CommentV3" WHERE id = $1
       RETURNING id`,
      [parent, OTHER]
    );
    await q(
      `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", "nextPushAt")
       VALUES ($1, $2, 'reply-1', now())`,
      [reply, OTHER]
    );
    await scanClean(reply);
    // The parent's author is banned, so the parent is not posted yet.
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    platform.down = false;
    try {
      for (let i = 0; i < 3; i++) await runMirror(mirror);
      expect(posts()).toEqual([]);
      expect((await mirrorRow(reply)).pushAttempts).toBe(0);
    } finally {
      await q(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [AUTHOR]);
    }
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now()`);
    await runMirror(mirror);
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = $1`, [
      reply,
    ]);
    await runMirror(mirror);
    expect(posts().map((p) => p.sourceId)).toEqual([parent, reply]);
  });

  it('a row hidden while an earlier row of the same run is sent is never posted', async () => {
    platform.down = true;
    const a = (await seed('first of the batch')).comment.sourceId;
    const b = (await seed('second of the batch')).comment.sourceId;
    platform.down = false;
    platform.onPost = async (body) => {
      platform.onPost = null;
      await setHidden(body.sourceId === a ? b : a, true);
    };
    await runMirror(mirror);
    expect(posts()).toHaveLength(1);
  });

  it("a banned author's unposted comment is not posted until the ban is lifted", async () => {
    platform.down = true;
    const id = (await seed('posted, then banned')).comment.sourceId;
    platform.down = false;
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    await runMirror(mirror);
    expect(posts()).toEqual([]);
    await q(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [AUTHOR]);
    await runMirror(mirror);
    expect(posts().map((p) => p.sourceId)).toEqual([id]);
  });

  it('an edit over the platform limit takes the old text down, counted; a shorter one shows again', async () => {
    const id = (await seed('short')).comment.sourceId;
    await edit(id, 'x'.repeat(4001));
    await runMirror(mirror);
    expect(decided(id)).toBe('hidden');
    expect(posts()).toHaveLength(1);
    expect((await mirrorRow(id)).pushAttempts).toBeGreaterThanOrEqual(mirror.FP_MAX_PUSH_ATTEMPTS);
    await edit(id, 'short again');
    await runMirror(mirror);
    expect(decided(id)).toBe('visible');
    expect(posts().at(-1)?.text).toBe('short again');
  });

  it('a retract by an author with an all-digit name still takes the text down', async () => {
    await rename(AUTHOR, '12345');
    const id = (await seed('then deleted')).comment.sourceId;
    await q(`UPDATE "User" SET username = 'author' WHERE id = $1`, [AUTHOR]);
    await runMirror(mirror);
    await rename(AUTHOR, '12345');
    await q(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "goneCause" = 'author', "goneAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect((await mirrorRow(id)).pushedState).toBe('retracted');
    expect(platform.posts.at(-1)).toMatchObject({ text: null, authorName: '[deleted]' });
  });

  describe('a feature subject the platform does not hold yet', () => {
    const seedFeature = (text: string) => seed(text, { subject: FEATURE });

    it('waits past the cap, uncounted as stuck, and posts the current text once when it is there', async () => {
      const id = (await seedFeature('about a feature')).comment.sourceId;
      expect(posts()).toEqual([]);
      await runMirror(mirror);
      await q(`UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 25`);
      await runMirror(mirror);
      const row = await mirrorRow(id);
      expect(row.pushAttempts).toBe(26);
      expect(row.nextPushAt).not.toBeNull();
      expect(row.postAttemptedAt).toBeNull();
      expect(await sweep()).toMatchObject({ stuck: 0, subjectWaiting: 1 });
      await edit(id, 'edited while waiting');
      platform.features.add(FEATURE);
      await runMirror(mirror);
      await runMirror(mirror);
      expect(posts().map((p) => p.text)).toEqual(['edited while waiting']);
      expect(await sweep()).toMatchObject({ subjectWaiting: 0 });
      expect(await q(`SELECT 1 FROM "CommentV3" WHERE id = $1`, [id])).toHaveLength(1);
    });

    it.each([['hidden'], ['deleted'], ['banned']])(
      '%s while waiting: nothing posted, nothing left due, never deleted for it',
      async (what) => {
        const id = (await seedFeature('about a feature')).comment.sourceId;
        if (what === 'hidden') await setHidden(id, true);
        if (what === 'banned')
          await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
        if (what === 'deleted') {
          await q(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = $1`, [id]);
          await q(
            `UPDATE "FeaturePageCommentMirror" SET "goneCause" = 'author', "goneAt" = now() WHERE "commentId" = $1`,
            [id]
          );
        }
        platform.features.add(FEATURE);
        await runMirror(mirror);
        await runMirror(mirror);
        expect(posts()).toEqual([]);
        if (what !== 'banned') expect((await mirrorRow(id)).nextPushAt).toBeNull();
        expect(await q(`SELECT 1 FROM "CommentV3" WHERE id = $1`, [id])).toHaveLength(1);
        await q(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [AUTHOR]);
      }
    );
  });

  it('a urn another row already holds: the row parked and counted stuck, not sent again', async () => {
    const a = (await seed('holds the urn')).comment.sourceId;
    platform.down = true;
    const b = (await seed('wants the same urn')).comment.sourceId;
    platform.down = false;
    await q(`UPDATE "FeaturePageCommentMirror" SET urn = $2 WHERE "commentId" = $1`, [a, urnOf(b)]);
    await runMirror(mirror);
    expect(await mirrorRow(b)).toMatchObject({ urn: null, nextPushAt: null });
    expect((await mirrorRow(b)).pushAttempts).toBeGreaterThanOrEqual(mirror.FP_MAX_PUSH_ATTEMPTS);
    const calls = fetchFake.mock.calls.length;
    await runMirror(mirror);
    expect(fetchFake.mock.calls.length).toBe(calls);
  });

  /** Every /internal/comment body sent, landed or not. */
  const sentComments = () =>
    fetchFake.mock.calls
      .filter(([u]) => String(u).endsWith('/internal/comment'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, any>);

  it("a text post carries its content's time: a resend keeps `at` and the key, an edit moves both", async () => {
    const id = (await seed('timed')).comment.sourceId;
    const { contentAt } = await mirrorRow(id);
    expect(sentComments()[0].at).toBe(new Date(contentAt).toISOString());
    // A resend whose reply is lost, then its retry.
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "pushedDigest" = 'behind' WHERE "commentId" = $1`,
      [id]
    );
    platform.loseReply = true;
    await runMirror(mirror);
    await runMirror(mirror);
    const [first, lost, retry] = sentComments();
    expect([lost.at, retry.at]).toEqual([first.at, first.at]);
    expect(retry.idempotencyKey).toBe(lost.idempotencyKey);
    await edit(id, 'edited');
    await runMirror(mirror);
    const edited = sentComments().at(-1)!;
    expect(edited.at > first.at).toBe(true);
    expect(edited.idempotencyKey).not.toBe(retry.idempotencyKey);
  });

  it('a retract carries the time the comment was taken away', async () => {
    const id = (await seed('retracted')).comment.sourceId;
    await dbMock.dbWrite.$transaction((tx: never) =>
      moderation.deleteCommentsV3(tx, [id], 'author' as never)
    );
    await runMirror(mirror);
    const retract = platform.posts.find((p) => p.text === null)!;
    expect(retract.at).toBe(new Date((await mirrorRow(id)).goneAt).toISOString());
  });

  it('a post refused after an earlier send that may have landed: never refused, kept due and counted', async () => {
    platform.down = true;
    const id = (await seed('may have landed', { subject: UNKNOWN })).comment.sourceId;
    platform.down = false;
    await runMirror(mirror);
    expect(
      await q(`SELECT 1 FROM "CommentV3" WHERE id = $1 AND "deletedAt" IS NULL`, [id])
    ).toHaveLength(1);
    const row = await mirrorRow(id);
    expect(row).toMatchObject({ goneCause: null, pushedState: null });
    expect(row.nextPushAt).not.toBeNull();
    expect(row.subjectMissingAt).not.toBeNull();
  });

  it("an ordinary retract stores the platform's new token", async () => {
    const id = (await seed('to retract')).comment.sourceId;
    await dbMock.dbWrite.$transaction((tx: never) =>
      moderation.deleteCommentsV3(tx, [id], 'author' as never)
    );
    await runMirror(mirror);
    expect((await mirrorRow(id)).platformDigest).toBe(`sha256:${id}:${platform.versions.get(id)}`);
  });

  it('a name taken down, then renamed back to the name last posted: posted and shown again at once', async () => {
    const id = (await seed('named')).comment.sourceId;
    await rename(AUTHOR, '12345');
    await runMirror(mirror);
    expect(decided(id)).toBe('hidden');
    await rename(AUTHOR, 'author');
    // Not forced due: the rename back alone must make it due.
    await mirror.runFpMirror();
    expect(decided(id)).toBe('visible');
  });

  it('a reply whose parent never reaches the platform is counted stuck once old', async () => {
    platform.down = true;
    const parent = (await seed('the parent')).comment.sourceId;
    const [{ id: reply }] = await q<{ id: number }>(
      `INSERT INTO "CommentV3"("entityType", "entityId", "userId", content, "parentId", "createdAt")
       SELECT "entityType", "entityId", $2, '<p>the reply</p>', id, now() - interval '2 hours'
       FROM "CommentV3" WHERE id = $1 RETURNING id`,
      [parent, OTHER]
    );
    await q(
      `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", "nextPushAt")
       VALUES ($1, $2, 'reply-old', now())`,
      [reply, OTHER]
    );
    await scanClean(reply);
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    platform.down = false;
    try {
      await runMirror(mirror);
      expect(posts()).toEqual([]);
      expect((await mirrorRow(reply)).pushAttempts).toBeGreaterThanOrEqual(
        mirror.FP_MAX_PUSH_ATTEMPTS
      );
    } finally {
      await q(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [AUTHOR]);
    }
  });

  it('a removal after a lost first post is recorded before it is sent: a lost reply, then the hold dismissed, posts nothing', async () => {
    const id = await seedLost('held, first reply lost');
    await q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [id]
    );
    platform.loseReply = true;
    await runMirror(mirror);
    expect((await mirrorRow(id)).removeWantedAt).not.toBeNull();
    const sent = posts().length;
    await q(`DELETE FROM "TextScanHold"`);
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now()`);
    await runMirror(mirror);
    expect(posts()).toHaveLength(sent);
    expect(platform.tokenSite.get(`sha256:${id}:${platform.versions.get(id)}`)).not.toBe('visible');
  });

  it('a lost first post whose retract the platform answers stale is not recorded retracted', async () => {
    const id = await seedLost('retracted, answered stale');
    await dbMock.dbWrite.$transaction((tx: never) =>
      moderation.deleteCommentsV3(tx, [id], 'author' as never)
    );
    platform.lastAt.set(id, '9999-01-01T00:00:00.000Z');
    await runMirror(mirror);
    const row = await mirrorRow(id);
    expect(row.pushedState).not.toBe('retracted');
    expect(row.pushAttempts).toBeGreaterThanOrEqual(mirror.FP_MAX_PUSH_ATTEMPTS);
  });

  it('an edit is not sent until a finished scan of its new text is clean, then the new text goes', async () => {
    const id = (await seed('first words')).comment.sourceId;
    await edit(id, 'second words', { unscanned: true });
    await runMirror(mirror);
    expect(posts().map((p) => p.text)).toEqual(['first words']);
    await scanClean(id);
    await runMirror(mirror);
    expect(posts().map((p) => p.text)).toEqual(['first words', 'second words']);
  });

  it('a failed scan of the current text is not clean: nothing is sent, retried on the hourly wait', async () => {
    const id = (await seed('scan failed', { scanned: false })).comment.sourceId;
    await scanClean(id);
    await q(
      `UPDATE "EntityModeration" SET status = 'Failed' WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(posts()).toEqual([]);
    const next = (await mirrorRow(id)).nextPushAt as Date;
    expect(+new Date(next) - Date.now()).toBeGreaterThan(55 * 60_000);
  });

  it('a scan still in flight for the current text is not a verdict: nothing is sent', async () => {
    const id = (await seed('being scanned', { scanned: false })).comment.sourceId;
    await scanClean(id);
    await q(
      `UPDATE "EntityModeration" SET status = 'Pending' WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(posts()).toEqual([]);
  });

  it('a finished scan that flagged the text is never a clean verdict: nothing is sent', async () => {
    const id = (await seed('flagged words', { scanned: false })).comment.sourceId;
    await scanClean(id);
    await q(
      `UPDATE "EntityModeration" SET "triggeredLabels" = '{scam}' WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(posts()).toEqual([]);
    // Finished, so not polled every minute: retried on the hourly wait.
    const next = (await mirrorRow(id)).nextPushAt as Date;
    expect(+new Date(next) - Date.now()).toBeGreaterThan(55 * 60_000);
  });

  it('a post the platform answers stale is not recorded as pushed, so its text goes again', async () => {
    const id = (await seed('overtaken')).comment.sourceId;
    platform.lastAt.set(id, '9999-01-01T00:00:00.000Z');
    await rename(AUTHOR, 'renamed');
    await runMirror(mirror);
    expect((await mirrorRow(id)).pushedDigest).toBeNull();
  });

  it('an author the platform has erased: recorded erased, nothing sent after', async () => {
    const id = (await seed('erased upstream')).comment.sourceId;
    platform.erasedUids.add(AUTHOR);
    await rename(AUTHOR, 'renamed');
    await runMirror(mirror);
    expect((await mirrorRow(id)).pushedState).toBe('erased');
    const calls = fetchFake.mock.calls.length;
    await rename(AUTHOR, 'again');
    await runMirror(mirror);
    expect(fetchFake.mock.calls.length).toBe(calls);
  });

  it('a repost the platform answers unchanged wrote no site verdict, so one is sent', async () => {
    const id = (await seed('already there')).comment.sourceId;
    // The platform holds this text under a site hide whose push civitai has no record of.
    platform.verdicts.push({
      path: '/internal/verdict/site',
      body: {
        target: { urn: urnOf(id), digest: (await mirrorRow(id)).platformDigest },
        verdict: 'hidden',
      },
    });
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "pushedDigest" = 'behind' WHERE "commentId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(decided(id)).toBe('visible');
  });

  it('a first post that lands held is lifted', async () => {
    platform.holdPosts = true;
    const id = (await seed('held on arrival')).comment.sourceId;
    expect(decided(id)).toBe('visible');
    expect(verdicts('site')).toEqual([['visible', null]]);
  });

  it('a failed push backs off when the row was stamped to the microsecond, as on Postgres', async () => {
    platform.down = true;
    const id = (await seed('stamped')).comment.sourceId;
    await runMirror(mirror);
    const before = (await mirrorRow(id)).pushAttempts;
    // PGlite's now() stops at milliseconds; the real column keeps microseconds.
    await q(
      `UPDATE "FeaturePageCommentMirror"
       SET "updatedAt" = date_trunc('milliseconds', now()) + interval '123 microseconds',
           "nextPushAt" = now()
       WHERE "commentId" = $1`,
      [id]
    );
    await mirror.runFpMirror();
    const row = await mirrorRow(id);
    expect(row.pushAttempts).toBe(before + 1);
    expect(minutesUntil(row.nextPushAt)).toBeGreaterThan(0);
  });

  it('the hide-all runbook refuses while the mirror is on, and removes hidden comments too', async () => {
    const shown = (await seed('shown')).comment.sourceId;
    const hidden = (await seed('hidden')).comment.sourceId;
    // Refused: the platform wrote nothing, so nothing of it can remain there.
    await seed('refused', { subject: UNKNOWN });
    await setHidden(hidden, true);
    await runMirror(mirror);
    await expect(mirror.hideAllFpComments({ execute: true })).rejects.toThrow();
    flags.mirror = false;
    platform.readback = (items) =>
      items.filter((i) => (i as { urn: string }).urn !== urnOf(hidden));
    expect(await mirror.hideAllFpComments({ execute: true })).toMatchObject({
      targets: 2,
      removed: 2,
      remaining: 0,
    });
    expect(
      platform.verdicts.filter((v) => v.body.verdict === 'removed').map((v) => v.body.target.urn)
    ).toEqual([urnOf(shown), urnOf(hidden)]);
  });
});

describe('a csam hold the queue confirmed, with a clean verdict since', () => {
  const hold = (id: number, status: 'Confirmed' | 'Dismissed') =>
    q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', $2)`,
      [id, status]
    );
  beforeEach(() => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
  });
  const flagsOf = async (id: number) =>
    (
      await q<{ hidden: boolean; tosViolation: boolean; deletedAt: Date | null }>(
        `SELECT hidden, "tosViolation", "deletedAt" FROM "CommentV3" WHERE id = $1`,
        [id]
      )
    )[0];

  it.each([['Confirmed'], ['Dismissed']] as const)(
    '%s: the ToS clear clears none, counted held',
    async (status) => {
      const id = (await seed('flagged for ToS')).comment.sourceId;
      await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [id]);
      await hold(id, status);
      expect(await moderation.bulkClearCommentV3TosViolation({ ids: [id] })).toMatchObject({
        count: 0,
        held: 1,
        failed: 0,
      });
      expect((await flagsOf(id)).tosViolation).toBe(true);
    }
  );

  it.each([['Confirmed'], ['Dismissed']] as const)(
    '%s: restoring a scam case shows none, counted skipped',
    async (status) => {
      const id = (await seed('hidden by a scam cleanup')).comment.sourceId;
      // As the cleanup hides: stamped with the record's time.
      const cleanedAt = new Date();
      await q(`UPDATE "CommentV3" SET hidden = true, "hiddenAt" = $2 WHERE id = $1`, [
        id,
        cleanedAt,
      ]);
      await hold(id, status);
      dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
        userId: AUTHOR,
        type: 'scam',
        triggers: [
          {
            entityType: 'CommentV3',
            cleanup: { kind: 'comments', at: cleanedAt.toISOString(), count: 1, ids: [id] },
          },
        ],
      } as never);
      const { restoreScamCase } = await import('~/server/services/scam-cleanup.service');
      expect(await restoreScamCase(1)).toEqual({ restored: 0, skipped: 1 });
      expect((await flagsOf(id)).hidden).toBe(true);
    }
  );

  it.each([
    ['Confirmed', { hidden: true, deletedAt: null }],
    ['Dismissed', undefined],
  ] as const)(
    '%s: a refusal from the platform keeps it, hidden, or deletes it',
    async (status, kept) => {
      const id = (await seed('refused while held')).comment.sourceId;
      await hold(id, status);
      const [{ entityId }] = await q<{ entityId: number }>(
        `SELECT "entityId" FROM "CommentV3" WHERE id = $1`,
        [id]
      );
      await mirror.refuseFpComment(id, entityId);
      if (kept) expect(await flagsOf(id)).toMatchObject(kept);
      else expect(await flagsOf(id)).toBeUndefined();
    }
  );
});

// The hide state: a hidden Feature Pages comment stays hidden, and what the mirror owes the platform
// is delivered first and settles once.
describe('the hide state', () => {
  const setFlags = async (id: number, f: { hidden?: boolean; tosViolation?: boolean }) => {
    const { prismaRunner, setCommentFlags } = await import(
      '~/server/services/commentv3/write.service'
    );
    return setCommentFlags(prismaRunner(dbMock.dbWrite as never), [id], f);
  };
  const clean = () =>
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: [],
      result: {},
    } as never);
  const restrictedAt = async (id: number) => (await mirrorRow(id)).restrictedAt as Date | null;
  const modVisibleSent = () =>
    platform.verdicts.some(
      (v) => v.path === '/internal/verdict/mod' && v.body.verdict === 'visible'
    );
  const signerPosts = () =>
    fetchFake.mock.calls.filter(
      ([u, init]) =>
        String(u).startsWith(SIGNER) && (init as RequestInit | undefined)?.method === 'POST'
    ).length;
  const edit = async (id: number, text: string) => {
    await q(`UPDATE "CommentV3" SET content = $2, "updatedAt" = now() WHERE id = $1`, [
      id,
      `<p>${text}</p>`,
    ]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now(),
         "nextPushAt" = now(), "pushAttempts" = 0, "pendingDigest" = NULL WHERE "commentId" = $1`,
      [id]
    );
    await scanClean(id);
  };
  const holdOn = (id: number) =>
    q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [id]
    );

  it('an unhide, a ToS clear and a scam-case restore leave it hidden on civitai and the platform', async () => {
    clean();
    const id = (await seed('hidden for good')).comment.sourceId;
    await setFlags(id, { hidden: true });
    await setFlags(id, { tosViolation: true });
    await runMirror(mirror);
    expect(await setFlags(id, { hidden: false })).toEqual([]);
    expect(await moderation.bulkClearCommentV3TosViolation({ ids: [id] })).toMatchObject({
      count: 0,
      held: 1,
    });
    // As the cleanup hides: stamped with the record's time.
    const cleanedAt = new Date();
    await q(`UPDATE "CommentV3" SET "hiddenAt" = $2 WHERE id = $1`, [id, cleanedAt]);
    dbMock.dbWrite.userRestriction.findUnique.mockResolvedValueOnce({
      userId: AUTHOR,
      type: 'scam',
      triggers: [
        {
          entityType: 'CommentV3',
          cleanup: { kind: 'comments', at: cleanedAt.toISOString(), count: 1, ids: [id] },
        },
      ],
    } as never);
    const { restoreScamCase } = await import('~/server/services/scam-cleanup.service');
    expect(await restoreScamCase(1)).toEqual({ restored: 0, skipped: 1 });
    for (let i = 0; i < 3; i++) {
      await runMirror(mirror);
      await reconcile();
    }
    const [flagsNow] = await q<{ hidden: boolean; tosViolation: boolean }>(
      `SELECT hidden, "tosViolation" FROM "CommentV3" WHERE id = $1`,
      [id]
    );
    expect(flagsNow).toEqual({ hidden: true, tosViolation: true });
    expect(decided(id)).toBe('hidden');
    expect(modVisibleSent()).toBe(false);
  });

  it('the never-moderator-visible check sees one when it is sent', async () => {
    const id = (await seed('control')).comment.sourceId;
    expect(modVisibleSent()).toBe(false);
    await fetchFake(`${SIGNER}/internal/verdict/mod`, {
      method: 'POST',
      body: JSON.stringify({ target: { urn: urnOf(id), digest: null }, verdict: 'visible' }),
    });
    expect(modVisibleSent()).toBe(true);
  });

  it('a hide is sent again whenever it is due, whatever was pushed before', async () => {
    const id = (await seed('hidden twice')).comment.sourceId;
    await setFlags(id, { hidden: true });
    await runMirror(mirror);
    await setFlags(id, { tosViolation: true });
    await runMirror(mirror);
    expect(verdicts('mod')).toEqual([
      ['hidden', null],
      ['hidden', null],
    ]);
  });

  it('a feature subject wait never gives up: one failure of each kind past the cap, then exactly one post', async () => {
    const id = (await seed('about a feature', { subject: FEATURE })).comment.sourceId;
    await runMirror(mirror);
    await q(`UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 25`);
    platform.features.add(FEATURE);
    for (const failure of ['429', '5xx', 'timeout', 'bad', 'stale'] as const) {
      platform.failNext = [failure];
      await runMirror(mirror);
      const row = await mirrorRow(id);
      expect(row.nextPushAt, failure).not.toBeNull();
      expect(row.subjectMissingAt, failure).not.toBeNull();
    }
    await runMirror(mirror);
    await runMirror(mirror);
    expect(posts().filter((p) => p.sourceId === id)).toHaveLength(1);
    expect((await mirrorRow(id)).pushedState).toBe('visible');
  });

  it('a rate-limited push spends no attempt', async () => {
    platform.down = true;
    const id = (await seed('rate limited')).comment.sourceId;
    platform.down = false;
    await mirror.markChangedFpRows();
    const before = (await mirrorRow(id)).pushAttempts;
    platform.failNext = ['429'];
    await runMirror(mirror);
    expect((await mirrorRow(id)).pushAttempts).toBe(before);
    // Control: a server error spends one.
    platform.failNext = ['5xx'];
    await runMirror(mirror);
    expect((await mirrorRow(id)).pushAttempts).toBe(before + 1);
  });

  it('the owed-restriction clock starts at the hide and does not move through a backoff, an edit or a rename', async () => {
    const id = (await seed('owed')).comment.sourceId;
    await setFlags(id, { hidden: true });
    const t0 = await restrictedAt(id);
    expect(t0).not.toBeNull();
    platform.down = true;
    await runMirror(mirror);
    await edit(id, 'edited while owed');
    await q(`UPDATE "User" SET username = 'renamed' WHERE id = $1`, [AUTHOR]);
    await mirror.markChangedFpRows();
    await runMirror(mirror);
    expect(await restrictedAt(id)).toEqual(t0);
    platform.down = false;
    await runMirror(mirror);
    expect(await restrictedAt(id)).toBeNull();
  });

  it("a hold's mark keeps its backoff; dismissed before anything was sent, the clock stops", async () => {
    flags.mirror = false;
    const id = (await seed('held, then dismissed')).comment.sourceId;
    await holdOn(id);
    await mirror.runFpMirror();
    const marked = await mirrorRow(id);
    expect(marked.restrictedAt).not.toBeNull();
    expect(marked.pendingDigest).not.toBeNull();
    // A failed push's backoff: the next dirty pass leaves it.
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 2, "nextPushAt" = now() + interval '5 minutes' WHERE "commentId" = $1`,
      [id]
    );
    await mirror.markChangedFpRows();
    expect((await mirrorRow(id)).pushAttempts).toBe(2);
    await q(`DELETE FROM "TextScanHold"`);
    await mirror.markChangedFpRows();
    expect(await restrictedAt(id)).toBeNull();
  });

  it('while braked the dirty pass still marks, sends nothing, and the sweep counts an owed restriction', async () => {
    const id = (await seed('braked')).comment.sourceId;
    flags.mirror = false;
    const before = signerPosts();
    await setFlags(id, { hidden: true });
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "restrictedAt" = NULL, "nextPushAt" = NULL, "pendingDigest" = NULL`
    );
    expect(await mirror.runFpMirror()).toMatchObject({ on: false, marked: 1 });
    expect(signerPosts()).toBe(before);
    expect((await sweep()).restrictionsOverdue).toBe(0);
    await q(`UPDATE "FeaturePageCommentMirror" SET "restrictedAt" = now() - interval '20 minutes'`);
    expect((await sweep()).restrictionsOverdue).toBe(1);
  });

  it('a refusal kept as evidence and an erased author owe nothing more', async () => {
    clean();
    platform.down = true;
    const refused = (await seed('refused, reported', { subject: UNKNOWN })).comment.sourceId;
    const erased = (await seed('erased', { userId: OTHER })).comment.sourceId;
    platform.down = false;
    await neverSent(refused);
    const [{ id: reportId }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status) VALUES ('Pending') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      refused,
      reportId,
    ]);
    await setFlags(erased, { hidden: true });
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
    await runMirror(mirror);
    for (const id of [refused, erased])
      expect(await mirrorRow(id)).toMatchObject({ restrictedAt: null, nextPushAt: null });
    expect((await mirrorRow(refused)).goneCause).toBe('refused');
  });

  it('a retract the platform answers stale wrote nothing, so it is not recorded', async () => {
    const id = (await seed('retracted late')).comment.sourceId;
    platform.lastAt.set(id, '9999-01-01T00:00:00.000Z');
    await q(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "goneCause" = 'author', "goneAt" = now(), "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ pushedState: 'visible', pushAttempts: 1 });
  });

  it("a takedown on a token the platform has replaced is sent again on the platform's token", async () => {
    const id = (await seed('short')).comment.sourceId;
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "platformDigest" = 'old' WHERE "commentId" = $1`,
      [id]
    );
    await edit(id, 'x'.repeat(4001));
    await runMirror(mirror);
    expect(verdicts('site').at(-1)).toEqual(['hidden', null]);
    expect(decided(id)).toBe('hidden');
  });

  it('a post by an author whose name the platform refuses is held back, counted, and posted once renamed', async () => {
    await q(`UPDATE "User" SET username = '12345' WHERE id = $1`, [AUTHOR]);
    platform.down = true;
    const id = (await seed('numbered')).comment.sourceId;
    platform.down = false;
    await runMirror(mirror);
    expect(posts()).toEqual([]);
    expect((await mirrorRow(id)).pushAttempts).toBeGreaterThanOrEqual(mirror.FP_MAX_PUSH_ATTEMPTS);
    await q(`UPDATE "User" SET username = 'author' WHERE id = $1`, [AUTHOR]);
    await mirror.markChangedFpRows();
    await runMirror(mirror);
    expect(posts().map((p) => p.sourceId)).toEqual([id]);
  });

  it('an approval on a token the platform has replaced is never retried on it: the text is posted again first', async () => {
    const id = (await seed('approved later')).comment.sourceId;
    const sitesBefore = verdicts('site').length;
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "platformDigest" = 'old', "pushedState" = NULL, "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await mirror.runFpMirror();
    expect(verdicts('site')).toHaveLength(sitesBefore);
    expect((await mirrorRow(id)).pushedDigest).toBeNull();
    const textSends = () =>
      fetchFake.mock.calls.filter(([u]) => String(u).endsWith('/internal/comment')).length;
    const before = textSends();
    await runMirror(mirror);
    expect(textSends()).toBe(before + 1);
    expect(verdicts('site')).toHaveLength(sitesBefore + 1);
    expect(decided(id)).toBe('visible');
  });

  it('a retract the platform answers removed is complete: recorded retracted, nothing left due', async () => {
    const id = (await seed('removed, then retracted')).comment.sourceId;
    platform.removed.add(id);
    await q(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "goneCause" = 'author', "goneAt" = now(), "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ pushedState: 'retracted', nextPushAt: null });
  });

  it('a removal whose reply is lost stays a removal after civitai clears the hold', async () => {
    const id = (await seed('held, reply lost')).comment.sourceId;
    await holdOn(id);
    platform.loseReply = true;
    await mirror.markChangedFpRows();
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).removeWantedAt).not.toBeNull();
    await q(`DELETE FROM "TextScanHold"`);
    await mirror.markChangedFpRows();
    await runMirror(mirror);
    expect(verdicts('mod').map(([v]) => v)).toEqual(['removed', 'removed']);
    expect(verdicts('site')).toEqual([['visible', null]]);
  });

  it('the hide-all runbook leaves an erased author due for the erase, recording nothing', async () => {
    const id = (await seed('author deleted', { userId: OTHER })).comment.sourceId;
    flags.mirror = false;
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
    platform.readback = () => [];
    await mirror.hideAllFpComments({ execute: true });
    platform.readback = null;
    const row = await mirrorRow(id);
    expect(row.pushedState).not.toBe('erased');
    expect(row.nextPushAt).not.toBeNull();
    flags.mirror = true;
    await runMirror(mirror);
    expect(platform.erased).toEqual([OTHER]);
  });

  describe('the reconcile, by what the comment should hold and what the platform shows', () => {
    const readback = (id: number, item: Record<string, unknown>) =>
      (platform.readback = (items) =>
        items.map((i) =>
          (i as { urn: string }).urn === urnOf(id) ? { ...(i as object), ...item } : i
        ));

    it('hidden here, visible there: the hide is owed and sent again', async () => {
      const id = (await seed('hidden here')).comment.sourceId;
      await setFlags(id, { hidden: true });
      await runMirror(mirror);
      readback(id, { verdict: { source: 'site', verdict: 'visible', at: null } });
      expect((await reconcile()).mismatched).toBe(1);
      platform.readback = null;
      expect(await restrictedAt(id)).not.toBeNull();
      await runMirror(mirror);
      expect(verdicts('mod')).toEqual([
        ['hidden', null],
        ['hidden', null],
      ]);
    });

    it('removed there while shown here: recorded removed, then nothing more', async () => {
      const id = (await seed('removed there')).comment.sourceId;
      platform.removed.add(id);
      expect((await reconcile()).mismatched).toBe(1);
      expect((await mirrorRow(id)).removeWantedAt).not.toBeNull();
      const before = signerPosts();
      for (let i = 0; i < 30; i++) {
        await mirror.runFpMirror();
        await reconcile();
      }
      expect(signerPosts() - before).toBeLessThanOrEqual(1);
      expect((await reconcile()).mismatched).toBe(0);
      expect((await mirrorRow(id)).pushedState).toBe('mod-removed');
    });

    it('a visible comment whose token moved: the text is posted again', async () => {
      const id = (await seed('token moved')).comment.sourceId;
      const textSends = () =>
        fetchFake.mock.calls.filter(([u]) => String(u).endsWith('/internal/comment')).length;
      readback(id, { digest: 'someone-else' });
      expect((await reconcile()).mismatched).toBe(1);
      platform.readback = null;
      const before = textSends();
      await runMirror(mirror);
      expect(textSends()).toBe(before + 1);
    });

    it('shown here, retracted there with a moved token: counted, its text never sent again', async () => {
      const id = (await seed('retracted there')).comment.sourceId;
      readback(id, { retracted: true, digest: 'moved' });
      expect((await reconcile()).mismatched).toBe(1);
      platform.readback = null;
      expect((await mirrorRow(id)).nextPushAt).toBeNull();
    });

    it('erased here, its text still there: the erase is sent again', async () => {
      const id = (await seed('erased, still there', { userId: OTHER })).comment.sourceId;
      await q(
        `UPDATE "FeaturePageCommentMirror" SET "pushedState" = 'erased', "nextPushAt" = NULL WHERE "commentId" = $1`,
        [id]
      );
      await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
      expect((await reconcile()).mismatched).toBe(1);
      await runMirror(mirror);
      expect(platform.erased).toEqual([OTHER]);
    });

    it('erased here, nothing there: nothing', async () => {
      const id = (await seed('erased, gone', { userId: OTHER })).comment.sourceId;
      await q(
        `UPDATE "FeaturePageCommentMirror" SET "pushedState" = 'erased', "nextPushAt" = NULL WHERE "commentId" = $1`,
        [id]
      );
      await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
      readback(id, { removed: true });
      expect((await reconcile()).mismatched).toBe(0);
    });

    it('braked, it still reads and counts a mismatch, and marks nothing', async () => {
      const id = (await seed('hidden while braked')).comment.sourceId;
      flags.mirror = false;
      await setFlags(id, { hidden: true });
      await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = NULL WHERE "commentId" = $1`, [
        id,
      ]);
      expect(await reconcile()).toMatchObject({ on: false, mismatched: 1 });
      expect((await mirrorRow(id)).nextPushAt).toBeNull();
    });

    it('hidden or gone here, only the token differs there: nothing', async () => {
      const id = (await seed('hidden, tombstoned')).comment.sourceId;
      await setFlags(id, { hidden: true });
      await runMirror(mirror);
      readback(id, { digest: 'tombstone' });
      expect((await reconcile()).mismatched).toBe(0);
    });
  });

  describe('each settles: at most one send over 30 passes and 30 reconciles', () => {
    const converge = async () => {
      const before = signerPosts();
      for (let i = 0; i < 30; i++) {
        await mirror.runFpMirror();
        await reconcile();
      }
      return signerPosts() - before;
    };

    it('an edit the platform answers 409 removed', async () => {
      const id = (await seed('removed there')).comment.sourceId;
      platform.removed.add(id);
      await edit(id, 'too late');
      expect(await converge()).toBeLessThanOrEqual(1);
    });

    it('a refusal kept as evidence', async () => {
      clean();
      platform.down = true;
      const id = (await seed('refused, held', { subject: UNKNOWN })).comment.sourceId;
      platform.down = false;
      await holdOn(id);
      expect(await converge()).toBeLessThanOrEqual(1);
    });

    it('an erased author restored afterwards', async () => {
      const id = (await seed('erased, restored', { userId: OTHER })).comment.sourceId;
      await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
      await mirror.runFpMirror();
      await q(`UPDATE "User" SET "deletedAt" = NULL WHERE id = $1`, [OTHER]);
      expect(await converge()).toBeLessThanOrEqual(1);
      expect((await mirrorRow(id)).pushedState).toBe('erased');
    });

    it('a takedown of text the platform refuses', async () => {
      const id = (await seed('short')).comment.sourceId;
      await edit(id, 'x'.repeat(4001));
      expect(await converge()).toBeLessThanOrEqual(1);
    });
  });

  it('a hide behind 1,000 older pushes leases in the first batch after a requeue, a backoff and an edit, its clock unmoved', async () => {
    const { leaseFpMirrorRows, readFpMirrorFacts, recordFpPush } = await import(
      '@civitai/db-queries/feature-page-comments'
    );
    const id = (await seed('behind the backlog')).comment.sourceId;
    await q(
      `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", "nextPushAt")
       SELECT 100000 + g, $1, 'backlog-' || g, now() - interval '1 day' FROM generate_series(1, 1000) g`,
      [OTHER]
    );
    await setFlags(id, { hidden: true });
    const t0 = await restrictedAt(id);
    const kysely = holder.kysely as never;
    const firstBatch = async () => {
      const ids = await leaseFpMirrorRows(kysely, 100);
      await q(`UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = NULL`);
      return ids;
    };
    expect((await firstBatch())[0]).toBe(id);
    // A requeue mid-send: the push's record finds the row changed since it was read.
    const [read] = await readFpMirrorFacts(kysely, [id]);
    await setFlags(id, { tosViolation: true });
    await recordFpPush(kysely, id, {
      readAt: read.mirrorUpdatedAt,
      nextPushAt: null,
      pushAttempts: 0,
    });
    expect((await firstBatch())[0]).toBe(id);
    // A backoff, then due again.
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 3, "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    expect((await firstBatch())[0]).toBe(id);
    await edit(id, 'edited behind the backlog');
    expect((await firstBatch())[0]).toBe(id);
    expect(await restrictedAt(id)).toEqual(t0);
    await q(`DELETE FROM "FeaturePageCommentMirror" WHERE "commentId" > 100000`);
  });
});

// A marker (pendingDigest, restrictedAt) never outlives the want it was written for.
describe('a marker never outlives the want it was written for', () => {
  const holdOn = (id: number) =>
    q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [id]
    );
  const dismiss = () => q(`DELETE FROM "TextScanHold"`);
  /** Held while braked, then dismissed before anything was sent: the clock started and stopped. */
  const heldThenDismissed = async (id: number) => {
    flags.mirror = false;
    await holdOn(id);
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    await dismiss();
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).toBeNull();
  };

  it.each([['a first hold'], ['a hold after a dismissed one']])(
    '%s starts the alert clock',
    async (name) => {
      const id = (await seed('held')).comment.sourceId;
      if (name !== 'a first hold') await heldThenDismissed(id);
      flags.mirror = false;
      await holdOn(id);
      await mirror.runFpMirror();
      expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    }
  );

  it.each([
    ['held once', false, false],
    ['held again by its stored verdict after a rescan', true, false],
    ['held again after a rescan and an edit', true, true],
  ] as const)('%s: the clock runs', async (_, rescan, edited) => {
    const id = (await seed('held by its verdict', { scanned: false })).comment.sourceId;
    flags.mirror = false;
    await q(
      `INSERT INTO "EntityModeration"("entityType", "entityId", status, "triggeredLabels", result)
       VALUES ('CommentV3', $1, 'Succeeded', ARRAY['csam'], '{"textHash":"h1"}')`,
      [id]
    );
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    if (rescan) {
      await q(`UPDATE "EntityModeration" SET status = 'Pending' WHERE "entityId" = $1`, [id]);
      await mirror.runFpMirror();
      expect((await mirrorRow(id)).restrictedAt).toBeNull();
      if (edited)
        await q(
          `UPDATE "FeaturePageCommentMirror" SET "pendingDigest" = NULL, "nextPushAt" = now(), "updatedAt" = now() WHERE "commentId" = $1`,
          [id]
        );
      await q(`UPDATE "EntityModeration" SET status = 'Succeeded' WHERE "entityId" = $1`, [id]);
      await mirror.runFpMirror();
    }
    expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
  });

  it.each([['with no hold before'], ['after a dismissed hold']])(
    'a hold after a visible push gave up is sent, %s',
    async (name) => {
      const id = (await seed('gave up')).comment.sourceId;
      if (name === 'after a dismissed hold') await heldThenDismissed(id);
      else
        await q(
          `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = $1`,
          [id]
        );
      flags.mirror = true;
      platform.down = true;
      for (let i = 0; i < 20; i++) await runMirror(mirror);
      expect(await mirrorRow(id)).toMatchObject({ nextPushAt: null, pushAttempts: 20 });
      platform.down = false;
      await holdOn(id);
      for (let i = 0; i < 30; i++) await runMirror(mirror);
      expect(verdicts('mod').map(([v]) => v)).toEqual(['removed']);
    }
  );

  it.each([['with no hold before'], ['read after a dismissed hold, no dirty pass since']])(
    'a push that gives up keeps its own want as the marker, %s: a later hold is sent',
    async (name) => {
      const id = (await seed('parked')).comment.sourceId;
      if (name !== 'with no hold before') {
        flags.mirror = false;
        await holdOn(id);
        await mirror.runFpMirror();
        await dismiss();
        flags.mirror = true;
      }
      await q(
        `UPDATE "FeaturePageCommentMirror" SET "pushAttempts" = 19, "nextPushAt" = now() WHERE "commentId" = $1`,
        [id]
      );
      platform.down = true;
      await mirror.pushNewFpComment(id);
      platform.down = false;
      expect((await mirrorRow(id)).nextPushAt).toBeNull();
      await holdOn(id);
      for (let i = 0; i < 30; i++) await runMirror(mirror);
      expect(verdicts('mod').map(([v]) => v)).toEqual(['removed']);
    }
  );

  it.each([['the first post answered'], ['the first post reply lost']])(
    "a removal's intent is recorded before its first send, %s",
    async (name) => {
      platform.loseReply = name === 'the first post reply lost';
      const id = (await seed('to remove')).comment.sourceId;
      await holdOn(id);
      platform.loseReply = true;
      await mirror.markChangedFpRows();
      await runMirror(mirror);
      expect(platform.loseReply).toBe(false);
      expect((await mirrorRow(id)).removeWantedAt).not.toBeNull();
    }
  );

  it.each([['removed'], ['erased']])(
    'the reconcile restricts a %s comment whose text the platform still shows',
    async (kind) => {
      const id = (await seed('final', { userId: OTHER })).comment.sourceId;
      if (kind === 'erased')
        await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
      else await holdOn(id);
      await runMirror(mirror);
      await runMirror(mirror);
      expect(await mirrorRow(id)).toMatchObject({ nextPushAt: null, restrictedAt: null });
      platform.readback = (items) =>
        items.map((i) => ({
          ...(i as object),
          retracted: false,
          removed: undefined,
          verdict: { source: 'site', verdict: 'visible', at: null },
        }));
      await reconcile();
      expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    }
  );

  it.each([['the platform down'], ['a urn another row holds']])(
    'a restriction a push could not record stays owed: %s',
    async (name) => {
      platform.loseReply = true;
      const id = (await seed('owed')).comment.sourceId;
      if (name === 'a urn another row holds')
        await q(
          `INSERT INTO "FeaturePageCommentMirror"("commentId", "userId", "requestId", urn) VALUES (999999, $1, 'conflict', $2)`,
          [OTHER, urnOf(id)]
        );
      else platform.down = true;
      await holdOn(id);
      await mirror.markChangedFpRows();
      await runMirror(mirror);
      expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    }
  );

  it('an account deleted while braked, restored, then deleted again: the clock runs again', async () => {
    const id = (await seed('account', { userId: OTHER })).comment.sourceId;
    flags.mirror = false;
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
    await q(`UPDATE "User" SET "deletedAt" = NULL WHERE id = $1`, [OTHER]);
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).toBeNull();
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [OTHER]);
    await mirror.runFpMirror();
    expect((await mirrorRow(id)).restrictedAt).not.toBeNull();
  });
});

describe('the run budget', () => {
  it('a run out of time frees the leases it did not use', async () => {
    platform.down = true;
    const ids: number[] = [];
    for (const text of ['one', 'two', 'three']) ids.push((await seed(text)).comment.sourceId);
    platform.down = false;
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = ANY($1)`,
      [ids]
    );
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    platform.onPost = async () => {
      offset = 10 * 60_000;
    };
    try {
      await mirror.runFpMirror();
    } finally {
      clock.mockRestore();
      platform.onPost = null;
    }
    expect(posts()).toHaveLength(1);
    expect(
      await q(
        `SELECT "commentId" FROM "FeaturePageCommentMirror" WHERE "commentId" = ANY($1) AND "leaseUntil" IS NOT NULL`,
        [ids]
      )
    ).toEqual([]);
  });
});
