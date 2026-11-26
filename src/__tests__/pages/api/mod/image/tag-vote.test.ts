import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import {
  CSAM_LINK_TABLES_SQL,
  WITHHELD_TABLES_SQL,
} from '../../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/**
 * The mod `image.tagVote` route refuses a batch with a moderator downvote on an image withheld from
 * them before it writes any vote (civitai/civitai#10583). The withheld rule runs on PGlite.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { holder, session } = vi.hoisted(() => ({
  holder: { db: null as unknown as PGlite },
  session: {
    user: { id: 7, isModerator: true, permissions: [] as string[], bannedAt: null },
  },
}));

vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));

const { default: handler } = await import('~/server/api-routes/mod/image/tag-vote');

const WITHHELD = 101; // queued
const CLEAN = 103;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    ${CSAM_LINK_TABLES_SQL}
    ${WITHHELD_TABLES_SQL}
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL, ingestion text, "needsReview" text,
      "blockedFor" text, "userId" int, "pHash" bigint, "postId" int);
    INSERT INTO "Image" (id, url, ingestion, "needsReview", "userId") VALUES (${WITHHELD}, 'key-a', 'Scanned', 'csam', 8);
    INSERT INTO "Image" (id, url, ingestion, "userId") VALUES (${CLEAN}, 'key-c', 'Scanned', 8);
  `);
});

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  session.user.permissions = [];
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ count: 0 }]);
});

function call(votes: { imageId: number; tagId: number; vote: number }[]) {
  const req = { method: 'POST', headers: {}, body: { votes }, query: {} } as Parameters<
    typeof handler
  >[0];
  let statusCode = 200;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => statusCode);
}

const votesWritten = () => dbMock.dbWrite.$executeRaw.mock.calls.length;

describe('mod image.tagVote', () => {
  it('refuses a batch with a downvote on a withheld image, and writes no vote', async () => {
    const status = await call([
      { imageId: CLEAN, tagId: 5, vote: -1 },
      { imageId: WITHHELD, tagId: 5, vote: -1 },
    ]);
    expect(status).toBe(403);
    expect(votesWritten()).toBe(0);
  });

  it('writes upvotes on a withheld image, and a clean downvote', async () => {
    const status = await call([
      { imageId: WITHHELD, tagId: 5, vote: 1 },
      { imageId: CLEAN, tagId: 6, vote: -1 },
    ]);
    expect(status).toBe(200);
    expect(votesWritten()).toBe(2);
  });

  it('writes the withheld downvote for a moderator with the grant', async () => {
    session.user.permissions = ['csamReports'];
    expect(await call([{ imageId: WITHHELD, tagId: 5, vote: -1 }])).toBe(200);
    expect(votesWritten()).toBe(1);
  });
});
