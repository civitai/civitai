import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type * as FliptClient from '~/server/flipt/client';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';
import type * as MirrorService from '~/server/services/feature-pages/mirror.service';
import {
  readFpMirrorFacts,
  unactionReportLiftingScanHide,
} from '@civitai/db-queries/feature-page-comments';
import { ReportStatus } from '~/shared/utils/prisma/enums';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import {
  AUTHOR,
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

// A moderator's dismissal of the scan's report on a Feature Pages comment, from the scan's hide to
// what the platform shows, against the platform's decider. Who may lift what: civitai/civitai#10409.
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
  // The report columns the dismissal reads, and the moderator's activity log.
  await pg.db.exec(`
    ALTER TABLE "Report" ADD COLUMN "userId" int, ADD COLUMN details jsonb,
      ADD COLUMN "statusSetBy" int, ADD COLUMN "statusSetAt" timestamp(3),
      ADD COLUMN "alsoReportedBy" int[] NOT NULL DEFAULT '{}',
      ADD COLUMN "previouslyReviewedCount" int NOT NULL DEFAULT 0;
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

const commentOf = async (id: number) =>
  (
    await q<{ hidden: boolean; tosViolation: boolean }>(
      `SELECT hidden, "tosViolation" FROM "CommentV3" WHERE id = $1`,
      [id]
    )
  )[0];

const flagScan = async (id: number) => {
  await scanClean(id);
  await q(
    `UPDATE "EntityModeration" SET "triggeredLabels" = '{scam}'
     WHERE "entityType" = 'CommentV3' AND "entityId" = $1`,
    [id]
  );
};

/** The textHash a scan callback hands the hide for the comment's text now (callback.ts). */
const judgedText = async (id: number) =>
  textScanTextHash((await getTextScanProfile('CommentV3')!.load([id])).get(id)!);

const scanHides = async (id: number) => {
  await flagScan(id);
  const textHash = await judgedText(id);
  let reportId = 0;
  const createReport = vi.fn(async (input: { details: Record<string, unknown> }) => {
    const [report] = await q<{ id: number }>(
      `INSERT INTO "Report"(status, reason, "userId", details)
       VALUES ('Pending', 'AdminAttention', $1, $2) RETURNING id`,
      [SYSTEM, JSON.stringify(input.details)]
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      id,
      report.id,
    ]);
    reportId = report.id;
    return report;
  });
  const hid = await moderation.hideFlaggedFpComment(id, {
    textHash,
    createReport: createReport as never,
  });
  return { hid, reportId, createReport };
};

/** The scan hides it again with a new report, for the text it judged. */
const rescanHides = async (id: number, textHash: string) => {
  let reportId = 0;
  await moderation.hideFlaggedFpComment(id, {
    textHash,
    createReport: (async () => {
      const [report] = await q<{ id: number }>(
        `INSERT INTO "Report"(status, reason, "userId", details)
         VALUES ('Pending', 'AdminAttention', $1, '{"comment":"auto-hidden by scan"}') RETURNING id`,
        [SYSTEM]
      );
      await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
        id,
        report.id,
      ]);
      reportId = report.id;
      return report;
    }) as never,
  });
  return reportId;
};

/** A moderator sets the report Unactioned, as the per-report status action does. */
const unaction = (reportId: number, by = MOD) =>
  unactionReportLiftingScanHide(kysely(), { reportId, actorId: by, systemUserId: SYSTEM });
const dismiss = async (reportId: number, by = MOD) => (await unaction(reportId, by)).lifted;
const statusOf = async (reportId: number) =>
  (await q<{ status: string }>(`SELECT status FROM "Report" WHERE id = $1`, [reportId]))[0].status;

/** A clean, shown comment that the scan then hides, with the hide pushed. */
const hiddenByScan = async (text = 'a false positive') => {
  const id = (await seedFpComment(mirror, text)).comment.sourceId;
  expect(decided(id)).toBe('visible');
  const { reportId } = await scanHides(id);
  await runMirror(mirror);
  expect(decided(id)).toBe('hidden');
  return { id, reportId };
};

const modVisibleBySource = () =>
  platform.verdicts.filter(
    (v) =>
      v.path === '/internal/verdict/mod' &&
      v.body.verdict === 'visible' &&
      (v.body.target as { sourceId?: number; digest?: string }).digest?.startsWith('source:')
  );

/** The mirror and the reconcile run until nothing more changes. */
const settle = async () => {
  await runMirror(mirror);
  const counts = await reconcile();
  await runMirror(mirror);
  return counts;
};

describe("a moderator's dismissal of the scan's report", () => {
  it('1. restores a comment the scan hid: shown here and on the platform, with the record', async () => {
    const { id, reportId } = await hiddenByScan();
    expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'scan', scanHiddenVersion: 1 });

    const lifted = await dismiss(reportId);
    expect(lifted).toEqual({ commentId: id, version: 1 });
    expect((await commentOf(id)).hidden).toBe(false);
    expect(await mirrorRow(id)).toMatchObject({ liftGrantedBy: MOD, liftGrantedVersion: 1 });
    expect(
      await q(`SELECT "userId", "entityType", "entityId", activity FROM "ModActivity" ORDER BY id`)
    ).toEqual([
      { userId: MOD, entityType: 'commentV3', entityId: id, activity: 'scanLift' },
      { userId: MOD, entityType: 'report', entityId: reportId, activity: 'scanLift' },
    ]);

    // The push alone sends only the site's visible: the moderator hide still decides.
    await runMirror(mirror);
    expect(decided(id)).toBe('hidden');
    expect(modVisibleBySource()).toHaveLength(0);

    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(modVisibleBySource()).toHaveLength(1);
    expect(decided(id)).toBe('visible');
    expect(await mirror.isFpCommentShown(id)).toBe(true);

    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, mismatched: 0 });
  });

  it("2. lifts nothing when the current hide is not the scan's: ToS-removed, or hidden at another time", async () => {
    const tos = await hiddenByScan('removed as well');
    await moderation.setFlagsInBatches([tos.id], { tosViolation: true });
    // Closed, and said why: its hide was replaced.
    expect(await unaction(tos.reportId)).toEqual({
      changed: true,
      lifted: null,
      superseded: 'hidden',
    });
    expect(await commentOf(tos.id)).toMatchObject({ hidden: true, tosViolation: true });

    const other = await hiddenByScan('hidden again later');
    await q(`UPDATE "CommentV3" SET "hiddenAt" = "hiddenAt" + interval '1 second' WHERE id = $1`, [
      other.id,
    ]);
    expect(await unaction(other.reportId)).toMatchObject({ changed: true, superseded: 'hidden' });
    expect((await commentOf(other.id)).hidden).toBe(true);

    const gone = await hiddenByScan('removed since');
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "removeWantedAt" = now() WHERE "commentId" = $1`,
      [gone.id]
    );
    expect(await unaction(gone.reportId)).toMatchObject({ changed: true, superseded: 'removed' });

    await settle();
    expect(modVisibleBySource()).toHaveLength(0);
    expect([decided(tos.id), decided(other.id)]).toEqual(['hidden', 'hidden']);
  });

  /** The report is left open, why is returned, and the comment stays hidden. */
  const heldOpen = async (id: number, reportId: number, why: string) => {
    expect(await unaction(reportId)).toEqual({ changed: false, lifted: null, held: why });
    expect(await statusOf(reportId)).toBe('Pending');
    expect((await commentOf(id)).hidden).toBe(true);
  };

  it('3. lifts nothing for a banned or muted author, at the dismissal or at the push', async () => {
    const banned = await hiddenByScan('banned author');
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR]);
    await heldOpen(banned.id, banned.reportId, 'author');
    await q(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [AUTHOR]);

    const muted = await hiddenByScan('muted author');
    await q(`UPDATE "User" SET muted = true WHERE id = $1`, [AUTHOR]);
    await heldOpen(muted.id, muted.reportId, 'author');
    await q(`UPDATE "User" SET muted = false WHERE id = $1`, [AUTHOR]);

    // Granted and pushed, then muted before the reconcile: nothing is sent.
    const later = await hiddenByScan('muted after the dismissal');
    expect(await dismiss(later.reportId)).not.toBeNull();
    await runMirror(mirror);
    await q(`UPDATE "User" SET muted = true WHERE id = $1`, [AUTHOR]);
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, moderatorHidden: 1 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(decided(later.id)).toBe('hidden');
  });

  it('3b. held in the csam queue, or its text changed since the scan hid it: the report is left open', async () => {
    const held = await hiddenByScan('held for a check');
    await q(
      `INSERT INTO "TextScanHold"("entityType", "entityId", label, status) VALUES ('CommentV3', $1, 'csam', 'Pending')`,
      [held.id]
    );
    await heldOpen(held.id, held.reportId, 'held');

    const changed = await hiddenByScan('changed since');
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      changed.id,
    ]);
    await heldOpen(changed.id, changed.reportId, 'version');
  });

  it('3c. the mirror and the dismissal agree on author standing: banned, muted, deleted, missing', async () => {
    const standing = async (id: number) =>
      (await readFpMirrorFacts(kysely(), [id]))[0].authorInStanding;
    // No such user: the foreign key forbids it, so it is set aside to reach the LEFT JOIN's case.
    const authorOf = async (id: number, userId: number) => {
      await q(`SET session_replication_role = replica`);
      await q(`UPDATE "CommentV3" SET "userId" = $2 WHERE id = $1`, [id, userId]);
      await q(`SET session_replication_role = origin`);
      await q(`UPDATE "FeaturePageCommentMirror" SET "userId" = $2 WHERE "commentId" = $1`, [
        id,
        userId,
      ]);
    };
    const cases: [string, (id: number) => Promise<unknown>][] = [
      ['banned', () => q(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [AUTHOR])],
      ['muted', () => q(`UPDATE "User" SET muted = true WHERE id = $1`, [AUTHOR])],
      ['deleted', () => q(`UPDATE "User" SET "deletedAt" = now() WHERE id = $1`, [AUTHOR])],
      ['missing', (id) => authorOf(id, 999)],
    ];
    for (const [why, apply] of cases) {
      const { id, reportId } = await hiddenByScan(`${why} author`);
      expect(await standing(id)).toBe(true);
      await apply(id);
      expect({ why, standing: await standing(id) }).toEqual({ why, standing: false });
      await heldOpen(id, reportId, 'author');
      await q(
        `UPDATE "User" SET "bannedAt" = NULL, muted = false, "deletedAt" = NULL WHERE id = $1`,
        [AUTHOR]
      );
      await authorOf(id, AUTHOR);
    }
  });

  it("4. lifts nothing for the system user, a replayed or re-ruled report, a person's report, or the main app's bulk path", async () => {
    const { id, reportId } = await hiddenByScan();
    expect(await dismiss(reportId, SYSTEM)).toBeNull();
    // Already Unactioned: a replay, a stale tab, or a re-ruling from Actioned.
    expect(await dismiss(reportId)).toBeNull();
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    expect(await dismiss(reportId)).toBeNull();

    // A person's report on the comment, worded as the scan's.
    const [{ id: userReport }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status, reason, "userId", details)
       VALUES ('Pending', 'AdminAttention', 3, '{"comment":"auto-hidden by scan"}') RETURNING id`
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      id,
      userReport,
    ]);
    expect(await dismiss(userReport)).toBeNull();

    await q(`UPDATE "Report" SET status = 'Pending', "statusSetBy" = NULL WHERE id = $1`, [
      reportId,
    ]);
    const { bulkSetReportStatus } = await import('~/server/services/report.service');
    // It skips the scan's report on its hide: left open for its own dismissal.
    await bulkSetReportStatus({ ids: [reportId], status: ReportStatus.Unactioned, userId: MOD });
    expect(await statusOf(reportId)).toBe('Pending');

    expect((await commentOf(id)).hidden).toBe(true);
    await settle();
    expect(modVisibleBySource()).toHaveLength(0);
    expect(decided(id)).toBe('hidden');
  });

  it("5a. never lifts a platform moderator's hide made before this mirror's", async () => {
    const id = (await seedFpComment(mirror, 'hidden there first')).comment.sourceId;
    verdictAt('mod', id, 'hidden', new Date(Date.now() - 1_000));
    expect(decided(id)).toBe('hidden');
    const { reportId } = await scanHides(id);
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'foreign' });
    await heldOpen(id, reportId, 'foreign');
    expect(await settle()).toMatchObject({ moderatorLifts: 0 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(deciding(id)).toMatchObject({ source: 'moderator', verdict: 'hidden' });
  });

  /** Hidden on the platform by another moderator first, then by the scan here. */
  const hiddenThereFirst = async () => {
    const id = (await seedFpComment(mirror, 'hidden there first')).comment.sourceId;
    verdictAt('mod', id, 'hidden', new Date(Date.now() - 1_000));
    await scanHides(id);
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'foreign' });
    return id;
  };
  const resent = async (id: number) => {
    const before = (await mirrorRow(id)).modHideSentAt as Date;
    await runMirror(mirror);
    const row = await mirrorRow(id);
    expect((row.modHideSentAt as Date).getTime()).toBeGreaterThan(before.getTime());
    return row;
  };
  const neverLifted = async (id: number, reportId: number) => {
    await heldOpen(id, reportId, 'foreign');
    expect(await settle()).toMatchObject({ moderatorLifts: 0 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(deciding(id)).toMatchObject({ source: 'moderator', verdict: 'hidden' });
  };

  it("5e. another's hide stays another's after an edit sends the hide again", async () => {
    const id = await hiddenThereFirst();
    await q(
      `UPDATE "Report" SET status = 'Actioned' WHERE id IN (SELECT "reportId" FROM "CommentV3Report" WHERE "commentId" = $1)`,
      [id]
    );
    await q(`UPDATE "CommentV3" SET content = '<p>edited, still flagged</p>' WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now(),
         "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await flagScan(id);
    const reportId = await rescanHides(id, await judgedText(id));
    expect(await resent(id)).toMatchObject({ modHideOrigin: 'foreign', scanHiddenVersion: 2 });
    await neverLifted(id, reportId);
  });

  it("5f. another's hide stays another's after a scan retry sends the hide again", async () => {
    const id = await hiddenThereFirst();
    await q(
      `UPDATE "Report" SET status = 'Actioned' WHERE id IN (SELECT "reportId" FROM "CommentV3Report" WHERE "commentId" = $1)`,
      [id]
    );
    const reportId = await rescanHides(id, await judgedText(id));
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await resent(id)).toMatchObject({ modHideOrigin: 'foreign' });
    await neverLifted(id, reportId);
  });

  it("5g. the scan's own hide sent again stays the scan's, and its dismissal lifts it", async () => {
    const { id, reportId } = await hiddenByScan();
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    const second = await rescanHides(id, await judgedText(id));
    await q(`UPDATE "FeaturePageCommentMirror" SET "nextPushAt" = now() WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await resent(id)).toMatchObject({ modHideOrigin: 'scan' });
    expect(await dismiss(second)).toEqual({ commentId: id, version: 1 });
    await settle();
    expect(modVisibleBySource()).toHaveLength(1);
    expect(decided(id)).toBe('visible');
  });

  /** A lift granted and pushed, with the daily page still showing our hide as it was. */
  const staleOnThePage = async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await runMirror(mirror);
    const ours = (await mirrorRow(id)).modHideSentAt as Date;
    const asOurs = (items: unknown[]) =>
      (items as { urn: string }[]).map((i) => ({
        ...i,
        verdict: { source: 'moderator', verdict: 'hidden', at: ours.toISOString() },
      }));
    return { id, asOurs };
  };
  const singleRead = (url: URL) => url.searchParams.get('limit') === '1';

  it('5b. the hide is confirmed again just before the send: a newer moderator hide there, nothing is sent', async () => {
    const { id, asOurs } = await staleOnThePage();
    platform.readback = (items, url) => (singleRead(url) ? items : asOurs(items));
    verdictAt('mod', id, 'hidden', new Date(Date.now() + 1_000));
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, liftsUnconfirmed: 1 });
    expect(modVisibleBySource()).toHaveLength(0);
  });

  it('5d. a moderator visible there since the page was read: nothing is sent', async () => {
    const { id, asOurs } = await staleOnThePage();
    platform.readback = (items, url) =>
      singleRead(url)
        ? (items as { urn: string }[]).map((i) => ({
            ...i,
            verdict: { ...asOurs([i])[0].verdict, verdict: 'visible' },
          }))
        : asOurs(items);
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, liftsUnconfirmed: 1 });
    expect(modVisibleBySource()).toHaveLength(0);
  });

  it('5c. a single read that returns another comment, or nothing, confirms nothing', async () => {
    const { asOurs } = await staleOnThePage();
    platform.readback = (items, url) =>
      singleRead(url)
        ? (items as { urn: string }[]).map((i) => ({ ...asOurs([i])[0], urn: `${i.urn}x` }))
        : asOurs(items);
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, liftsUnconfirmed: 1 });
    platform.readback = (items, url) => (singleRead(url) ? [] : asOurs(items));
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, liftsUnconfirmed: 1 });
    expect(modVisibleBySource()).toHaveLength(0);

    platform.readback = (items) => asOurs(items);
    expect(await reconcile()).toMatchObject({ moderatorLifts: 1 });
  });

  it("5h. a pipeline or site hide made before this mirror's is not another's: the dismissal lifts the scan's", async () => {
    const hides = {
      pipeline: (id: number) => pipelineVerdict(id, 'hidden'),
      site: (id: number) => verdictAt('site', id, 'hidden', new Date()),
    };
    for (const [by, hideThere] of Object.entries(hides)) {
      const id = (await seedFpComment(mirror, `hidden there first by the ${by}`)).comment.sourceId;
      hideThere(id);
      expect(decided(id)).toBe('hidden');
      const { reportId } = await scanHides(id);
      await runMirror(mirror);
      expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'scan' });
      expect(await dismiss(reportId)).toEqual({ commentId: id, version: 1 });
      expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    }
  });

  it("5i. a failed read of who hid it there sends no hide and is retried, never taken as another's", async () => {
    const id = (await seedFpComment(mirror, 'hidden there first')).comment.sourceId;
    pipelineVerdict(id, 'hidden');
    await scanHides(id);
    platform.readback = (items, url) => (singleRead(url) ? [] : items);
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: null, pushAttempts: 1 });
    expect(platform.verdicts.filter((v) => v.path === '/internal/verdict/mod')).toHaveLength(0);

    platform.readback = null;
    await runMirror(mirror);
    expect(await mirrorRow(id)).toMatchObject({ modHideOrigin: 'scan', pushAttempts: 0 });
  });

  it("5. never lifts a platform moderator's hide made after this mirror's", async () => {
    const { id, reportId } = await hiddenByScan();
    verdictAt('mod', id, 'hidden', new Date(Date.now() + 1_000));
    expect(await dismiss(reportId)).not.toBeNull();
    expect(await settle()).toMatchObject({ moderatorLifts: 0, moderatorHidden: 1 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(deciding(id)).toMatchObject({ source: 'moderator', verdict: 'hidden' });
  });

  it('6. a repeated scan hide of the same text after the lift changes nothing', async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await settle();
    expect(decided(id)).toBe('visible');

    const again = await scanHides(id);
    expect(again.hid).toBe(false);
    expect(again.createReport).not.toHaveBeenCalled();
    expect((await commentOf(id)).hidden).toBe(false);
    await settle();
    expect(decided(id)).toBe('visible');
  });

  it("7. an edit the scan hides again is not covered by the earlier text's lift", async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await settle();
    expect(decided(id)).toBe('visible');

    await q(`UPDATE "CommentV3" SET content = '<p>now a scam</p>' WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now(),
         "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    const { hid, reportId: second } = await scanHides(id);
    expect(hid).toBe(true);
    await settle();
    expect(decided(id)).toBe('hidden');
    expect(await mirrorRow(id)).toMatchObject({ scanHiddenVersion: 2, liftGrantedVersion: 1 });
    expect(modVisibleBySource()).toHaveLength(1);

    expect(await dismiss(second)).toEqual({ commentId: id, version: 2 });
    await settle();
    expect(modVisibleBySource()).toHaveLength(2);
    expect(decided(id)).toBe('visible');
  });

  it('7c. the scan hiding a newer text again binds the hide to that text, so its own report lifts it', async () => {
    const { id, reportId } = await hiddenByScan();
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    // Edited while hidden, with no report open; the rescan flags the new text.
    await q(`UPDATE "CommentV3" SET content = '<p>edited, still flagged</p>' WHERE id = $1`, [id]);
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      id,
    ]);
    await flagScan(id);
    const second = await rescanHides(id, await judgedText(id));
    expect(await dismiss(second)).toEqual({ commentId: id, version: 2 });
  });

  it('7d. a scan of an older text binds nothing new: its report is held, never lifted', async () => {
    const { id, reportId } = await hiddenByScan();
    const older = await judgedText(id);
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    await q(`UPDATE "CommentV3" SET content = '<p>edited</p>' WHERE id = $1`, [id]);
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      id,
    ]);
    const stale = await rescanHides(id, older);
    await heldOpen(id, stale, 'version');
  });

  it('7e. a scan whose text check fails still hides, bound to no version, and fails for the retry', async () => {
    const id = (await seedFpComment(mirror, 'checked text')).comment.sourceId;
    await flagScan(id);
    let reportId = 0;
    const hiding = moderation.hideFlaggedFpComment(id, {
      textHash: await judgedText(id),
      currentTextHash: async () => {
        throw new Error('config read failed');
      },
      createReport: (async () => {
        const [report] = await q<{ id: number }>(
          `INSERT INTO "Report"(status, reason, "userId", details)
           VALUES ('Pending', 'AdminAttention', $1, '{"comment":"auto-hidden by scan"}') RETURNING id`,
          [SYSTEM]
        );
        await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
          id,
          report.id,
        ]);
        reportId = report.id;
        return report;
      }) as never,
    });
    await expect(hiding).rejects.toThrow('config read failed');
    expect(await mirrorRow(id)).toMatchObject({
      scanHiddenVersion: null,
      scanHideReportId: reportId,
    });
    await heldOpen(id, reportId, 'version');
  });

  /** The author's edit, committed: new text, the next version. */
  const edit = async (id: number) => {
    await q(`UPDATE "CommentV3" SET content = '<p>edited after the scan</p>' WHERE id = $1`, [id]);
    await q(`UPDATE "FeaturePageCommentMirror" SET version = version + 1 WHERE "commentId" = $1`, [
      id,
    ]);
  };
  /** The scan of the first text hides it, with an edit landing where `at` says. */
  const hideRacingAnEdit = async (at: 'hash' | 'lock') => {
    const id = (await seedFpComment(mirror, 'the text the scan judged')).comment.sourceId;
    await flagScan(id);
    const textHash = await judgedText(id);
    let reportId = 0;
    await moderation.hideFlaggedFpComment(id, {
      textHash,
      // Hashed for real, then the edit commits before the version is read again.
      currentTextHash: async () => {
        const hash = await judgedText(id);
        if (at === 'hash') await edit(id);
        return hash;
      },
      // After the scan's text is judged, before the hide takes the comment's lock.
      createReport: (async () => {
        if (at === 'lock') await edit(id);
        const [report] = await q<{ id: number }>(
          `INSERT INTO "Report"(status, reason, "userId", details)
           VALUES ('Pending', 'AdminAttention', $1, '{"comment":"auto-hidden by scan"}') RETURNING id`,
          [SYSTEM]
        );
        await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
          id,
          report.id,
        ]);
        reportId = report.id;
        return report;
      }) as never,
    });
    return { id, reportId };
  };
  const neverBindsTheEdit = async ({ id, reportId }: { id: number; reportId: number }) => {
    expect(await mirrorRow(id)).toMatchObject({ version: 2, scanHiddenVersion: null });
    await heldOpen(id, reportId, 'version');
    // The edited text's own flagged scan still hides it, bound to its version.
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    await flagScan(id);
    await rescanHides(id, await judgedText(id));
    expect(await mirrorRow(id)).toMatchObject({ scanHiddenVersion: 2, liftGrantedVersion: null });
    expect((await commentOf(id)).hidden).toBe(true);
  };

  it('7f. an edit committed while the scan text is read: the hide binds no version', async () => {
    await neverBindsTheEdit(await hideRacingAnEdit('hash'));
  });

  it('7g. an edit committed after the text is judged, before the lock: the hide binds no version', async () => {
    await neverBindsTheEdit(await hideRacingAnEdit('lock'));
  });

  it("7h. a lift of the current version never skips a flagged scan of another version's text", async () => {
    const { id, reportId } = await hiddenByScan();
    const older = await judgedText(id);
    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [reportId]);
    await edit(id);
    await flagScan(id);
    const second = await rescanHides(id, await judgedText(id));
    expect(await dismiss(second)).toEqual({ commentId: id, version: 2 });
    // A verdict on the first text, arriving after the lift of the second.
    await rescanHides(id, older);
    expect((await commentOf(id)).hidden).toBe(true);
    expect(await mirrorRow(id)).toMatchObject({ liftGrantedVersion: 2, scanHiddenVersion: null });
  });

  /** A flagged rescan whose text read fails; `beforeReport` runs as its report is filed. */
  const unreadRescan = async (id: number, beforeReport?: () => Promise<unknown>) => {
    await flagScan(id);
    const createReport = vi.fn(async () => {
      await beforeReport?.();
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
    });
    const hiding = moderation.hideFlaggedFpComment(id, {
      textHash: await judgedText(id),
      currentTextHash: async () => {
        throw new Error('config read failed');
      },
      createReport: createReport as never,
    });
    await expect(hiding).rejects.toThrow('config read failed');
    return createReport;
  };

  it('7i. a rescan whose text read fails after a lift of the current version: shown, no report, retried', async () => {
    const { id, reportId } = await hiddenByScan();
    expect(await dismiss(reportId)).toEqual({ commentId: id, version: 1 });
    expect(await unreadRescan(id)).not.toHaveBeenCalled();
    expect((await commentOf(id)).hidden).toBe(false);
    // The retry reads the text: the lifted version, so nothing changes.
    expect(await rescanHides(id, await judgedText(id))).toBe(0);
    expect((await commentOf(id)).hidden).toBe(false);
  });

  it('7j. a rescan whose text read fails after a lift, then an edit: hidden, bound to no version', async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await edit(id);
    expect(await unreadRescan(id)).toHaveBeenCalledTimes(1);
    expect((await commentOf(id)).hidden).toBe(true);
    expect(await mirrorRow(id)).toMatchObject({ version: 2, scanHiddenVersion: null });
  });

  it('7k. a lift committed after the failed read, before the lock: not hidden again', async () => {
    const { id, reportId } = await hiddenByScan();
    expect(await unreadRescan(id, () => dismiss(reportId))).toHaveBeenCalledTimes(1);
    expect((await commentOf(id)).hidden).toBe(false);
    expect(await mirrorRow(id)).toMatchObject({ liftGrantedVersion: 1 });
  });

  it('7b. a lift of one version never shows a newer version the scan has not cleared', async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await settle();
    // An edit whose scan has flagged it but not hidden it yet: it is not sent.
    await q(`UPDATE "CommentV3" SET content = '<p>edited</p>' WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now(),
         "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await flagScan(id);
    await runMirror(mirror);
    expect(platform.posts.filter((p) => p.text === 'edited')).toHaveLength(0);
    expect(modVisibleBySource()).toHaveLength(1);

    await scanClean(id);
    await runMirror(mirror);
    expect(platform.posts.filter((p) => p.text === 'edited')).toHaveLength(1);
    expect(decided(id)).toBe('visible');
  });

  it("8. a moderator's own hide over the scan's leaves nothing for a dismissal to lift", async () => {
    const { id, reportId } = await hiddenByScan();
    await moderation.setFlagsInBatches([id], { hidden: true });
    expect((await mirrorRow(id)).scanHiddenAt).toBeNull();
    expect(await dismiss(reportId)).toBeNull();
    await settle();
    expect(modVisibleBySource()).toHaveLength(0);
    expect(decided(id)).toBe('hidden');
  });

  it('9. a lift timed the same as the hide it would lift lifts nothing', async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await runMirror(mirror);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "liftGrantedAt" = "modHideSentAt" WHERE "commentId" = $1`,
      [id]
    );
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0, moderatorHidden: 1 });
    expect(decided(id)).toBe('hidden');

    // One microsecond later, it lifts.
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "liftGrantedAt" = "modHideSentAt" + interval '1 microsecond'
       WHERE "commentId" = $1`,
      [id]
    );
    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(decided(id)).toBe('visible');
  });

  /** A person's report on the comment, in `status`. */
  const personReport = async (commentId: number, status: string) => {
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status, reason, "userId") VALUES ($1, 'TOSViolation', 3) RETURNING id`,
      [status]
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      commentId,
      id,
    ]);
    return id;
  };

  it("11. someone else's open report on the comment keeps it hidden until that report is handled", async () => {
    const { id, reportId } = await hiddenByScan('reported by a person too');
    const pending = await personReport(id, 'Pending');
    // The scan's report is left open, so the lift can still be made once that report is ruled.
    expect(await unaction(reportId)).toEqual({ changed: false, lifted: null, held: 'reported' });
    expect(await statusOf(reportId)).toBe('Pending');
    await q(`UPDATE "Report" SET status = 'Processing' WHERE id = $1`, [pending]);
    expect(await unaction(reportId)).toMatchObject({ held: 'reported' });
    expect((await commentOf(id)).hidden).toBe(true);

    await q(`UPDATE "Report" SET status = 'Actioned' WHERE id = $1`, [pending]);
    expect(await dismiss(reportId)).toEqual({ commentId: id, version: 1 });
  });

  it("11b. an open report on another comment, or the system's own, does not hold this one", async () => {
    const reported = await hiddenByScan('reported by a person');
    await personReport(reported.id, 'Pending');
    const { id, reportId } = await hiddenByScan('not reported');
    // The system's own open report on it is not a person's.
    const [{ id: automated }] = await q<{ id: number }>(
      `INSERT INTO "Report"(status, reason, "userId") VALUES ('Pending', 'Automated', $1) RETURNING id`,
      [SYSTEM]
    );
    await q(`INSERT INTO "CommentV3Report"("commentId", "reportId") VALUES ($1, $2)`, [
      id,
      automated,
    ]);
    expect(await dismiss(reportId)).toEqual({ commentId: id, version: 1 });
  });

  it('11c. a report filed after the lift holds the platform send until it is handled', async () => {
    const { id, reportId } = await hiddenByScan();
    expect(await dismiss(reportId)).not.toBeNull();
    await runMirror(mirror);
    const later = await personReport(id, 'Pending');
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0 });
    expect(modVisibleBySource()).toHaveLength(0);
    expect(decided(id)).toBe('hidden');

    await q(`UPDATE "Report" SET status = 'Unactioned' WHERE id = $1`, [later]);
    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(decided(id)).toBe('visible');
  });

  it("12. only the report filed with the current hide lifts it: an earlier version's never does", async () => {
    const { id, reportId: older } = await hiddenByScan();
    // A newer text the scan hid again, with its own report, while the older one is still open.
    await q(`UPDATE "CommentV3" SET content = '<p>now a scam</p>' WHERE id = $1`, [id]);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET version = version + 1, "contentAt" = now(),
         "nextPushAt" = now() WHERE "commentId" = $1`,
      [id]
    );
    await q(`UPDATE "CommentV3" SET hidden = false, "hiddenAt" = NULL WHERE id = $1`, [id]);
    const { reportId: newer } = await scanHides(id);
    expect(newer).not.toBe(older);
    expect(await dismiss(older)).toBeNull();
    expect((await commentOf(id)).hidden).toBe(true);
    expect(await dismiss(newer)).toEqual({ commentId: id, version: 2 });
  });

  it('13a. a lift is not made while a push holds the row, and is made when asked again after', async () => {
    const { id, reportId } = await hiddenByScan();
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '1 minute'
       WHERE "commentId" = $1`,
      [id]
    );
    expect(await unaction(reportId)).toMatchObject({ changed: false, held: 'pushing' });
    expect(await statusOf(reportId)).toBe('Pending');
    expect((await commentOf(id)).hidden).toBe(true);
    await q(`UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = NULL WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await dismiss(reportId)).toEqual({ commentId: id, version: 1 });
  });

  it('13. a row the push holds is not lifted on the platform until the push lets it go', async () => {
    const { id, reportId } = await hiddenByScan();
    await dismiss(reportId);
    await runMirror(mirror);
    await q(
      `UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = now() + interval '1 minute'
       WHERE "commentId" = $1`,
      [id]
    );
    expect(await reconcile()).toMatchObject({ moderatorLifts: 0 });
    expect(modVisibleBySource()).toHaveLength(0);
    await q(`UPDATE "FeaturePageCommentMirror" SET "leaseUntil" = NULL WHERE "commentId" = $1`, [
      id,
    ]);
    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(decided(id)).toBe('visible');
  });

  it('10. a pipeline hide the moderator did not see still decides after the lift', async () => {
    const { id, reportId } = await hiddenByScan();
    pipelineVerdict(id, 'hidden');
    // The moderator hide decides, so the readback shows ours.
    expect(deciding(id)).toMatchObject({ source: 'moderator', verdict: 'hidden' });
    await dismiss(reportId);
    expect(await settle()).toMatchObject({ moderatorLifts: 1 });
    expect(deciding(id)).toMatchObject({ source: 'pipeline', verdict: 'hidden' });
    expect(decided(id)).toBe('hidden');
    expect(await reconcile()).toMatchObject({ pipelineHidden: 1, moderatorLifts: 0 });
  });
});
