import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const h = vi.hoisted(() => ({
  db: { current: null as unknown },
  pg: { current: null as import('@electric-sql/pglite').PGlite | null },
  notifyAppealResolved: vi.fn(async (_n: unknown) => undefined),
  clearStrikeReviewFlag: vi.fn(async (_u: number) => undefined),
  recordModActivity: vi.fn(async (_a: unknown) => undefined),
  sendEmail: vi.fn(async (_e: unknown) => undefined),
  setBanned: vi.fn(),
  setMuted: vi.fn(),
  callModEndpoint: vi.fn(),
  moderateArticle: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
  get dbWrite() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
}));
vi.mock('../image-moderation-effects', () => ({ notifyAppealResolved: h.notifyAppealResolved }));
vi.mock('../strike-review.service', () => ({ clearStrikeReviewFlag: h.clearStrikeReviewFlag }));
vi.mock('../mod-activity', () => ({ recordModActivity: h.recordModActivity }));
vi.mock('../emails/appeal-resolution.email', () => ({
  siteAppealResolutionEmail: { send: h.sendEmail },
}));
vi.mock('../civitai-url', () => ({ civitaiAppUrl: () => 'https://civitai.test' }));
vi.mock('../user-actions.service', () => {
  return {
    // Reads the pglite primary as the real poll does, without its half-second waits.
    unbanConfirmed: async (userId: number) => {
      for (let i = 0; i < 3; i++) {
        const row = (
          await h.pg.current!.query<{ bannedAt: Date | null }>(
            `SELECT "bannedAt" FROM "User" WHERE id = $1`,
            [userId]
          )
        ).rows[0];
        if (row && row.bannedAt === null) return true;
      }
      return false;
    },
    setBanned: h.setBanned,
    setMuted: h.setMuted,
    callModEndpoint: h.callModEndpoint,
  };
});
vi.mock('../article-moderation', () => ({ moderateArticle: h.moderateArticle }));

const { countSiteAppeals, getSiteAppealQueue, resolveSiteAppeal, SITE_APPEAL_ALREADY_DECIDED } =
  await import('../site-appeals.service');

const SCHEMA = `
CREATE TABLE "User" (
  "id" INTEGER PRIMARY KEY,
  "username" TEXT,
  "email" TEXT,
  "bannedAt" TIMESTAMP(3),
  "muted" BOOLEAN NOT NULL DEFAULT false,
  "muteExpiresAt" TIMESTAMP(3),
  "meta" JSONB
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "category" TEXT,
  "context" JSONB,
  "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-10-01',
  "resolvedBy" INTEGER,
  "resolvedAt" TIMESTAMP(3),
  "resolvedMessage" TEXT,
  "resolvedReason" TEXT,
  "internalNotes" TEXT
);
CREATE TABLE "Article" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "title" TEXT,
  "status" TEXT,
  "ingestion" TEXT NOT NULL DEFAULT 'Scanned',
  "metadata" JSONB
);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "name" TEXT,
  "status" TEXT,
  "deletedAt" TIMESTAMP(3),
  "meta" JSONB
);
`;

const MOD = 900;
let pg: PGlite;

const appeal = async (id: number) =>
  (
    await pg.query<{ status: string; resolvedBy: number | null; resolvedMessage: string | null }>(
      `SELECT status, "resolvedBy", "resolvedMessage" FROM "Appeal" WHERE id = $1`,
      [id]
    )
  ).rows[0];

const decided = async (id: number) =>
  (
    await pg.query<{
      resolvedReason: string | null;
      internalNotes: string | null;
      resolvedAt: Date | null;
    }>(`SELECT "resolvedReason", "internalNotes", "resolvedAt" FROM "Appeal" WHERE id = $1`, [id])
  ).rows[0];

const decide = (
  appealId: number,
  category: 'Account' | 'Article' | 'Model' | 'Other',
  decision: 'Approved' | 'Rejected',
  canBan = true
) =>
  resolveSiteAppeal({
    appealId,
    category,
    decision,
    resolvedReason: decision === 'Approved' ? 'misclassified' : 'violation-confirmed',
    resolvedMessage: 'Thanks for explaining.',
    internalNotes: 'checked the history',
    moderatorId: MOD,
    canBan,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  pg = await freshPglite();
  await pg.exec(SCHEMA);
  await pg.exec(`
    INSERT INTO "User" ("id", "username", "email", "bannedAt", "muted") VALUES
      (1, 'banned-and-muted', 'one@test', '2026-09-01', true),
      (2, 'author', 'two@test', NULL, false),
      (3, 'other', 'three@test', NULL, false),
      (4, 'banned', 'four@test', '2026-09-01', false),
      (5, 'muted-only', 'five@test', NULL, true),
      (6, 'clean', 'six@test', NULL, false),
      (7, 'no-email', NULL, NULL, false),
      (8, 'banned-owner', 'eight@test', '2026-09-01', false);
    INSERT INTO "Article" ("id", "userId", "title", "status", "metadata") VALUES
      (20, 2, 'Removed', 'UnpublishedViolation', '{"unpublishedReason":"spam"}'),
      (21, 2, 'Live again', 'Published', NULL),
      (22, 8, 'Banned owner article', 'UnpublishedViolation', NULL);
    INSERT INTO "Model" ("id", "userId", "name", "status", "meta") VALUES
      (30, 2, 'Removed model', 'UnpublishedViolation', NULL),
      (31, 8, 'Banned owner model', 'UnpublishedViolation', NULL);
    INSERT INTO "Appeal" ("id", "userId", "category", "entityType", "entityId", "status", "appealMessage", "createdAt", "context") VALUES
      (101, 1, 'Account', 'User', 1, 'Pending', 'unban me', '2026-10-02', '{"restriction":{"banned":true,"muted":true}}'),
      (100, 1, 'Account', 'User', 1, 'Rejected', 'first try', '2026-08-01', NULL),
      (102, 2, 'Article', 'Article', 20, 'Pending', 'not spam', '2026-10-01', NULL),
      (103, 2, 'Article', 'Article', 21, 'Pending', 'already back', '2026-10-03', NULL),
      (104, 3, 'Other', 'User', 3, 'Pending', 'about my profile', '2026-10-01', '{"subject":"Profile"}'),
      (105, 3, 'Other', 'User', 3, 'Approved', 'earlier other', '2026-07-01', NULL),
      (106, 2, 'Model', 'Model', 30, 'Pending', 'my model', '2026-10-01', NULL),
      (107, 4, 'Account', 'User', 4, 'Pending', 'banned only', '2026-10-04', NULL),
      (108, 2, NULL, 'Article', 20, 'Pending', 'in-app appeal', '2026-09-01', NULL),
      (109, 5, 'Account', 'User', 5, 'Pending', 'muted only', '2026-10-05', NULL),
      (110, 6, 'Account', 'User', 6, 'Pending', 'nothing left', '2026-10-06', NULL),
      (111, 7, 'Other', 'User', 7, 'Pending', 'no email', '2026-10-05', NULL),
      (112, 8, 'Article', 'Article', 22, 'Pending', 'banned owner', '2026-10-06', NULL),
      (113, 8, 'Model', 'Model', 31, 'Pending', 'banned owner', '2026-10-06', NULL),
      (114, 3, 'Article', 'Article', 20, 'Rejected', 'someone else', '2026-08-01', NULL);
  `);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
  h.pg.current = pg;
  h.moderateArticle.mockImplementation(async ({ articleId }: { articleId: number }) => {
    await pg.query(`UPDATE "Article" SET status = 'Published' WHERE id = $1`, [articleId]);
    return { ok: true };
  });
  h.setBanned.mockImplementation(async ({ userId }: { userId: number }) => {
    await pg.query(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [userId]);
    return { ok: true };
  });
  h.setMuted.mockResolvedValue({ ok: true });
  h.callModEndpoint.mockResolvedValue({ ok: true, body: { status: 'Published' } });
  // PGlite boots per test; under a loaded full run the first boot overran the 10s default.
}, 60_000);

afterEach(async () => {
  h.db.current = null;
  h.pg.current = null;
  await pg.close();
});

describe('site appeal queues', () => {
  it('lists only its own category, Pending, oldest first; never an in-app appeal', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Article', limit: 10, offset: 0 });
    expect(items.map((r) => r.id)).toEqual([102, 103, 112]);
  });

  it('pages oldest first and says when there is more', async () => {
    const first = await getSiteAppealQueue({ category: 'Article', limit: 2, offset: 0 });
    expect([first.items.map((r) => r.id), first.hasMore]).toEqual([[102, 103], true]);
    const last = await getSiteAppealQueue({ category: 'Article', limit: 2, offset: 2 });
    expect([last.items.map((r) => r.id), last.hasMore]).toEqual([[112], false]);
  });

  it('counts each queue', async () => {
    expect(await countSiteAppeals()).toEqual({ Account: 4, Article: 3, Model: 2, Other: 2 });
  });

  it('shows the appealed thing as it is now, with its owner', async () => {
    const articles = await getSiteAppealQueue({ category: 'Article', limit: 10, offset: 0 });
    expect(articles.items.find((r) => r.id === 102)!.subject).toEqual({
      kind: 'article',
      title: 'Removed',
      status: 'UnpublishedViolation',
      ownerBanned: false,
      unpublishedReason: 'spam',
      customMessage: null,
      unpublishedAt: null,
    });
    expect(articles.items.find((r) => r.id === 112)!.subject).toMatchObject({ ownerBanned: true });
    const accounts = await getSiteAppealQueue({ category: 'Account', limit: 10, offset: 0 });
    expect(accounts.items.find((r) => r.id === 101)!.subject).toMatchObject({
      kind: 'account',
      muted: true,
      bannedAt: expect.any(Date),
    });
  });

  it('marks a repeat with the earlier appeals about the same thing', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Account', limit: 10, offset: 0 });
    const row = items.find((r) => r.id === 101)!;
    expect(row.priors.map((p) => [p.id, p.status])).toEqual([[100, 'Rejected']]);
    expect(items.find((r) => r.id === 107)!.priors).toEqual([]);
  });

  it('never marks an Other appeal as a repeat', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Other', limit: 10, offset: 0 });
    expect(items.map((r) => [r.id, r.priors.length])).toEqual([
      [104, 0],
      [111, 0],
    ]);
  });

  it('counts only the same user, category and item as a repeat', async () => {
    // 114 is another user's appeal on article 20; 108 is the same user's in-app appeal on it.
    const { items } = await getSiteAppealQueue({ category: 'Article', limit: 10, offset: 0 });
    expect(items.find((r) => r.id === 102)!.priors).toEqual([]);
  });
});

describe('resolveSiteAppeal', () => {
  it('refuses an appeal from another queue, so one queue grant cannot decide another', async () => {
    const result = await decide(101, 'Other', 'Approved');
    expect(result).toEqual({ ok: false, error: SITE_APPEAL_ALREADY_DECIDED, conflict: true });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect((await appeal(101)).status).toBe('Pending');
  });

  it('refuses an appeal that is already decided', async () => {
    expect(await decide(100, 'Account', 'Approved')).toMatchObject({ ok: false, conflict: true });
    expect(h.setBanned).not.toHaveBeenCalled();
  });

  it('approving an account appeal lifts the ban and the mute, then closes it', async () => {
    const result = await decide(101, 'Account', 'Approved');
    expect(result).toEqual({ ok: true, lifted: ['ban', 'mute'], restored: true });
    expect(h.setBanned).toHaveBeenCalledWith({ userId: 1, ban: false, moderatorId: MOD });
    expect(h.setMuted).toHaveBeenCalledWith({ userId: 1, muted: false, moderatorId: MOD });
    expect(await appeal(101)).toEqual({
      status: 'Approved',
      resolvedBy: MOD,
      resolvedMessage: 'Thanks for explaining.',
    });
  });

  it('without the Ban permission, refuses before lifting anything', async () => {
    const result = await decide(101, 'Account', 'Approved', false);
    expect(result).toMatchObject({ ok: false });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect(h.setMuted).not.toHaveBeenCalled();
    expect((await appeal(101)).status).toBe('Pending');
    expect(h.notifyAppealResolved).not.toHaveBeenCalled();
  });

  it('leaves the appeal Pending when the lift fails', async () => {
    h.moderateArticle.mockResolvedValue({ ok: false, error: 'Article is not unpublished' });
    const result = await decide(102, 'Article', 'Approved');
    expect(result).toEqual({ ok: false, error: 'Article is not unpublished' });
    expect((await appeal(102)).status).toBe('Pending');
    expect(h.notifyAppealResolved).not.toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('leaves the appeal Pending when the unban never lands', async () => {
    h.setBanned.mockResolvedValue({ ok: true });
    const result = await decide(107, 'Account', 'Approved');
    expect(result).toMatchObject({ ok: false });
    expect((await appeal(107)).status).toBe('Pending');
  }, 10_000);

  it('approving a removed article restores it', async () => {
    expect(await decide(102, 'Article', 'Approved')).toEqual({
      ok: true,
      lifted: ['article'],
      restored: true,
    });
    expect(h.moderateArticle).toHaveBeenCalledWith({
      action: 'restore',
      articleId: 20,
      userId: MOD,
    });
  });

  it('an article already live but hidden by its scan state is not called restored', async () => {
    await pg.query(`UPDATE "Article" SET ingestion = 'Pending' WHERE id = 21`);
    expect(await decide(103, 'Article', 'Approved')).toEqual({
      ok: true,
      lifted: [],
      restored: false,
    });
  });

  it('a refused unban is reported as refused, not as possibly done', async () => {
    h.setBanned.mockResolvedValue({ ok: false, error: 'Ban endpoint returned 403.' });
    expect(await decide(107, 'Account', 'Approved')).toEqual({
      ok: false,
      error: 'Ban endpoint returned 403.',
    });
  });

  it('approving an article that is already live restores nothing and still closes', async () => {
    expect(await decide(103, 'Article', 'Approved')).toEqual({
      ok: true,
      lifted: [],
      restored: true,
    });
    expect(h.moderateArticle).not.toHaveBeenCalled();
    expect((await appeal(103)).status).toBe('Approved');
  });

  it('approving a removed model republishes it through the main app', async () => {
    expect(await decide(106, 'Model', 'Approved')).toEqual({
      ok: true,
      lifted: ['model'],
      restored: true,
    });
    expect(h.callModEndpoint).toHaveBeenCalledWith('model/republish', { modelId: 30 }, 'Republish');
  });

  it('rejecting lifts nothing, and tells the appellant in-app and by email', async () => {
    expect(await decide(101, 'Account', 'Rejected')).toEqual({
      ok: true,
      lifted: [],
      restored: false,
    });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect(h.setMuted).not.toHaveBeenCalled();
    expect(h.notifyAppealResolved).toHaveBeenCalledWith({
      appeal: expect.objectContaining({ id: 101, userId: 1 }),
      entityType: 'User',
      entityId: 1,
      status: 'Rejected',
      resolvedMessage: 'Thanks for explaining.',
      details: { category: 'Account', restored: false },
    });
    expect(h.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'one@test', category: 'Account', approved: false })
    );
  });

  it('approving an Other appeal records the decision only', async () => {
    expect(await decide(104, 'Other', 'Approved')).toEqual({
      ok: true,
      lifted: [],
      restored: false,
    });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect(h.moderateArticle).not.toHaveBeenCalled();
    expect(h.callModEndpoint).not.toHaveBeenCalled();
  });

  it('records the decision, its reason and note, and the moderator activity', async () => {
    await decide(102, 'Article', 'Approved');
    expect(await decided(102)).toEqual({
      resolvedReason: 'misclassified',
      internalNotes: 'checked the history',
      resolvedAt: expect.any(Date),
    });
    expect(h.recordModActivity).toHaveBeenCalledWith({
      userId: MOD,
      entityType: 'article',
      entityId: 20,
      activity: 'resolveAppeal',
    });
  });

  it('tells the appellant what an approval put back, in-app and by email', async () => {
    await decide(101, 'Account', 'Approved');
    expect(h.notifyAppealResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'Approved',
        details: { category: 'Account', restored: true },
      })
    );
    expect(h.sendEmail).toHaveBeenCalledWith({
      to: 'one@test',
      username: 'banned-and-muted',
      category: 'Account',
      approved: true,
      restored: true,
      appealUrl: 'https://civitai.test/appeal',
    });
  });

  it('skips the email for an appellant with no address', async () => {
    expect(await decide(111, 'Other', 'Rejected')).toMatchObject({ ok: true });
    expect(h.notifyAppealResolved).toHaveBeenCalled();
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('a muted-only account needs no Ban permission, and its strike review flag is cleared', async () => {
    expect(await decide(109, 'Account', 'Approved', false)).toEqual({
      ok: true,
      lifted: ['mute'],
      restored: true,
    });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect(h.clearStrikeReviewFlag).toHaveBeenCalledWith(5);
  });

  it('an account with nothing left to lift is approved without claiming a lift', async () => {
    expect(await decide(110, 'Account', 'Approved')).toEqual({
      ok: true,
      lifted: [],
      restored: false,
    });
    expect(h.setBanned).not.toHaveBeenCalled();
    expect(h.setMuted).not.toHaveBeenCalled();
  });

  it('says so when the unban landed but the unmute did not, and leaves the appeal open', async () => {
    h.setMuted.mockResolvedValue({ ok: false, error: 'Unmute failed.', requestNeverSent: true });
    expect(await decide(101, 'Account', 'Approved')).toEqual({
      ok: false,
      error: 'Unbanned, but the mute was not lifted: Unmute failed.',
    });
    expect((await appeal(101)).status).toBe('Pending');
  });

  it('a lost response is reported as possibly done, not as failed', async () => {
    h.callModEndpoint.mockResolvedValue({ ok: false, error: 'Republish failed.' });
    const result = await decide(106, 'Model', 'Approved');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toMatch(/may still have gone through/);
    expect((await appeal(106)).status).toBe('Pending');
  });

  it('a refusal from the main app is reported as it was', async () => {
    h.callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Model is not unpublished as a violation',
      status: 400,
    });
    expect(await decide(106, 'Model', 'Approved')).toEqual({
      ok: false,
      error: 'Model is not unpublished as a violation',
    });
  });

  it('a republish the main app held for review is approved without saying it is live', async () => {
    h.callModEndpoint.mockResolvedValue({ ok: true, body: { status: 'UnpublishedViolation' } });
    expect(await decide(106, 'Model', 'Approved')).toEqual({
      ok: true,
      lifted: ['model'],
      restored: false,
    });
  });

  it('an article restored but left hidden by its scan state is not called restored', async () => {
    h.moderateArticle.mockImplementation(async ({ articleId }: { articleId: number }) => {
      await pg.query(
        `UPDATE "Article" SET status = 'Published', ingestion = 'Blocked' WHERE id = $1`,
        [articleId]
      );
      return { ok: true };
    });
    expect(await decide(102, 'Article', 'Approved')).toEqual({
      ok: true,
      lifted: ['article'],
      restored: false,
    });
  });

  it.each([
    ['article', 112, 'Article'],
    ['model', 113, 'Model'],
  ] as const)("refuses to put back a banned owner's %s", async (_label, id, category) => {
    const result = await decide(id, category, 'Approved');
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/owner is banned/) });
    expect(h.moderateArticle).not.toHaveBeenCalled();
    expect(h.callModEndpoint).not.toHaveBeenCalled();
    expect((await appeal(id)).status).toBe('Pending');
  });
});
