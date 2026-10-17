import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const h = vi.hoisted(() => ({
  db: { current: null as unknown },
  createNotification: vi.fn(async (_n: unknown) => undefined),
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
vi.mock('../notifications', () => ({
  getNotifications: () => ({ createNotification: h.createNotification }),
}));
vi.mock('../mod-activity', () => ({ recordModActivity: h.recordModActivity }));
vi.mock('../emails/appeal-resolution.email', () => ({
  siteAppealResolutionEmail: { send: h.sendEmail },
}));
vi.mock('../civitai-url', () => ({ civitaiAppUrl: () => 'https://civitai.test' }));
vi.mock('../user-actions.service', () => ({
  setBanned: h.setBanned,
  setMuted: h.setMuted,
  callModEndpoint: h.callModEndpoint,
}));
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
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "title" TEXT, "status" TEXT, "metadata" JSONB);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY,
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
    moderatorId: MOD,
    canBan,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  await pg.exec(`
    INSERT INTO "User" ("id", "username", "email", "bannedAt", "muted") VALUES
      (1, 'banned-and-muted', 'one@test', '2026-09-01', true),
      (2, 'author', 'two@test', NULL, false),
      (3, 'other', 'three@test', NULL, false),
      (4, 'banned', 'four@test', '2026-09-01', false);
    INSERT INTO "Article" ("id", "title", "status", "metadata") VALUES
      (20, 'Removed', 'UnpublishedViolation', '{"unpublishedReason":"spam"}'),
      (21, 'Live again', 'Published', NULL);
    INSERT INTO "Model" ("id", "name", "status", "meta") VALUES (30, 'Removed model', 'UnpublishedViolation', NULL);
    INSERT INTO "Appeal" ("id", "userId", "category", "entityType", "entityId", "status", "appealMessage", "createdAt", "context") VALUES
      (101, 1, 'Account', 'User', 1, 'Pending', 'unban me', '2026-10-02', '{"restriction":{"banned":true,"muted":true}}'),
      (100, 1, 'Account', 'User', 1, 'Rejected', 'first try', '2026-08-01', NULL),
      (102, 2, 'Article', 'Article', 20, 'Pending', 'not spam', '2026-10-01', NULL),
      (103, 2, 'Article', 'Article', 21, 'Pending', 'already back', '2026-10-03', NULL),
      (104, 3, 'Other', 'User', 3, 'Pending', 'about my profile', '2026-10-01', '{"subject":"Profile"}'),
      (105, 3, 'Other', 'User', 3, 'Approved', 'earlier other', '2026-07-01', NULL),
      (106, 2, 'Model', 'Model', 30, 'Pending', 'my model', '2026-10-01', NULL),
      (107, 4, 'Account', 'User', 4, 'Pending', 'banned only', '2026-10-04', NULL),
      (108, 2, NULL, 'Article', 20, 'Pending', 'in-app appeal', '2026-09-01', NULL);
  `);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
  h.setBanned.mockImplementation(async ({ userId }: { userId: number }) => {
    await pg.query(`UPDATE "User" SET "bannedAt" = NULL WHERE id = $1`, [userId]);
    return { ok: true };
  });
  h.setMuted.mockResolvedValue({ ok: true });
  h.callModEndpoint.mockResolvedValue({ ok: true, body: { status: 'Published' } });
  h.moderateArticle.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  h.db.current = null;
  await pg.close();
});

describe('site appeal queues', () => {
  it('lists only its own category, Pending, oldest first; never an in-app appeal', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Article', limit: 10, offset: 0 });
    expect(items.map((r) => r.id)).toEqual([102, 103]);
  });

  it('counts each queue', async () => {
    expect(await countSiteAppeals()).toEqual({ Account: 2, Article: 2, Model: 1, Other: 1 });
  });

  it('marks a repeat with the earlier appeals about the same thing', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Account', limit: 10, offset: 0 });
    const row = items.find((r) => r.id === 101)!;
    expect(row.priors.map((p) => [p.id, p.status])).toEqual([[100, 'Rejected']]);
    expect(items.find((r) => r.id === 107)!.priors).toEqual([]);
  });

  it('never marks an Other appeal as a repeat', async () => {
    const { items } = await getSiteAppealQueue({ category: 'Other', limit: 10, offset: 0 });
    expect(items.map((r) => [r.id, r.priors.length])).toEqual([[104, 0]]);
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
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('leaves the appeal Pending when the lift fails', async () => {
    h.moderateArticle.mockResolvedValue({ ok: false, error: 'Article is not unpublished' });
    const result = await decide(102, 'Article', 'Approved');
    expect(result).toEqual({ ok: false, error: 'Article is not unpublished' });
    expect((await appeal(102)).status).toBe('Pending');
    expect(h.createNotification).not.toHaveBeenCalled();
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
    expect(h.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        type: 'entity-appeal-resolved',
        details: expect.objectContaining({ category: 'Account', status: 'Rejected' }),
      })
    );
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
});
