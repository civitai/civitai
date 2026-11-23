import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCookieName } from '@civitai/auth';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { createQueueDb } from '../../test/pglite-kysely';
import { lockImage, seedImage } from '../../test/seed';

const NOW = new Date('2026-12-15T12:00:00Z');
const MOD = 7;
const OTHER = 8;
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/server/db', () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { now: () => NOW } }));
vi.mock('$lib/server/skill-check/runtime', () => ({
  skillChecks: async () => ({ enabled: true, poolCap: 500, serveJudged: false }),
}));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));

const { sealItem, sealReview } = await import('$lib/server/feed-token');
const { inquisitorActions, inquisitorView } = await import('./inquisitor.server');

let pg: PGlite;
let db: Kysely<DB>;
const fetchMock = vi.fn<typeof fetch>();
const SESSION = `${sessionCookieName()}=mod-session`;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  holder.db = db;
});
afterAll(() => pg.close());
beforeEach(async () => {
  process.env.CIVITAI_APP_URL = 'https://main.example';
  vi.stubGlobal('fetch', fetchMock);
  await pg.exec(
    `TRUNCATE "ModActivity","KnightsInquisitorVote","KnightsInquisitorReview","KnightsReferenceImage","KnightsQueueItem","Image","Post","Report","ImageReport" RESTART IDENTITY CASCADE`
  );
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.CIVITAI_APP_URL;
});

/** A written-back item at R with its review open, and `votes` already cast by other moderators. */
async function review(votes: { moderatorId: number; answer: string }[] = []) {
  await seedImage(pg, 1);
  await lockImage(pg, 1, { reason: KNIGHTS_VOTE_NSFW_LEVEL_REASON, level: 4 });
  await pg.query(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","appliedAt") VALUES ('knights.image.nsfwLevel',1,'t','Knight',3,'Resolved','4',$1)`,
    [NOW]
  );
  const id = (
    await pg.query<{ id: number }>(
      `INSERT INTO "KnightsInquisitorReview" ("queueItemId","imageId","questionKey","consensusValue") VALUES (1,1,'knights.image.nsfwLevel','4') RETURNING id`
    )
  ).rows[0].id;
  for (const v of votes)
    await pg.query(
      `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer") VALUES ($1,$2,$3)`,
      [id, v.moderatorId, v.answer]
    );
  return id;
}

const call = (
  action: keyof typeof inquisitorActions,
  fields: Record<string, string>,
  user: Record<string, unknown> = { id: MOD, isModerator: true }
) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return inquisitorActions[action]({
    request: new Request('http://knights.test/play', {
      method: 'POST',
      body,
      headers: { cookie: `theme=dark; ${SESSION}` },
    }),
    locals: { user },
  } as never);
};
const counts = async () =>
  (
    await pg.query(
      `SELECT (SELECT count(*)::int FROM "KnightsInquisitorVote") AS votes,
              (SELECT count(*)::int FROM "KnightsQueueItem" WHERE status='Inquisitor') AS sent`
    )
  ).rows[0];

describe('inquisitor actions', () => {
  it.each(['inquisitorVote', 'sendToInquisitor'] as const)(
    'refuses a player who is not a moderator with 403 and writes nothing (%s)',
    async (action) => {
      const id = await review();
      await expect(
        call(
          action,
          { token: sealReview('secret', MOD, id), answer: '4' },
          { id: MOD, isModerator: false }
        )
      ).rejects.toMatchObject({ status: 403 });
      expect(await counts()).toEqual({ votes: 0, sent: 0 });
    }
  );

  it.each([
    ['a tampered token', () => 'x'.repeat(40)],
    ["another moderator's token", () => sealReview('secret', OTHER, 1)],
    ['a feed item token', () => sealItem('secret', MOD, { kind: 'queue', id: 1 })],
  ])('refuses %s with 400 and writes nothing', async (_label, token) => {
    await review();
    expect(await call('inquisitorVote', { token: token(), answer: '4' })).toMatchObject({
      status: 400,
    });
    expect(await counts()).toEqual({ votes: 0, sent: 0 });
  });

  it("writes an agreed new level through the main app with only the moderator's session, then confirms", async () => {
    const id = await review([{ moderatorId: OTHER, answer: '8' }]);
    // The main app writes the ruling as the moderator, as its endpoint does.
    fetchMock.mockImplementation(async () => {
      await lockImage(pg, 1, { reason: 'moderator', level: 8 });
      await pg.query(
        `INSERT INTO "ModActivity" ("userId","activity","entityType","entityId","createdAt") VALUES ($1,'setNsfwLevel','image',1,$2)`,
        [MOD, NOW]
      );
      return new Response('{"count":1}', { status: 200 });
    });

    expect(
      await call('inquisitorVote', { token: sealReview('secret', MOD, id), answer: '8' })
    ).toEqual({
      reviewed: 'confirmed',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/image/set-nsfw-level');
    expect(new Headers(init?.headers).get('cookie')).toBe(SESSION);
    expect((await pg.query(`SELECT pool,source,answer FROM "KnightsReferenceImage"`)).rows).toEqual(
      [{ pool: 'skillCheck', source: 'inquisitor', answer: '8' }]
    );
  });

  it('turns a refusal into a 409 with words for the moderator', async () => {
    const id = await review([
      { moderatorId: OTHER, answer: '4' },
      { moderatorId: 9, answer: '8' },
    ]);
    await pg.query(`UPDATE "KnightsInquisitorReview" SET status='split' WHERE id=$1`, [id]);
    expect(
      await call('inquisitorVote', { token: sealReview('secret', MOD, id), answer: '4' })
    ).toMatchObject({
      status: 409,
      data: { message: expect.stringContaining('closed') },
    });
  });

  it('tells the moderator when the image came under a hold and their vote was not recorded', async () => {
    const id = await review();
    await pg.query(`UPDATE "Image" SET "tosViolation"=true WHERE id=1`);
    expect(
      await call('inquisitorVote', { token: sealReview('secret', MOD, id), answer: '4' })
    ).toMatchObject({
      reviewed: 'excluded',
      message: expect.stringContaining('your vote was not recorded'),
    });
  });

  it.each([
    ['closed by another moderator', 'not-open', true],
    ['held by a hold that may lift', 'held', true],
    ['already voted on', 'already-voted', true],
    ['claimed by another moderator', 'claimed', true],
    ['unreadable for now', 'unavailable', false],
  ])(
    'after a refusal because the review was %s, says whether the page moves to the next one',
    async (_label, reason, next) => {
      const id = await review([{ moderatorId: OTHER, answer: '4' }]);
      if (reason === 'not-open')
        await pg.query(`UPDATE "KnightsInquisitorReview" SET status='split' WHERE id=$1`, [id]);
      if (reason === 'held') {
        await pg.query(`INSERT INTO "Report" ("id","status") VALUES (90,'Pending')`);
        await pg.query(`INSERT INTO "ImageReport" ("reportId","imageId") VALUES (90,1)`);
      }
      if (reason === 'already-voted')
        await pg.query(
          `INSERT INTO "KnightsInquisitorVote" ("reviewId","moderatorId","answer") VALUES ($1,$2,'4')`,
          [id, MOD]
        );
      if (reason === 'claimed')
        await pg.query(
          `UPDATE "KnightsInquisitorReview" SET "claimedBy"=9,"claimExpiresAt"=$1 WHERE id=$2`,
          [new Date(NOW.getTime() + 60_000), id]
        );
      if (reason === 'unavailable')
        await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        expect(
          await call('inquisitorVote', { token: sealReview('secret', MOD, id), answer: '4' })
        ).toMatchObject({
          status: 409,
          data: { next },
        });
      } finally {
        if (reason === 'unavailable')
          await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
      }
    }
  );

  it('sends a sealed review to the Inquisitors', async () => {
    const id = await review();
    expect(await call('sendToInquisitor', { token: sealReview('secret', MOD, id) })).toEqual({
      reviewed: 'sent',
    });
    expect(await counts()).toEqual({ votes: 0, sent: 1 });
  });
});

describe('inquisitorView', () => {
  it('serves a moderator a review by sealed token, never by its id', async () => {
    await review();
    const view = await inquisitorView(MOD);
    expect(view.mode).toBe('inquisitor');
    expect(view.levels.map((l) => l.value)).toEqual(['1', '2', '4', '8', '16']);
    expect(JSON.stringify(view)).not.toMatch(/"reviewId"|"queueItemId"/);
    expect(view.review).toMatchObject({ token: expect.any(String) });
  });

  it('says the queue cannot load, instead of showing it empty, when the safety reads fail', async () => {
    await review();
    await pg.query(`ALTER TABLE "ImageFlag" RENAME TO "ImageFlagGone"`);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const view = await inquisitorView(MOD);
      expect(view).toMatchObject({ unreadable: true, review: false });
      expect(view.stats.waiting).toBeNull();
    } finally {
      await pg.query(`ALTER TABLE "ImageFlagGone" RENAME TO "ImageFlag"`);
    }
  });
});
