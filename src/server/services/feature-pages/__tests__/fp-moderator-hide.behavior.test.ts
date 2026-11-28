import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';
import { liftModeratorFpHide } from '@civitai/db-queries/feature-page-comments';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  bootFpDatabase,
  decided,
  deciding,
  mirrorRow,
  pg,
  pipelineVerdict,
  platform,
  q,
  resetFpState,
  runMirror,
  scanClean,
  seedFpComment,
  verdictAt,
} from '~/server/services/feature-pages/__tests__/fp-harness';

// A moderator's own hide of a Feature Pages comment and its unhide, from the moderator app's
// endpoint to what the platform's decider shows.
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
const flags = vi.hoisted(() => ({ mirror: true }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async (flag: string) =>
    flag === 'feature-pages-mirror' ? flags.mirror : flag === 'text-scan',
}));

const SYSTEM = -1;
const MOD = 1;

let mirror: typeof MirrorService;
let moderation: typeof ModerationService;
beforeAll(async () => {
  await bootFpDatabase(holder);
  await pg.db.exec(`
    ALTER TABLE "Report" ADD COLUMN "userId" int, ADD COLUMN details jsonb,
      ADD COLUMN "statusSetBy" int, ADD COLUMN "statusSetAt" timestamp(3);
    CREATE TABLE "ModActivity"(id serial PRIMARY KEY, "userId" int, activity text NOT NULL,
      "entityType" text, "entityId" int, "createdAt" timestamp NOT NULL DEFAULT now());`);
  mirror = await import('~/server/services/feature-pages/mirror.service');
  moderation = await import('~/server/services/commentv3/moderation.service');
});
afterAll(async () => {
  await pg.db.close();
});
beforeEach(async () => {
  await resetFpState(flags);
  await q(`DELETE FROM "ModActivity"`);
});

const kysely = () => holder.kysely as Kysely<DB>;
const reconcile = () => mirror.runFpReconcile() as Promise<Record<string, unknown>>;
const settle = async () => {
  await runMirror(mirror);
  const counts = await reconcile();
  await runMirror(mirror);
  return counts;
};

/** What the moderator app renders and posts back: the text version and the hide it shows. */
const seen = async (id: number) => {
  const [row] = await q<{ version: number; hiddenAt: string | null; hidden: boolean }>(
    `SELECT m.version, c."hiddenAt"::text AS "hiddenAt", c.hidden
     FROM "CommentV3" c JOIN "FeaturePageCommentMirror" m ON m."commentId" = c.id WHERE c.id = $1`,
    [id]
  );
  return row;
};
const hide = async (id: number, view?: { version: number }) =>
  moderation.moderatorHideFpComment({
    commentId: id,
    seenVersion: (view ?? (await seen(id))).version,
    actorId: MOD,
  });
const unhide = async (id: number, view?: { version: number; hiddenAt: string | null }) => {
  const v = view ?? (await seen(id));
  return liftModeratorFpHide(kysely(), {
    commentId: id,
    actorId: MOD,
    systemUserId: SYSTEM,
    seenHiddenAt: v.hiddenAt ?? '',
    seenVersion: v.version,
  });
};

const modVisibleBySource = () =>
  platform.verdicts.filter(
    (v) =>
      v.path === '/internal/verdict/mod' &&
      v.body.verdict === 'visible' &&
      (v.body.target as { sourceId?: number; digest?: string }).digest?.startsWith('source:')
  );

/** A shown comment a moderator here hid, with the hide pushed. */
const hiddenByModerator = async (text = 'a comment a moderator hid') => {
  const id = (await seedFpComment(mirror, text)).comment.sourceId;
  expect(decided(id)).toBe('visible');
  expect(await hide(id)).toEqual({ hidden: true });
  await runMirror(mirror);
  expect(decided(id)).toBe('hidden');
  expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'moderator' });
  return id;
};

const flagScan = async (id: number) => {
  await scanClean(id);
  await q(
    `UPDATE "EntityModeration" SET "triggeredLabels" = '{scam}'
     WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
    [id]
  );
};
const scanReport = async (id: number) => {
  const [report] = await q<{ id: number }>(
    `INSERT INTO "Report"(status, reason, "userId", details)
     VALUES ('Pending', 'AdminAttention', $1, '{"comment":"auto-hidden by scan"}') RETURNING id`,
    [SYSTEM]
  );
  await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
    id,
    report.id,
  ]);
  return report;
};
const judgedText = async (id: number) =>
  textScanTextHash((await getTextScanProfile('CommentV3')!.load([id])).get(id)!);

describe("a moderator's hide and unhide of a Feature Pages comment", () => {
  it('hides, then shows again here and, at the reconcile, on the platform, with the record', async () => {
    const id = await hiddenByModerator();
    expect(await unhide(id)).toEqual({ lifted: { commentId: id, version: 1 } });
    expect((await seen(id)).hidden).toBe(false);
    expect(await mirrorRow(id)).toMatchObject({ liftGrantedBy: MOD, liftGrantedVersion: 1 });
    expect(
      await q(`SELECT "userId", "entityType", "entityId", activity FROM "ModActivity" ORDER BY id`)
    ).toEqual([
      { userId: MOD, entityType: 'commentV3', entityId: id, activity: 'fpHide' },
      { userId: MOD, entityType: 'commentV3', entityId: id, activity: 'fpUnhide' },
    ]);

    // The push alone sends only the site's visible: the moderator hide still decides there.
    await runMirror(mirror);
    expect(decided(id)).toBe('hidden');
    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(modVisibleBySource()).toHaveLength(1);
    expect(decided(id)).toBe('visible');
    expect(await mirror.isFpCommentShown(id)).toBe(true);
  });

  it('refuses, writing nothing, when the comment changed since the moderator looked', async () => {
    const id = (await seedFpComment(mirror, 'edited since')).comment.sourceId;
    const stale = await seen(id);
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await hide(id, stale)).toEqual({ held: 'changed' });
    expect((await seen(id)).hidden).toBe(false);

    const hid = await hiddenByModerator('hidden again since');
    const first = await seen(hid);
    // Hidden again by another moderator since (an earlier stamp, so only the binding refuses it).
    await q(`UPDATE "CommentV3" SET "hiddenAt" = "hiddenAt" - interval '1 second' WHERE id = $1`, [
      hid,
    ]);
    expect(await unhide(hid, first)).toEqual({ held: 'changed' });
    expect((await seen(hid)).hidden).toBe(true);
    expect(await hide(hid)).toEqual({ held: 'changed' });
  });

  it("never lifts the scan's hide: that is its report's dismissal, and a scan hide since the look is a change", async () => {
    const id = (await seedFpComment(mirror, 'the scan hides it')).comment.sourceId;
    const shown = await seen(id);
    await flagScan(id);
    await moderation.hideFlaggedFpComment(id, {
      textHash: await judgedText(id),
      createReport: (async () => scanReport(id)) as never,
    });
    expect(await unhide(id, shown)).toEqual({ held: 'changed' });
    expect(await unhide(id)).toEqual({ held: 'scan' });
    expect((await seen(id)).hidden).toBe(true);
  });

  it('a lift timed the same as the hide sent lifts nothing on the platform', async () => {
    const id = await hiddenByModerator();
    await unhide(id);
    await runMirror(mirror);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "liftGrantedAt" = "modHideSentAt" WHERE "commentId" = $1`,
      [id]
    );
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0 });
    expect(decided(id)).toBe('hidden');
  });

  it('refuses while the last hide sent is not strictly before the lift', async () => {
    const id = await hiddenByModerator();
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "modHideSentAt" = now() + interval '1 minute'
       WHERE "commentId" = $1`,
      [id]
    );
    expect(await unhide(id)).toEqual({ held: 'pushing' });
  });

  it("never lifts another's hide there, nor outranks a pipeline hide", async () => {
    const foreign = (await seedFpComment(mirror, 'hidden there first')).comment.sourceId;
    verdictAt('mod', foreign, 'hidden', new Date(Date.now() - 1_000));
    await hide(foreign);
    await runMirror(mirror);
    expect(await mirrorRow(foreign)).toMatchObject({ modHideOrigin: 'foreign' });
    expect(await unhide(foreign)).toEqual({ held: 'foreign' });

    const piped = await hiddenByModerator('the pipeline hides it too');
    pipelineVerdict(piped, 'hidden');
    expect(await unhide(piped)).toMatchObject({ lifted: { commentId: piped } });
    await settle();
    expect(modVisibleBySource()).toHaveLength(1);
    expect(deciding(piped)).toMatchObject({ source: 'pipeline', verdict: 'hidden' });
  });

  it('holds for a flagged scan, an author out of standing, an open report, or a ToS flag', async () => {
    const flagged = await hiddenByModerator('flagged by the scan');
    await flagScan(flagged);
    expect(await unhide(flagged)).toEqual({ held: 'flagged' });

    const banned = await hiddenByModerator('banned author');
    await q(
      `UPDATE "User" SET "bannedAt" = now() WHERE id = (SELECT "userId" FROM "CommentV3" WHERE id = $1)`,
      [banned]
    );
    expect(await unhide(banned)).toEqual({ held: 'author' });
    await q(`UPDATE "User" SET "bannedAt" = NULL`);

    const reported = await hiddenByModerator('reported');
    const [r] = await q<{ id: number }>(
      `INSERT INTO "Report"(status, reason, "userId") VALUES ('Pending', 'TOSViolation', 3) RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      reported,
      r.id,
    ]);
    expect(await unhide(reported)).toEqual({ held: 'reported' });
    // The report the moderator is ruling on does not hold it; another open one would.
    const v = await seen(reported);
    expect(
      await liftModeratorFpHide(kysely(), {
        commentId: reported,
        actorId: MOD,
        systemUserId: SYSTEM,
        seenHiddenAt: v.hiddenAt ?? '',
        seenVersion: v.version,
        exceptReportId: r.id,
      })
    ).toMatchObject({ lifted: { commentId: reported } });

    const tos = await hiddenByModerator('ToS too');
    await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [tos]);
    expect(await unhide(tos)).toEqual({ held: 'tos' });

    for (const id of [flagged, banned, tos]) expect((await seen(id)).hidden).toBe(true);
  });

  it('a replayed scan of the same text after the unhide does not hide it again', async () => {
    const id = await hiddenByModerator('a replayed scan');
    const textHash = await judgedText(id);
    await unhide(id);
    await flagScan(id);
    const report = vi.fn(async () => scanReport(id));
    expect(
      await moderation.hideFlaggedFpComment(id, { textHash, createReport: report as never })
    ).toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect((await seen(id)).hidden).toBe(false);
  });
});
