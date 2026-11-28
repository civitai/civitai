import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';
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
import { fpVisibilitySchema } from '~/server/schema/moderator/comment';

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

// The system user, as constants.system.user.id.
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
const unhide = async (
  id: number,
  view?: { version: number; hiddenAt: string | null },
  exceptReportId?: number
) => {
  const v = view ?? (await seen(id));
  return moderation.moderatorUnhideFpComment({
    commentId: id,
    actorId: MOD,
    seenHiddenAt: v.hiddenAt ?? '',
    seenVersion: v.version,
    exceptReportId,
  });
};
const activities = () =>
  q<{ activity: string }>(`SELECT activity FROM "ModActivity" ORDER BY id`).then((r) =>
    r.map((a) => a.activity)
  );

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

const personReport = async (commentId: number, by = 3, status = 'Pending') => {
  const [r] = await q<{ id: number }>(
    `INSERT INTO "Report"(status, reason, "userId") VALUES ($1, 'TOSViolation', $2) RETURNING id`,
    [status, by]
  );
  await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
    commentId,
    r.id,
  ]);
  return r.id;
};

// The rules a moderator's hide and unhide keep: civitai/civitai#10743.
describe("a moderator's hide and unhide of a Feature Pages comment", () => {
  it('hides, then shows again here and, at the reconcile, on the platform, with the record', async () => {
    const id = await hiddenByModerator();
    expect(await unhide(id)).toEqual({ lifted: { commentId: id, version: 1 } });
    expect((await seen(id)).hidden).toBe(false);
    // Records the lift, and grants no version: that is the scan report's dismissal alone.
    expect(await mirrorRow(id)).toMatchObject({ liftGrantedBy: MOD, liftGrantedVersion: null });
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

  it('the endpoint takes the hide time as the database prints it, in any session time zone', async () => {
    const id = await hiddenByModerator();
    const view = await seen(id);
    const body = (seenHiddenAt: string) => ({
      commentId: id,
      hidden: false,
      seenVersion: view.version,
      seenHiddenAt,
    });
    expect(fpVisibilitySchema.safeParse(body(view.hiddenAt!)).success).toBe(true);
    const [{ zoned }] = await q<{ zoned: string }>(
      `SELECT set_config('TimeZone', 'Asia/Kolkata', true), $1::timestamptz::text AS zoned`,
      [view.hiddenAt]
    );
    expect(fpVisibilitySchema.safeParse(body(zoned)).success).toBe(true);
    expect(fpVisibilitySchema.safeParse(body('2026-11-20 01:00:00+00')).success).toBe(true);
    expect(fpVisibilitySchema.safeParse(body('')).success).toBe(false);
  });

  it('refuses, writing nothing, when the comment changed since the moderator looked', async () => {
    const id = (await seedFpComment(mirror, 'edited since')).comment.sourceId;
    const stale = await seen(id);
    // An unhide of a shown comment, as a second click would send.
    expect(
      await unhide(id, { version: stale.version, hiddenAt: '2026-11-20 01:00:00+00' })
    ).toEqual({ held: 'changed' });
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await hide(id, stale)).toEqual({ held: 'changed' });
    expect((await seen(id)).hidden).toBe(false);
    // Removed as ToS since: already off the page, by another action.
    await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [id]);
    expect(await hide(id)).toEqual({ held: 'changed' });

    const hid = await hiddenByModerator('hidden again since');
    const first = await seen(hid);
    // Hidden again by another moderator since (an earlier stamp, so only the binding refuses it).
    await q(`UPDATE "CommentV3" SET "hiddenAt" = "hiddenAt" - interval '1 second' WHERE id = $1`, [
      hid,
    ]);
    expect(await unhide(hid, first)).toEqual({ held: 'changed' });
    expect(await hide(hid)).toEqual({ held: 'changed' });
    // A hide stamped after now: the lift would not be strictly after it.
    await q(`UPDATE "CommentV3" SET "hiddenAt" = now() + interval '1 minute' WHERE id = $1`, [hid]);
    expect(await unhide(hid)).toEqual({ held: 'changed' });
    // Shown again since, by any path, with the hide it had: nothing is left to lift.
    await q(
      `UPDATE "CommentV3" SET hidden = false, "hiddenAt" = now() - interval '1 minute' WHERE id = $1`,
      [hid]
    );
    expect(await unhide(hid)).toEqual({ held: 'changed' });
    expect(await activities()).toEqual(['fpHide']);
  });

  it('a comment gone since is refused as gone, for a hide and an unhide', async () => {
    const id = await hiddenByModerator('deleted since');
    const view = await seen(id);
    await q(`UPDATE "CommentV3" SET "deletedAt" = now() WHERE id = $1`, [id]);
    expect(await unhide(id, view)).toEqual({ held: 'gone' });
    expect(await hide(id, view)).toEqual({ held: 'gone' });
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

  it('a settled row whose text scan is no longer clean gets no lift sent', async () => {
    const id = await hiddenByModerator();
    await unhide(id);
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ nextPushAt: null });
    await flagScan(id);
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(decided(id)).toBe('hidden');
  });

  it('refuses while a push holds the row, or the last hide sent is not strictly before the lift', async () => {
    const id = await hiddenByModerator();
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '1 minute'
       WHERE "commentId" = $1`,
      [id]
    );
    expect(await unhide(id)).toEqual({ held: 'pushing' });
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = NULL,
         "modHideSentAt" = now() + interval '1 minute' WHERE "commentId" = $1`,
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

  it('only over a finished clean scan of the text now: never pending, failed or flagged', async () => {
    // Hidden before its scan came back, then unhidden: the pending scan is not waived.
    const pending = await hiddenByModerator('scanned later');
    await q(`DELETE FROM "EntityModeration" WHERE "entityId" = $1`, [pending]);
    expect(await unhide(pending)).toEqual({ held: 'scanning' });
    // A finished scan of another text is not this text's.
    await q(
      `INSERT INTO "EntityModeration"("entityType", "entityId", status, "contentHash")
       VALUES ('CommentV3', $1, 'Succeeded', 'another text')`,
      [pending]
    );
    expect(await unhide(pending)).toEqual({ held: 'scanning' });
    // The scan then flags it: hidden as the scan, with its report.
    await flagScan(pending);
    const report = vi.fn(async () => scanReport(pending));
    expect(
      await moderation.hideFlaggedFpComment(pending, {
        textHash: await judgedText(pending),
        createReport: report as never,
      })
    ).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);

    const flagged = await hiddenByModerator('flagged by the scan');
    await flagScan(flagged);
    expect(await unhide(flagged)).toEqual({ held: 'flagged' });

    const failed = await hiddenByModerator('scan failed');
    await q(`UPDATE "EntityModeration" SET status = 'Failed' WHERE "entityId" = $1`, [failed]);
    expect(await unhide(failed)).toEqual({ held: 'flagged' });

    // A clean finished scan lets it through.
    await scanClean(failed);
    expect(await unhide(failed)).toMatchObject({ lifted: { commentId: failed } });
  });

  it('holds for a csam hold, an author out of standing, an open report, or a ToS flag', async () => {
    const held = await hiddenByModerator('held for csam');
    await q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status)
       VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [held]
    );
    expect(await unhide(held)).toEqual({ held: 'held' });

    const author = await hiddenByModerator('author out of standing');
    const authorOf = `UPDATE "User" SET %s WHERE id = (SELECT "userId" FROM "CommentV3" WHERE id = $1)`;
    await q(authorOf.replace('%s', '"bannedAt" = now()'), [author]);
    expect(await unhide(author)).toEqual({ held: 'author' });
    await q(authorOf.replace('%s', '"bannedAt" = NULL, muted = true'), [author]);
    expect(await unhide(author)).toEqual({ held: 'author' });
    await q(authorOf.replace('%s', 'muted = false'), [author]);

    const reported = await hiddenByModerator('reported');
    const ruled = await personReport(reported);
    expect(await unhide(reported)).toEqual({ held: 'reported' });
    // The report the moderator is ruling on does not hold it; another open one still does.
    const other = await personReport(reported, 4, 'Processing');
    expect(await unhide(reported, undefined, ruled)).toEqual({ held: 'reported' });
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [other]);

    const tos = await hiddenByModerator('ToS too');
    await q(`UPDATE "CommentV3" SET "tosViolation" = true WHERE id = $1`, [tos]);
    expect(await unhide(tos)).toEqual({ held: 'tos' });

    for (const id of [held, author, reported, tos]) expect((await seen(id)).hidden).toBe(true);
    expect((await activities()).filter((a) => a === 'fpUnhide')).toEqual([]);

    expect(await unhide(reported, undefined, ruled)).toMatchObject({
      lifted: { commentId: reported },
    });
  });

  it("the system user's own open report does not hold a moderator's unhide", async () => {
    const id = await hiddenByModerator('the scan reported it once');
    await personReport(id, SYSTEM);
    expect(await unhide(id)).toMatchObject({ lifted: { commentId: id } });
  });

  it('a later scan hide of the same text still applies after an unhide: the unhide grants no override', async () => {
    const id = await hiddenByModerator('scanned again later');
    const textHash = await judgedText(id);
    await unhide(id);
    await flagScan(id);
    const report = vi.fn(async () => scanReport(id));
    expect(
      await moderation.hideFlaggedFpComment(id, { textHash, createReport: report as never })
    ).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect((await seen(id)).hidden).toBe(true);
    expect(await mirrorRow(id)).toMatchObject({ scanHiddenVersion: 1 });
    // Nor does the mirror show the flagged text: no version was lifted.
    await settle();
    expect(decided(id)).toBe('hidden');
  });
});
