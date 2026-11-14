import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// kysely's `sql` tag, rendered to the statement Postgres receives and run on PGlite, so the review filters, the
// per-version merge and the keyset are checked against real rows rather than read as text.
vi.mock('@civitai/db/kysely', () => {
  const render = (f: Fragment, params: unknown[]): string =>
    f.strings.reduce((out, s, i) => {
      if (i === f.values.length) return out + s;
      const v = f.values[i];
      if (v && typeof v === 'object' && 'ident' in v) return out + s + (v as Ident).ident;
      if (v && typeof v === 'object' && 'strings' in v)
        return out + s + render(v as Fragment, params);
      params.push(v);
      return `${out}${s}$${params.length}`;
    }, '');
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Fragment & { execute: () => Promise<{ rows: unknown[] }> } = {
      strings,
      values,
      execute: async () => {
        const params: unknown[] = [];
        return { rows: (await holder.db.query(render(frag, params), params)).rows };
      },
    };
    return frag;
  };
  sql.table = (name: string): Ident => ({ ident: `"${name}"` });
  sql.ref = (name: string): Ident => ({
    ident: name
      .split('.')
      .map((p) => `"${p}"`)
      .join('.'),
  });
  sql.lit = (value: number | string): Ident => ({
    ident: typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value),
  });
  return { sql };
});

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return holder.db;
  },
  dbWrite: {},
}));

const notCounted = vi.hoisted(() => ({ ids: [] as number[] }));
vi.mock('$lib/server/metric-excluded-users', () => ({
  getMetricExcludedUserIds: async () => notCounted.ids,
}));

const { getModelLikers, modelLikersHandler } = await import('../reactors');
const { REACTORS_PAGE_SIZE } = await import('$lib/analytics/reactors');

const OWNER = 42;
const STRANGER = 7;
const MODEL = 500;
const V1 = 5001;
const V2 = 5002;
const OTHER_MODEL = 600;

const likers = async (cursor: { dir: 'after' | 'before'; userId: number } | null = null) => {
  const page = await getModelLikers(holder.db as never, OWNER, MODEL, cursor);
  return page && { ...page, ids: page.reactors.map((r) => r.userId) };
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "deletedAt" timestamp, "bannedAt" timestamp,
      "profilePictureId" int, settings jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion text, "nsfwLevel" int, url text, "needsReview" text
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int, status text, mode text, "deletedAt" timestamp
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp);
    CREATE TABLE "ModelMetric" ("modelId" int PRIMARY KEY, "thumbsUpCount" int);
    CREATE TABLE "ResourceReview" (
      id serial PRIMARY KEY, "modelVersionId" int, "userId" int, recommended boolean NOT NULL,
      exclude boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "postId" int, "createdAt" timestamp NOT NULL DEFAULT '2026-10-01',
      UNIQUE ("modelVersionId", "userId")
    );
    INSERT INTO "Model" VALUES
      (${MODEL}, ${OWNER}, 'Published', NULL, NULL), (${OTHER_MODEL}, ${STRANGER}, 'Published', NULL, NULL);
    INSERT INTO "ModelVersion" VALUES (${V1}, ${MODEL}), (${V2}, ${MODEL}), (6001, ${OTHER_MODEL});
    INSERT INTO "Post" VALUES (1, '2026-01-01'), (2, NULL), (3, now() + interval '1 day');
  `);
});

beforeEach(async () => {
  notCounted.ids = [];
  await holder.db.exec(`
    DELETE FROM "ResourceReview"; DELETE FROM "User"; DELETE FROM "UserEngagement"; DELETE FROM "Image";
    UPDATE "Model" SET status = 'Published', mode = NULL, "deletedAt" = NULL;
    DELETE FROM "ModelMetric"; INSERT INTO "ModelMetric" VALUES (${MODEL}, 1000);
  `);
});

/** A thumbs-up from each `[userId, versionId]`, creating the users. */
async function thumbsUp(rows: [userId: number, versionId: number][]) {
  const users = [...new Set(rows.map(([u]) => u))];
  await holder.db.exec(`
    INSERT INTO "User" (id, username) VALUES ${users.map((u) => `(${u}, 'u${u}')`).join(', ')}
    ON CONFLICT DO NOTHING;
    INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended)
    VALUES ${rows.map(([u, v]) => `(${u}, ${v}, true)`).join(', ')};
  `);
}

describe('Creator Studio "Who liked" a model', () => {
  it('lists thumbs-up reviewers only, the owner too, newest account first', async () => {
    await holder.db.exec(`
      INSERT INTO "User" (id, username) VALUES (10, 'up'), (11, 'down'), (12, 'excluded'), (13, 'tos'),
        (14, 'live-post'), (15, 'draft-post'), (16, 'other-model'), (17, 'scheduled-post'),
        (${OWNER}, 'owner');
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended, exclude, "tosViolation", "postId") VALUES
        (10, ${V1}, true, false, false, NULL),
        (11, ${V1}, false, false, false, NULL),
        (12, ${V1}, true, true, false, NULL),
        (13, ${V1}, true, false, true, NULL),
        (14, ${V2}, true, false, false, 1),
        (15, ${V2}, true, false, false, 2),
        (16, 6001, true, false, false, NULL),
        (17, ${V2}, true, false, false, 3),
        (${OWNER}, ${V1}, true, false, false, NULL);
    `);
    const page = await likers();
    // The site's thumbs-up total counts the owner's own, and the image panel lists the owner's own reaction.
    expect(page?.ids).toEqual([OWNER, 14, 10]);
    expect(page?.reaction).toBe('Like');
  });

  it('lists a user who liked two versions once, dated by their latest like', async () => {
    await holder.db.exec(`
      INSERT INTO "User" (id, username) VALUES (20, 'both');
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended, "createdAt") VALUES
        (20, ${V1}, true, '2026-03-01'), (20, ${V2}, true, '2026-05-01');
    `);
    const page = await likers();
    expect(page?.ids).toEqual([20]);
    expect(page?.reactors[0].reactedAt).toBe(new Date('2026-05-01T00:00:00').toISOString());
  });

  it('leaves out a hide-from-lists user and a metric-excluded one', async () => {
    await holder.db.exec(`
      INSERT INTO "User" (id, username, settings) VALUES
        (30, 'listed', '{}'), (31, 'hidden', '{"hideFromReactionLists": true}'), (32, 'farm', '{}');
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended) VALUES
        (30, ${V1}, true), (31, ${V1}, true), (32, ${V2}, true);
    `);
    notCounted.ids = [32];
    const page = await likers();
    expect(page?.ids).toEqual([30]);
  });

  it("is null for someone else's model or a takedown, and lists the owner's deleted or unpublished one", async () => {
    await holder.db.exec(`
      INSERT INTO "User" (id, username) VALUES (40, 'fan');
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended) VALUES (40, ${V1}, true);
    `);
    expect(await getModelLikers(holder.db as never, STRANGER, MODEL, null)).toBeNull();
    expect(await getModelLikers(holder.db as never, OWNER, 999_999, null)).toBeNull();

    await holder.db.exec(`UPDATE "Model" SET status = 'Unpublished' WHERE id = ${MODEL}`);
    expect((await likers())?.ids).toEqual([40]);
    await holder.db.exec(
      `UPDATE "Model" SET status = 'Deleted', "deletedAt" = now() WHERE id = ${MODEL}`
    );
    expect((await likers())?.ids).toEqual([40]);

    await holder.db.exec(`UPDATE "Model" SET status = 'UnpublishedViolation', "deletedAt" = NULL`);
    expect(await likers()).toBeNull();
    await holder.db.exec(`UPDATE "Model" SET status = 'Published', mode = 'TakenDown'`);
    expect(await likers()).toBeNull();
    await holder.db.exec(`UPDATE "Model" SET mode = 'Archived'`);
    expect((await likers())?.ids).toEqual([40]);
  });

  it('names a deleted account by nothing, shows only a scanned safe avatar, and marks followers', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, ingestion, "nsfwLevel", url) VALUES
        (1, 'Scanned', 1, 'safe.jpg'), (2, 'Scanned', 8, 'xxx.jpg'), (3, 'Pending', 1, 'unscanned.jpg');
      INSERT INTO "User" (id, username, "profilePictureId", "deletedAt") VALUES
        (60, 'safe', 1, NULL), (61, 'nsfw', 2, NULL), (62, 'unscanned', 3, NULL), (63, 'gone', 1, now());
      INSERT INTO "UserEngagement" VALUES (60, ${OWNER}, 'Follow');
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended) VALUES
        (60, ${V1}, true), (61, ${V1}, true), (62, ${V2}, true), (63, ${V2}, true);
    `);
    const page = await likers();
    expect(page?.reactors.map((r) => [r.userId, r.username, r.image, r.follows])).toEqual([
      [63, null, null, false],
      [62, 'unscanned', null, false],
      [61, 'nsfw', null, false],
      [60, 'safe', 'safe.jpg', true],
    ]);
  });

  it('hides an avatar held for CSAM review and keeps one held for another review', async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, ingestion, "nsfwLevel", url, "needsReview") VALUES
        (1, 'Scanned', 1, 'csam.jpg', 'csam'), (2, 'Scanned', 1, 'minor.jpg', 'minor'),
        (3, 'Scanned', 1, 'clean.jpg', NULL);
      INSERT INTO "User" (id, username, "profilePictureId") VALUES (70, 'a', 1), (71, 'b', 2), (72, 'c', 3);
      INSERT INTO "ResourceReview" ("userId", "modelVersionId", recommended) VALUES
        (70, ${V1}, true), (71, ${V1}, true), (72, ${V2}, true);
    `);
    const page = await likers();
    expect(page?.reactors.map((r) => [r.userId, r.image])).toEqual([
      [72, 'clean.jpg'],
      [71, 'minor.jpg'],
      [70, null],
    ]);
  });

  it("counts the site's thumbs-up total, never fewer than it lists, and none on an empty list", async () => {
    await thumbsUp([[50, V1]]);
    expect((await likers())?.counts.Like).toBe(1000);

    // The metrics job has not caught up with a new like yet.
    await holder.db.exec(`UPDATE "ModelMetric" SET "thumbsUpCount" = 0`);
    expect(await likers()).toMatchObject({ ids: [50], counts: { Like: 1 } });
    await holder.db.exec(`DELETE FROM "ModelMetric"`);
    expect(await likers()).toMatchObject({ ids: [50], counts: { Like: 1 } });

    // Nor with the last counted like withdrawn.
    await holder.db.exec(
      `INSERT INTO "ModelMetric" VALUES (${MODEL}, 1); DELETE FROM "ResourceReview"`
    );
    expect(await likers()).toMatchObject({ ids: [], counts: { Like: 0 }, next: null });
  });

  it('pages past one version holding more than a page of likers', async () => {
    const ids = Array.from({ length: REACTORS_PAGE_SIZE + 5 }, (_, i) => 300 + i);
    await thumbsUp(ids.map((u): [number, number] => [u, V1]));
    const desc = [...ids].reverse();

    const first = await likers();
    expect(first?.ids).toEqual(desc.slice(0, REACTORS_PAGE_SIZE));
    expect(first?.next).toBe(desc[REACTORS_PAGE_SIZE - 1]);
    const second = await likers({ dir: 'after', userId: Number(first?.next) });
    expect(second?.ids).toEqual(desc.slice(REACTORS_PAGE_SIZE));
  });

  it('pages across versions without skipping or repeating anyone', async () => {
    // Ids interleave between the versions, and one user is on both, so a page must merge them.
    const total = REACTORS_PAGE_SIZE + 10;
    const ids = Array.from({ length: total }, (_, i) => 100 + i);
    await thumbsUp(ids.map((u, i): [number, number] => [u, i % 2 ? V1 : V2]));
    await thumbsUp([[ids[0], V1]]);

    const first = await likers();
    const desc = [...ids].reverse();
    expect(first?.ids).toEqual(desc.slice(0, REACTORS_PAGE_SIZE));
    expect(first?.prev).toBeNull();

    expect(first?.next).toBe(desc[REACTORS_PAGE_SIZE - 1]);
    const second = await likers({ dir: 'after', userId: Number(first?.next) });
    expect(second?.ids).toEqual(desc.slice(REACTORS_PAGE_SIZE));
    expect(second?.next).toBeNull();

    expect(second?.prev).toBe(desc[REACTORS_PAGE_SIZE]);
    const back = await likers({ dir: 'before', userId: Number(second?.prev) });
    expect(back?.ids).toEqual(first?.ids);
  });
});

describe('GET /analytics/models/[modelId]/likers', () => {
  const call = (userId: number, modelId: string, qs = '') =>
    modelLikersHandler({
      locals: { user: { id: userId } },
      params: { modelId },
      url: new URL(`http://cs.test/analytics/models/${modelId}/likers${qs}`),
    } as never);

  it("answers 404 for someone else's model, the same as a missing one", async () => {
    await expect(call(STRANGER, String(MODEL))).rejects.toMatchObject({ status: 404 });
    await expect(call(OWNER, '999999')).rejects.toMatchObject({ status: 404 });
  });

  it('answers the owner, privately, at the page the cursor names', async () => {
    await thumbsUp([
      [70, V1],
      [71, V2],
    ]);
    const res = await call(OWNER, String(MODEL), '?reaction=Like&after=71');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as { reactors: { userId: number }[] };
    expect(body.reactors.map((r) => r.userId)).toEqual([70]);
  });

  it('refuses a reaction other than Like and a malformed id', async () => {
    await expect(call(OWNER, String(MODEL), '?reaction=Heart')).rejects.toMatchObject({
      status: 400,
    });
    await expect(call(OWNER, 'abc')).rejects.toMatchObject({ status: 400 });
  });
});
