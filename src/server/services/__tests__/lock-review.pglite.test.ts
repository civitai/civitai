import { PGlite } from '@electric-sql/pglite';
import { SYSTEM_NSFW_LOCK_META_KEY } from '@civitai/shared/rating-review';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbLag from '~/server/db/db-lag-helpers';
import type * as Email from '~/server/email/templates';
import type * as LegalHold from '~/server/services/legal-hold.service';
import type * as ModeratorService from '~/server/services/moderator.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as ReportService from '~/server/services/report.service';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

/**
 * An owner's request to review a locked model setting, filed as an `Appeal` row and ruled on from the
 * moderator app's flag-appeals queue. The ruling's own SQL runs against PGlite; the hold is a stand-in
 * table behind `accountHoldSql`, so what is tested is that the ruling reads the owner's hold, not
 * which holds exist. Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  settleResolvedAppeals: vi.fn(),
  createEntityAppeal: vi.fn(),
  reopenAppeal: vi.fn(),
  getLatestAppeal: vi.fn(),
  trackModActivity: vi.fn(),
  isAccountUnderLegalHold: vi.fn(),
  createNotification: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  settleResolvedAppeals: mocks.settleResolvedAppeals,
  createEntityAppeal: mocks.createEntityAppeal,
  reopenAppeal: mocks.reopenAppeal,
  getLatestAppeal: mocks.getLatestAppeal,
}));
vi.mock('~/server/services/moderator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorService>()),
  trackModActivity: mocks.trackModActivity,
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LegalHold>()),
  accountHoldSql: (id: Prisma.Sql) =>
    Prisma.sql`EXISTS (SELECT 1 FROM "Held" h WHERE h."userId" = ${id})`,
  holdMarkerViewExists: async () => true,
  isAccountUnderLegalHold: mocks.isAccountUnderLegalHold,
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLag>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof Email>()),
  moderationActionEmail: { send: mocks.sendEmail },
}));

const {
  resolveLockReviewAppeal,
  getLockReviewState,
  latestModelAppealOfKind,
  LOCK_REVIEW_DETECTION_HELD,
  LOCK_REVIEW_MATCH_CHECK_FAILED,
  LOCK_REVIEW_HELD,
  LOCK_REVIEW_UNAVAILABLE,
} = await import('~/server/services/lock-review.service');
const { createEntityAppealHandler } = await import('~/server/controllers/report.controller');
const { comFaceIntentTextHash, reusableComFaceIntent } = await import(
  '~/server/services/model-com-face-intent.service'
);
const actualReport = await vi.importActual<typeof ReportService>(
  '~/server/services/report.service'
);
const { moderationActionEmail: actualEmail } = await vi.importActual<typeof Email>(
  '~/server/email/templates'
);
const { reportNotifications } = await import('~/server/notifications/report.notifications');

const MODEL = 71;
const OWNER = 82;
const NEW_OWNER = 83;
const MODERATOR = 3;
const OTHER_MODERATOR = 4;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "lockedProperties" text[] NOT NULL DEFAULT '{}',
      nsfw boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'Published',
      meta jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "ModelFile" (
      id int PRIMARY KEY,
      "modelVersionId" int NOT NULL,
      type text NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ModelFileHash" ("fileId" int NOT NULL, type text NOT NULL, hash text NOT NULL);
    CREATE TABLE "Appeal" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending',
      category text,
      context jsonb,
      "buzzTransactionId" text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      "updatedAt" timestamp(3),
      "resolvedAt" timestamp(3),
      "resolvedBy" int,
      "resolvedReason" text,
      "resolvedMessage" text,
      "internalNotes" text
    );
    CREATE TABLE "Held" ("userId" int PRIMARY KEY);
  `);
  const raw = pgliteRaw(db);
  const tx = {
    $queryRaw: raw.queryRaw,
    $executeRaw: raw.executeRaw,
    model: {
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const keys = Object.keys(data);
        await db.query(
          `UPDATE "Model" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} WHERE id = $1`,
          [where.id, ...keys.map((k) => data[k])]
        );
      },
    },
  };
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (t: typeof tx) => unknown) =>
    fn(tx)) as never);
});
afterAll(() => db.close());

type Seed = {
  locked: string[];
  asked?: string[];
  nsfw?: boolean;
  poi?: boolean;
  minor?: boolean;
  held?: boolean;
  owner?: number;
  meta?: Record<string, unknown>;
};

async function seed({
  locked,
  asked = ['nsfw'],
  nsfw = true,
  poi,
  minor,
  held,
  owner,
  meta = {},
}: Seed) {
  await db.exec(
    `DELETE FROM "Model"; DELETE FROM "Appeal"; DELETE FROM "Held"; DELETE FROM "ModelVersion"; DELETE FROM "ModelFile"; DELETE FROM "ModelFileHash";`
  );
  await db.query(
    `INSERT INTO "Model" (id, "userId", "lockedProperties", nsfw, poi, minor, meta) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [MODEL, owner ?? OWNER, locked, nsfw, !!poi, !!minor, meta]
  );
  await db.query(
    `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (1, $1, 'Model', $2, $3)`,
    [OWNER, MODEL, { kind: 'lock-review', locks: asked }]
  );
  if (held) await db.query(`INSERT INTO "Held" ("userId") VALUES ($1)`, [owner ?? OWNER]);
}

const modelRow = async () =>
  (
    await db.query<{ lockedProperties: string[]; nsfw: boolean }>(
      `SELECT "lockedProperties", nsfw FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0];

const modelMeta = async () =>
  (
    await db.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM "Model" WHERE id = $1`, [
      MODEL,
    ])
  ).rows[0].meta;

const appealRow = async () =>
  (
    await db.query<{ status: string; resolvedBy: number | null }>(
      `SELECT status, "resolvedBy" FROM "Appeal" WHERE id = 1`
    )
  ).rows[0];

const approve = (userId = MODERATOR) =>
  resolveLockReviewAppeal({ appealId: 1, modelId: MODEL, approve: true, userId });
const reject = (userId = MODERATOR) =>
  resolveLockReviewAppeal({ appealId: 1, modelId: MODEL, approve: false, userId });

const loggedActivities = () =>
  mocks.trackModActivity.mock.calls.map(([, input]) => (input as { activity: string }).activity);

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.settleResolvedAppeals.mockResolvedValue([]);
  mocks.createEntityAppeal.mockResolvedValue({ id: 1 });
  mocks.reopenAppeal.mockResolvedValue({ id: 1 });
  mocks.getLatestAppeal.mockResolvedValue(null);
  mocks.isAccountUnderLegalHold.mockResolvedValue(false);
  dbMock.dbRead.appeal.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(db).queryRaw as never);
  dbMock.dbRead.$queryRaw.mockImplementation(pgliteRaw(db).queryRaw as never);
  dbMock.dbWrite.appeal.update.mockReset();
  dbMock.dbWrite.appeal.updateMany.mockReset();
  await db.exec(`DELETE FROM "Appeal"`);
});

describe("a ruling on the nsfw lock ends the owner's filter explanation", () => {
  const marker = {
    source: 'profanity-filter',
    at: '2026-01-01T00:00:00.000Z',
    fields: ['name'],
    category: 'mature-language',
    textHash: 'hash-placeholder',
  };
  const kept = { source: marker.source, at: marker.at };

  // The appeal row is reopened in place on a new request, erasing this ruling from it.
  it('a rejection keeps the lock and its marker, without the explanation', async () => {
    await seed({ locked: ['nsfw'], meta: { [SYSTEM_NSFW_LOCK_META_KEY]: marker, other: 1 } });

    await reject();

    expect(await modelRow()).toEqual({ lockedProperties: ['nsfw'], nsfw: true });
    expect(await modelMeta()).toEqual({ [SYSTEM_NSFW_LOCK_META_KEY]: kept, other: 1 });
  });

  it('a ruling on other settings leaves the explanation', async () => {
    await seed({
      locked: ['nsfw', 'tags'],
      asked: ['tags'],
      meta: { [SYSTEM_NSFW_LOCK_META_KEY]: marker },
    });

    await reject();

    expect(await modelMeta()).toEqual({ [SYSTEM_NSFW_LOCK_META_KEY]: marker });
  });
});

describe('approving a lock review', () => {
  it('unlocks only the named settings still locked, and leaves their values', async () => {
    await seed({ locked: ['nsfw', 'category', 'tags'], asked: ['nsfw', 'sfwOnly'] });

    const { unlocked } = await approve();

    expect(unlocked).toEqual(['nsfw']);
    expect(await modelRow()).toEqual({ lockedProperties: ['category', 'tags'], nsfw: true });
    expect(await appealRow()).toEqual({ status: 'Approved', resolvedBy: MODERATOR });
    expect(mocks.settleResolvedAppeals).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 1, userId: OWNER, status: 'Approved' })],
      { status: AppealStatus.Approved, lockReview: { unlocked: ['nsfw'] } }
    );
    expect(loggedActivities()).toEqual(['approveLockReview', 'unlockProperty:nsfw']);
  });

  it('clears the system nsfw-lock marker when it lifts the nsfw lock, as a moderator unlock does', async () => {
    await seed({ locked: ['nsfw'], meta: { [SYSTEM_NSFW_LOCK_META_KEY]: true, other: 1 } });

    await approve();

    expect(await modelMeta()).toEqual({ other: 1 });
  });

  const listing = { name: 'Listing', description: '<p>Its text</p>' };
  const listingHash = comFaceIntentTextHash({ ...listing, triggerWords: [] });
  const storesListing = (stored: { name: string; description: string }) =>
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ ...stored, modelVersions: [] } as never);

  it('overturns the listing intent detection when it lifts the nsfw lock, so a .com version is allowed', async () => {
    const intent = { detected: true, textHash: listingHash, at: '2026-01-01T00:00:00.000Z' };
    storesListing(listing);
    await seed({
      locked: ['nsfw'],
      meta: {
        [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: intent.at },
        comFaceIntent: intent,
      },
    });

    await approve();

    const meta = await modelMeta();
    expect(meta).not.toHaveProperty(SYSTEM_NSFW_LOCK_META_KEY);
    expect(meta.comFaceIntent).toEqual({ ...intent, overturnedAt: expect.any(String) });
  });

  // Edit the listing, have the edit allowed, restore the text: the original detection must still refuse it.
  it('leaves a detection of other text standing, so restoring that text is still refused', async () => {
    const intent = { detected: true, textHash: listingHash, at: '2026-01-01T00:00:00.000Z' };
    storesListing({ ...listing, description: '<p>Edited for the dispute</p>' });
    await seed({
      locked: ['nsfw'],
      meta: {
        [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: intent.at },
        comFaceIntent: intent,
      },
    });

    await approve();

    const meta = await modelMeta();
    expect(meta.comFaceIntent).toEqual(intent);
    expect(reusableComFaceIntent(meta, listingHash)).toMatchObject({ detected: true });
  });

  it('puts back the text-scan rating marker the intent lock replaced', async () => {
    const scan = { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' };
    await seed({
      locked: ['nsfw'],
      meta: {
        [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: '2026-02-01T00:00:00.000Z' },
        comFaceIntent: { detected: true, textHash: 'h', at: 'x', priorSystemNsfwLock: scan },
      },
    });

    await approve();

    expect((await modelMeta())[SYSTEM_NSFW_LOCK_META_KEY]).toEqual(scan);
  });

  it('puts the marker back even when the stored verdict is now for other text', async () => {
    const scan = { source: 'text-scan', at: '2026-01-01T00:00:00.000Z' };
    storesListing(listing);
    await seed({
      locked: ['nsfw'],
      meta: {
        [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: '2026-02-01T00:00:00.000Z' },
        comFaceIntent: { detected: false, textHash: 'other', at: 'x', priorSystemNsfwLock: scan },
      },
    });

    await approve();

    const meta = await modelMeta();
    expect(meta[SYSTEM_NSFW_LOCK_META_KEY]).toEqual(scan);
    expect(meta.comFaceIntent).toEqual({ detected: false, textHash: 'other', at: 'x' });
  });

  it('leaves the listing intent detection standing on a rejection', async () => {
    const intent = { detected: true, textHash: 'h', at: '2026-01-01T00:00:00.000Z' };
    await seed({ locked: ['nsfw'], meta: { comFaceIntent: intent } });

    await reject();

    expect((await modelMeta()).comFaceIntent).toEqual(intent);
  });

  it('keeps the marker when the nsfw lock is not among those lifted', async () => {
    await seed({
      locked: ['nsfw', 'tags'],
      asked: ['tags'],
      meta: { [SYSTEM_NSFW_LOCK_META_KEY]: true },
    });

    await approve();

    expect(await modelMeta()).toEqual({ [SYSTEM_NSFW_LOCK_META_KEY]: true });
  });

  it('refuses while the owner is under an evidence hold, and changes nothing', async () => {
    await seed({ locked: ['nsfw'], held: true });

    await expect(approve()).rejects.toThrow(LOCK_REVIEW_HELD);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
    expect((await appealRow()).status).toBe('Pending');
    expect(mocks.settleResolvedAppeals).not.toHaveBeenCalled();
    expect(mocks.trackModActivity).not.toHaveBeenCalled();
  });

  it.each([{ poi: true }, { minor: true }])(
    'refuses once the model is flagged as a real person or a minor (%o)',
    async (flag) => {
      await seed({ locked: ['nsfw'], ...flag });
      const before = (await modelRow()).lockedProperties;

      await expect(approve()).rejects.toThrow(/real person or a minor/);
      expect((await modelRow()).lockedProperties).toEqual(before);
      expect((await appealRow()).status).toBe('Pending');
    }
  );

  it('lifts the named lock while poi and minor stay locked off', async () => {
    await seed({ locked: ['poi', 'minor', 'sfwOnly', 'nsfw'] });

    await approve();

    expect(await modelRow()).toMatchObject({
      lockedProperties: ['poi', 'minor', 'sfwOnly'],
      nsfw: true,
    });
    expect((await appealRow()).status).toBe('Approved');
  });

  const heldDetection = (label: string) => ({
    textScanFlags: { [label]: { redetected: { kind: 'redetected', textHash: 'held' } } },
  });

  it.each(['poi', 'minor'])(
    'refuses while a %s detection is held for a moderator, and changes nothing',
    async (label) => {
      await seed({ locked: ['poi', 'minor', 'nsfw'], meta: heldDetection(label) });

      await expect(approve()).rejects.toThrow(LOCK_REVIEW_DETECTION_HELD);
      expect((await modelRow()).lockedProperties).toEqual(['poi', 'minor', 'nsfw']);
      expect((await appealRow()).status).toBe('Pending');
    }
  );

  it('refuses while a real person file match waits for a moderator', async () => {
    await seed({ locked: ['poi', 'nsfw'], meta: { poiHashMatch: { at: 'then', hash: 'h' } } });

    await expect(approve()).rejects.toThrow(LOCK_REVIEW_DETECTION_HELD);
    expect((await modelRow()).lockedProperties).toEqual(['poi', 'nsfw']);
  });

  describe('with a minor file match waiting for a moderator', () => {
    const SEED_MODEL = 90;
    const SEED_OWNER = 99;

    /** A moderator-flagged minor model, by default another uploader's, shares a weights file with the model. */
    async function matchFile(seedOwner = SEED_OWNER) {
      await db.query(
        `INSERT INTO "Model" (id, "userId", "lockedProperties", minor) VALUES ($1, $2, '{minor}', true)`,
        [SEED_MODEL, seedOwner]
      );
      await db.exec(`
        INSERT INTO "ModelVersion" VALUES (1, ${MODEL}), (2, ${SEED_MODEL});
        INSERT INTO "ModelFile" (id, "modelVersionId", type) VALUES (1, 1, 'Model'), (2, 2, 'Model');
        INSERT INTO "ModelFileHash" VALUES (1, 'SHA256', 'same'), (2, 'SHA256', 'same');
      `);
    }

    it('refuses to approve, and changes nothing', async () => {
      await seed({ locked: ['poi', 'minor', 'nsfw'] });
      await matchFile();

      await expect(approve()).rejects.toThrow(LOCK_REVIEW_DETECTION_HELD);
      expect((await modelRow()).lockedProperties).toEqual(['poi', 'minor', 'nsfw']);
      expect((await appealRow()).status).toBe('Pending');
    });

    it('approves once a moderator has dismissed the match', async () => {
      await seed({
        locked: ['minor', 'nsfw'],
        meta: { minorHashDismissed: { at: 'then', by: 1 } },
      });
      await matchFile();

      await approve();

      expect((await modelRow()).lockedProperties).toEqual(['minor']);
    });

    it('approves when the match is to the same uploader, which the sweep flags rather than queues', async () => {
      await seed({ locked: ['minor', 'nsfw'] });
      await matchFile(OWNER);

      await approve();

      expect((await modelRow()).lockedProperties).toEqual(['minor']);
    });

    it('still lets the review be rejected', async () => {
      await seed({ locked: ['minor', 'nsfw'] });
      await matchFile();

      await reject();

      expect((await appealRow()).status).toBe('Rejected');
    });

    it('refuses to approve when the match cannot be checked', async () => {
      await seed({ locked: ['minor', 'nsfw'] });
      dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('timeout'));

      await expect(approve()).rejects.toThrow(LOCK_REVIEW_MATCH_CHECK_FAILED);
      expect((await modelRow()).lockedProperties).toEqual(['minor', 'nsfw']);
      expect((await appealRow()).status).toBe('Pending');
    });
  });

  it('still lets the review be rejected while a detection is held', async () => {
    await seed({ locked: ['poi', 'nsfw'], meta: heldDetection('poi') });

    await reject();

    expect((await appealRow()).status).toBe('Rejected');
  });

  it('refuses a request filed by someone who no longer owns the model', async () => {
    await seed({ locked: ['nsfw'], owner: NEW_OWNER });

    await expect(approve()).rejects.toThrow(/changed owner/);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
  });

  it.each([
    ['a flag appeal', `UPDATE "Appeal" SET context = NULL`],
    ['an already rejected request', `UPDATE "Appeal" SET status = 'Rejected'`],
  ])('refuses %s', async (_, change) => {
    await seed({ locked: ['nsfw'] });
    await db.query(change);

    await expect(approve()).rejects.toThrow(/no pending locked-setting review/);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
  });

  it('leaves nothing for a second moderator to rule on', async () => {
    await seed({ locked: ['nsfw'] });

    await approve();
    await expect(reject(OTHER_MODERATOR)).rejects.toThrow(/no pending locked-setting review/);

    expect(await appealRow()).toEqual({ status: 'Approved', resolvedBy: MODERATOR });
    expect(mocks.settleResolvedAppeals).toHaveBeenCalledTimes(1);
  });
});

describe('rejecting a lock review', () => {
  it('keeps the locks and closes the request as rejected, even under a hold', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'], held: true });

    const { unlocked } = await reject();

    expect(unlocked).toEqual([]);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw', 'tags']);
    expect(await appealRow()).toEqual({ status: 'Rejected', resolvedBy: MODERATOR });
    expect(loggedActivities()).toEqual(['rejectLockReview']);
  });

  it('tells the owner without naming a hold', async () => {
    await seed({ locked: ['nsfw'], held: true });
    await expect(approve()).rejects.toThrow(LOCK_REVIEW_HELD);
    await reject();

    const told = await ownerNotice();
    expect(told.message).toBe(DECLINED);
    expect(
      JSON.stringify([mocks.createNotification.mock.calls, mocks.sendEmail.mock.calls])
    ).not.toMatch(/hold/i);
  });

  it('starts the 30-day cooldown while every setting asked about stays locked', async () => {
    const resolvedAt = new Date();
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      status: AppealStatus.Rejected,
      resolvedAt,
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);

    const state = await getLockReviewState({ modelId: MODEL, userId: OWNER });
    expect(state?.reopensAt?.getTime()).toBe(resolvedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

    await expect(
      createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() })
    ).rejects.toThrow(/You can ask again on/);
    expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });

  it('keeps the cooldown when a newer flag-appeal row exists', async () => {
    const resolvedAt = new Date();
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockImplementation(((args: { where: object }) =>
      Promise.resolve(
        'context' in args.where
          ? {
              status: AppealStatus.Rejected,
              resolvedAt,
              context: { kind: 'lock-review', locks: ['nsfw'] },
            }
          : { status: AppealStatus.Approved, resolvedAt, context: null }
      )) as never);

    expect((await getLockReviewState({ modelId: MODEL, userId: OWNER }))?.reopensAt).not.toBeNull();
  });

  it('ends the cooldown once 30 days have passed', async () => {
    ownModel();
    dbMock.dbRead.appeal.findFirst.mockResolvedValue({
      status: AppealStatus.Rejected,
      resolvedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      context: { kind: 'lock-review', locks: ['nsfw'] },
    } as never);

    expect((await getLockReviewState({ modelId: MODEL, userId: OWNER }))?.reopensAt).toBeNull();
  });
});

const APPROVED = 'Your request to review the locked settings on your model was approved.';
const DECLINED =
  'Your request to review the locked settings on your model was declined, so those settings stay locked.';

/** What the owner reads of the ruling: the in-app notice and the email, rendered as sent. */
async function ownerNotice() {
  const [claimed, options] = mocks.settleResolvedAppeals.mock.calls[0];
  dbMock.dbRead.user.findMany.mockResolvedValue([
    { id: OWNER, email: 'owner@example.test', username: 'owner' },
  ] as never);
  await actualReport.settleResolvedAppeals(claimed, options);

  expect(mocks.createNotification).toHaveBeenCalledTimes(1);
  expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  const [notification] = mocks.createNotification.mock.calls[0];
  const rendered = reportNotifications['entity-appeal-resolved'].prepareMessage(
    notification as never
  );
  const [email] = mocks.sendEmail.mock.calls[0];
  return {
    notification: notification as { type: string; key: string },
    message: rendered?.message,
    url: rendered?.url,
    email: actualEmail.getHtml(email as never),
  };
}

describe('telling the owner of a lock review ruling', () => {
  it('names the settings an approval unlocked, never the reason or notes', async () => {
    await seed({ locked: ['nsfw', 'tags', 'category'], asked: ['tags', 'nsfw'] });
    await resolveLockReviewAppeal({
      appealId: 1,
      modelId: MODEL,
      approve: true,
      userId: MODERATOR,
      resolvedReason: 'lock-not-needed',
      internalNotes: 'mod-only note',
    });

    const told = await ownerNotice();
    const copy = `${APPROVED} You can now change: Is intended to produce mature themes, Tags.`;
    expect(told.message).toBe(copy);
    expect(told.email).toContain(copy);
    expect(told.url).toBe(`/models/${MODEL}`);
    expect(told.notification).toMatchObject({
      type: 'entity-appeal-resolved',
      key: expect.stringMatching(new RegExp(String.raw`^entity-appeal-resolved:Model:${MODEL}:1:`)),
    });
    expect(JSON.stringify([told.message, told.email])).not.toMatch(
      /lock[- ]not[- ]needed|mod-only/i
    );
  });

  it('ends at "approved" when nothing it asked about was still locked', async () => {
    await seed({ locked: ['tags'], asked: ['nsfw'] });
    await approve();

    const told = await ownerNotice();
    expect(told.message).toBe(APPROVED);
    expect(told.email).toContain(APPROVED);
    expect(told.email).not.toContain('You can now change');
  });

  // The Moderation Lead's call: one line for every rejection reason, so no reason reads as a verdict.
  it('declines in one line whatever the reason, never the reason or notes', async () => {
    await seed({ locked: ['nsfw'] });
    await resolveLockReviewAppeal({
      appealId: 1,
      modelId: MODEL,
      approve: false,
      userId: MODERATOR,
      resolvedReason: 'lock-stands',
      internalNotes: 'mod-only note',
    });

    const told = await ownerNotice();
    expect(told.message).toBe(DECLINED);
    expect(told.email).toContain(DECLINED);
    expect(JSON.stringify([told.message, told.email])).not.toMatch(/lock[- ]stands|mod-only/i);
  });
});

describe('telling the owner of a flag appeal ruling', () => {
  it('keeps the appeal wording, which only a lock review replaces', async () => {
    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: OWNER, email: 'owner@example.test', username: 'owner' },
    ] as never);
    await actualReport.settleResolvedAppeals(
      [
        {
          id: 2,
          entityId: MODEL,
          entityType: EntityType.Model,
          resolvedAt: new Date(),
          buzzTransactionId: null,
          status: AppealStatus.Rejected,
          userId: OWNER,
          createdAt: new Date(),
        },
      ],
      { status: AppealStatus.Rejected }
    );

    const [notification] = mocks.createNotification.mock.calls[0];
    expect(
      reportNotifications['entity-appeal-resolved'].prepareMessage(notification as never)?.message
    ).toBe('Your appeal regarding your Model has been rejected.');
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'appeal-rejected', intro: undefined })
    );
  });
});

describe('a flag appeal resolving on the same model', () => {
  it('closes only flag appeals, so a lock review is not approved by a flag lift', async () => {
    dbMock.dbWrite.appeal.updateManyAndReturn.mockResolvedValue([] as never);

    await actualReport.resolveEntityAppeal({
      ids: [MODEL],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      modelAppealKind: 'flag',
    });

    expect(dbMock.dbWrite.appeal.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { context: { equals: Prisma.AnyNull } },
            { NOT: { context: { path: ['kind'], equals: 'lock-review' } } },
          ],
        }),
      })
    );
  });
});

const owner = () => ({ user: { id: OWNER }, features: {} } as never);
const request = (locks?: string[]) => ({
  entityId: MODEL,
  entityType: EntityType.Model,
  message: 'The model is SFW; the lock was set before I retagged it.',
  ...(locks && { locks }),
});

function ownModel(fields: Record<string, unknown> = {}) {
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    userId: OWNER,
    lockedProperties: ['nsfw'],
    poi: false,
    minor: false,
    meta: null,
    ...fields,
  } as never);
}

/** The refusal as the caller sees it: tRPC code and message. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message })
  );

describe("an owner's request", () => {
  it('files an appeal naming the settings', async () => {
    ownModel();

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: MODEL,
        context: { kind: 'lock-review', locks: ['nsfw'] },
        skipFee: true,
      })
    );
  });

  it('tags a request on the listing intent lock as a dispute, for the re-judging job', async () => {
    ownModel({
      meta: { [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: '2026-01-01' } },
    });

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { kind: 'lock-review', locks: ['nsfw'], dispute: 'comFaceIntent' },
      })
    );
  });

  it('files a request naming other locks beside the intent lock as an ordinary review', async () => {
    ownModel({
      lockedProperties: ['nsfw', 'tags'],
      meta: { [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: '2026-01-01' } },
    });

    await createEntityAppealHandler({ input: request(['nsfw', 'tags']), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw', 'tags'] } })
    );
  });

  it('files a refiled dispute as an ordinary review once a moderator has ruled on the lock', async () => {
    ownModel({
      meta: { [SYSTEM_NSFW_LOCK_META_KEY]: { source: 'com-face-intent', at: '2026-01-01' } },
    });
    dbMock.dbWrite.modActivity.findFirst.mockResolvedValueOnce({ id: 1 } as never);

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } })
    );
    expect(dbMock.dbWrite.modActivity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          activity: { in: expect.arrayContaining(['rejectLockReview']) },
        }),
      })
    );
  });

  it('reopens the earlier row as a lock review once the cooldown is over', async () => {
    ownModel();
    mocks.getLatestAppeal.mockResolvedValue({ id: 9, status: AppealStatus.Rejected });
    await appealRows(
      [9, 'Rejected', { kind: 'lock-review', locks: ['nsfw'] }],
      [15, 'Rejected', null]
    );

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.reopenAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, context: { kind: 'lock-review', locks: ['nsfw'] } })
    );

    dbMock.dbWrite.appeal.update.mockResolvedValue({ id: 9 } as never);
    await actualReport.reopenAppeal({
      id: 9,
      message: 'again',
      context: { kind: 'lock-review', locks: ['nsfw'] },
    });
    expect(dbMock.dbWrite.appeal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } }),
      })
    );
  });

  it.each([{ poi: true }, { minor: true }])(
    'is refused on a model flagged as a real person or a minor (%o)',
    async (flag) => {
      ownModel(flag);

      expect(
        await refusal(createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() }))
      ).toEqual({ code: 'BAD_REQUEST', message: LOCK_REVIEW_UNAVAILABLE });
      expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
    }
  );

  it.each([['poi'], ['minor'], ['poi', 'minor']].map((marks) => [marks.join(' and '), marks]))(
    'is filed while %s is locked off',
    async (_, marks) => {
      ownModel({ lockedProperties: [...marks, 'sfwOnly', 'nsfw'] });

      await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

      expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
        expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } })
      );
    }
  );

  it('is refused when it names a locked poi or minor', async () => {
    ownModel({ lockedProperties: ['poi', 'minor', 'nsfw'] });

    expect(
      await refusal(createEntityAppealHandler({ input: request(['nsfw', 'poi']), ctx: owner() }))
    ).toEqual({ code: 'BAD_REQUEST', message: LOCK_REVIEW_UNAVAILABLE });
    expect(mocks.createEntityAppeal).not.toHaveBeenCalled();
  });

  it("reopens only the owner's flag-appeal row for a flag appeal, never a lock review", async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    mocks.getLatestAppeal.mockResolvedValue({ id: 9, status: AppealStatus.Rejected });
    await appealRows(
      [4, 'Approved', null],
      [9, 'Rejected', { kind: 'lock-review', locks: ['nsfw'] }]
    );

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(mocks.reopenAppeal).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });

  it.each([
    [
      'their latest row of the kind',
      [
        [4, 'Approved'],
        [12, 'Rejected'],
      ],
      12,
    ],
    [
      'a pending row over a newer resolved one',
      [
        [3, 'Pending'],
        [12, 'Rejected'],
      ],
      3,
    ],
    [
      'the latest filed, not the highest id',
      [
        [12, 'Rejected'],
        [5, 'Approved'],
      ],
      5,
    ],
  ] as const)('reads %s', async (_, rows, expected) => {
    await appealRows(...rows.map(([id, status]) => [id, status, null] as [number, string, null]));
    // Not the owner's, not this model's, or a lock review: never the answer, though filed later.
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, context, "createdAt") VALUES
         (90, $1, 'Model', $2, 'Rejected', NULL, now() + interval '1 hour'),
         (91, $3, 'Model', $4, 'Rejected', NULL, now() + interval '1 hour'),
         (92, $3, 'Model', $2, 'Rejected', '{"kind":"lock-review","locks":["nsfw"]}', now() + interval '1 hour')`,
      [NEW_OWNER, MODEL, OWNER, MODEL + 1]
    );

    const appeal = await latestModelAppealOfKind({
      modelId: MODEL,
      userId: OWNER,
      lockReview: false,
    });

    expect(appeal?.id).toBe(expected);
  });

  it('files a new row when the owner has no row of that kind yet', async () => {
    ownModel();
    mocks.getLatestAppeal.mockResolvedValue({ id: 4, status: AppealStatus.Rejected });

    await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
    expect(mocks.createEntityAppeal).toHaveBeenCalledWith(
      expect.objectContaining({ context: { kind: 'lock-review', locks: ['nsfw'] } })
    );
  });

  it.each([true, null])('under a hold (%s) files exactly as without one', async (held) => {
    ownModel();
    const unheld = await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });
    const unheldRow = mocks.createEntityAppeal.mock.calls[0];

    mocks.isAccountUnderLegalHold.mockResolvedValue(held);
    const underHold = await createEntityAppealHandler({ input: request(['nsfw']), ctx: owner() });

    expect(underHold).toEqual(unheld);
    expect(mocks.createEntityAppeal.mock.calls[1]).toEqual(unheldRow);
  });
});

/** The owner's in-app appeal rows on MODEL, as `[id, status, context]`, filed in the order given. */
async function appealRows(...rows: [number, string, object | null][]) {
  for (const [i, [id, status, context]] of rows.entries())
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", status, context, "createdAt")
       VALUES ($1, $2, 'Model', $3, $4, $5, now() + make_interval(secs => $6))`,
      [id, OWNER, MODEL, status, context, i]
    );
}

describe('a flag landing while a lock review is open', () => {
  it('lets the owner appeal the flag on the same row', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    await appealRows([9, 'Pending', { kind: 'lock-review', locks: ['nsfw'] }]);
    dbMock.dbWrite.appeal.updateMany.mockResolvedValue({ count: 1 } as never);

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(dbMock.dbWrite.appeal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9, status: AppealStatus.Pending }),
        data: expect.objectContaining({ context: Prisma.DbNull }),
      })
    );
  });

  it('refuses the takeover when the lock review was ruled on meanwhile', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    await appealRows([9, 'Pending', { kind: 'lock-review', locks: ['nsfw'] }]);
    dbMock.dbWrite.appeal.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /changed meanwhile/
    );
  });

  it('refuses a request while an older row is pending behind a newer resolved one', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    mocks.getLatestAppeal.mockResolvedValue({ id: 12, status: AppealStatus.Rejected });
    await appealRows(
      [4, 'Pending', null],
      [12, 'Rejected', { kind: 'lock-review', locks: ['nsfw'] }]
    );

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /already under review/
    );
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });

  it('does not count a resolved row as pending', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    await appealRows([12, 'Rejected', { kind: 'lock-review', locks: ['nsfw'] }]);

    await createEntityAppealHandler({ input: request(), ctx: owner() });

    expect(mocks.createEntityAppeal).toHaveBeenCalled();
  });

  it('answers a reopen that meets another pending row in plain words', async () => {
    dbMock.dbWrite.appeal.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
    );

    expect(await refusal(actualReport.reopenAppeal({ id: 9, message: 'again' }))).toEqual({
      code: 'BAD_REQUEST',
      message: 'Your request is already under review.',
    });
  });

  it('still refuses a second flag appeal', async () => {
    ownModel({ minor: true, meta: { minorFlagSnapshot: { source: 'auto' } } });
    await appealRows([9, 'Pending', null]);

    await expect(createEntityAppealHandler({ input: request(), ctx: owner() })).rejects.toThrow(
      /already under review/
    );
    expect(mocks.reopenAppeal).not.toHaveBeenCalled();
  });
});

describe('two pending requests on one model', () => {
  it('rules on the older one when that is the one shown', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'] });
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (2, $1, 'Model', $2, $3)`,
      [OWNER, MODEL, { kind: 'lock-review', locks: ['tags'] }]
    );

    expect(await approve()).toEqual({ unlocked: ['nsfw'] });
    expect((await modelRow()).lockedProperties).toEqual(['tags']);
  });

  it('rules on the one the moderator was shown', async () => {
    await seed({ locked: ['nsfw', 'tags'], asked: ['nsfw'] });
    await db.query(
      `INSERT INTO "Appeal" (id, "userId", "entityType", "entityId", context) VALUES (2, $1, 'Model', $2, $3)`,
      [OWNER, MODEL, { kind: 'lock-review', locks: ['tags'] }]
    );

    const { unlocked } = await resolveLockReviewAppeal({
      appealId: 2,
      modelId: MODEL,
      approve: true,
      userId: MODERATOR,
    });

    expect(unlocked).toEqual(['tags']);
    expect((await modelRow()).lockedProperties).toEqual(['nsfw']);
    const { rows } = await db.query<{ id: number; status: string }>(
      `SELECT id, status FROM "Appeal" ORDER BY id`
    );
    expect(rows).toEqual([
      { id: 1, status: 'Pending' },
      { id: 2, status: 'Approved' },
    ]);
  });
});

describe('a ruling whose owner notice fails', () => {
  it('still reports the committed ruling', async () => {
    await seed({ locked: ['nsfw'] });
    mocks.settleResolvedAppeals.mockRejectedValue(new Error('notifications down'));

    await expect(approve()).resolves.toEqual({ unlocked: ['nsfw'] });
    expect((await appealRow()).status).toBe('Approved');
  });
});

describe('an owner deleting the model', () => {
  it('is told its lock review and its flag appeal closed, like any other appeal', async () => {
    // The sweep's own reads are not the subject here: nothing else is held back.
    dbMock.dbWrite.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([
      {
        id: 1,
        userId: OWNER,
        entityType: EntityType.Model,
        entityId: MODEL,
        buzzTransactionId: null,
        context: { kind: 'lock-review', locks: ['nsfw'] },
      },
      {
        id: 2,
        userId: OWNER,
        entityType: EntityType.Model,
        entityId: MODEL + 1,
        buzzTransactionId: null,
        context: null,
      },
    ] as never);

    await actualReport.closeAppealsDeletedByOwner({
      entityType: EntityType.Model,
      entityIds: [MODEL, MODEL + 1],
      ownerId: OWNER,
    });

    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
  });
});
