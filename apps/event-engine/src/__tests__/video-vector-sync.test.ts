import { describe, expect, test } from 'vitest';
import { backfillDomain } from '@/vector-sync/domain/backfill';
import { nextRefreshIds } from '@/vector-sync/domain/refresh';
import { syncIds, type RejectedMemo } from '@/vector-sync/domain/sync';
import type { EmbedInput } from '@/vector-sync/embedder';
import { videoDomain, videoRefFromEvent } from '@/vector-sync/videos/domain';
import { VectorStore } from '@/vector-sync/qdrant';
import { VIDEO_COLLECTION } from '@/vector-sync/videos/collection';
import { kvRejectedMemo } from '@/vector-sync/videos/rejected';
import { getVideoDocs, type VideoPayload } from '@/vector-sync/videos/source';

const SCHEMA = `
  CREATE TABLE "Image" (id int PRIMARY KEY, url text, type text, "nsfwLevel" int DEFAULT 1,
    "userId" int DEFAULT 7, "postId" int DEFAULT 1, "sortAt" timestamp DEFAULT '2026-11-01',
    ingestion text DEFAULT 'Scanned', "tosViolation" boolean DEFAULT false, "blockedFor" text,
    "needsReview" text, minor boolean DEFAULT false, poi boolean DEFAULT false, "sizeKB" int,
    width int, height int, metadata jsonb DEFAULT '{}');
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean DEFAULT false);
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "baseModel" text);
  CREATE TABLE "ImageResourceNew" ("imageId" int, "modelVersionId" int);
`;

/** A scanned, posted video `id`, 10 s and 5 MiB unless overridden. */
const video = (id: number, extra = '') =>
  `INSERT INTO "Image" (id, url, type, "sizeKB", metadata) VALUES
     (${id}, 'key-${id}', 'video', 5120, '{"duration": 10}');${extra}`;

async function pglite(seed = '') {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(SCHEMA + seed);
  return pg;
}

type Pg = Parameters<typeof getVideoDocs>[0];

/** `refuse`: ids that fail; `media`: the subset failing as the media's fault (default: all). */
function fakes(pg: unknown, refuse: number[] = [], media: number[] = refuse) {
  const points = new Map<number, VideoPayload>();
  const sent: EmbedInput[] = [];
  const store = {
    payloadFields: async (ids: number[]) =>
      new Map(ids.flatMap((id) => (points.has(id) ? [[id, points.get(id)!] as const] : []))),
    delete: async (ids: number[]) => ids.forEach((id) => points.delete(id)),
    setPayloads: async (p: Map<number, VideoPayload>) =>
      p.forEach((payload, id) => points.set(id, payload)),
    upsert: async (ps: { id: number; payload: VideoPayload }[]) =>
      ps.forEach((p) => points.set(p.id, p.payload)),
    assertModel: async () => undefined,
    idsInRange: async (lo: number, hi: number) =>
      [...points.keys()].filter((id) => id >= lo && id < hi).sort((a, b) => a - b),
  };
  const embedder = {
    embed: async (inputs: EmbedInput[]) => {
      sent.push(...inputs);
      const ok = inputs.filter((i) => !refuse.includes(Number(i.id)));
      const failed = inputs.filter((i) => refuse.includes(Number(i.id))).map((i) => Number(i.id));
      return {
        vectors: new Map(ok.map((i) => [Number(i.id), [1]])),
        failed,
        rejected: failed.filter((id) => media.includes(id)),
        stamp: null,
      };
    },
  };
  const memo = new Map<string, string>();
  const rejected = kvRejectedMemo(
    {
      mGet: async (keys) => keys.map((k) => memo.get(k) ?? null),
      set: async (k, v) => void memo.set(k, v),
    },
    'videos_test'
  );
  const deps = { pg, store, embedder, embedInput: videoDomain.embedInput, rejected } as never;
  return { points, sent, deps, store, embedder, rejected };
}

describe('which videos get a point', () => {
  test('an eligible video carries the image payload; images and ineligible videos get none', async () => {
    const pg = await pglite(`
      ${video(1)}
      INSERT INTO "Image" (id, url, type) VALUES (2, 'key-2', 'image');
      ${video(3, `UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = 3;`)}
      ${video(4, `UPDATE "Image" SET ingestion = 'Pending' WHERE id = 4;`)}
      ${video(5, `UPDATE "Image" SET "postId" = NULL WHERE id = 5;`)}
      INSERT INTO "TagsOnImageDetails" VALUES (1, 30, false), (1, 20, false), (1, 40, true);
      INSERT INTO "ModelVersion" VALUES (9, 'Wan Video');
      INSERT INTO "ImageResourceNew" VALUES (1, 9);
      UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 1;
    `);
    try {
      const docs = await getVideoDocs(pg as unknown as Pg, [1, 2, 3, 4, 5]);
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        nsfwLevel: 4,
        tagIds: [20, 30],
        baseModels: ['Wan Video'],
        modelVersionIds: [9],
        type: 'video',
        userId: 7,
        postId: 1,
        url: 'key-1',
        search_text: '',
      });
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('a Blocked rating is not written, and removes a point it lands on', async () => {
    const pg = await pglite(`
      ${video(1)} ${video(2)} ${video(3)}
      UPDATE "Image" SET "nsfwLevel" = 32 WHERE id = 2;
      UPDATE "Image" SET "nsfwLevel" = 16 WHERE id = 3;
    `);
    try {
      const { points, deps } = fakes(pg);
      await syncIds(getVideoDocs, [1, 2, 3], deps);
      expect([...points.keys()].sort()).toEqual([1, 3]);
      expect(points.get(3)?.nsfwLevel).toBe(16);

      await pg.exec(`UPDATE "Image" SET "nsfwLevel" = 32 WHERE id = 1`);
      await syncIds(getVideoDocs, [1], deps);
      expect([...points.keys()]).toEqual([3]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('held media and held owners get no point', async () => {
    const pg = await pglite(`
      ${video(1)} ${video(2)} ${video(3)}
      UPDATE "Image" SET "userId" = 8 WHERE id = 2;
      INSERT INTO "EvidenceHeldUser" VALUES (8);
      INSERT INTO "CsamReport" ("userId", images) VALUES (99, '[3]');
    `);
    try {
      expect([...(await getVideoDocs(pg as unknown as Pg, [1, 2, 3])).keys()]).toEqual([1]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('a clip stored off our CDN gets no document', async () => {
    const pg = await pglite(
      `${video(1)} UPDATE "Image" SET url = 'https://elsewhere.example/a.mp4' WHERE id = 1;`
    );
    try {
      expect((await getVideoDocs(pg as unknown as Pg, [1])).size).toBe(0);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('clips past the worker limits are never documents, so never sent', async () => {
    const pg = await pglite(`
      ${video(1)} ${video(2)} ${video(3)} ${video(4)}
      UPDATE "Image" SET metadata = '{"duration": 61}' WHERE id = 2;
      UPDATE "Image" SET "sizeKB" = 102401 WHERE id = 3;
      UPDATE "Image" SET metadata = '{"duration": 60}', "sizeKB" = 102400 WHERE id = 4;
    `);
    try {
      const { sent, deps } = fakes(pg);
      const stats = await syncIds(getVideoDocs, [1, 2, 3, 4], deps);
      expect(sent.map((i) => i.id).sort()).toEqual(['1', '4']);
      expect(sent[0].videoUrl).toMatch(/\/key-\d\/original=true\/key-\d\.mp4$/);
      // Not failures: nothing is retried for them.
      expect(stats.failed).toBe(0);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('a video that becomes ineligible loses its point on the next sync', async () => {
    const pg = await pglite(`${video(1)} ${video(2)}`);
    try {
      const { points, deps } = fakes(pg);
      await syncIds(getVideoDocs, [1, 2], deps);
      expect([...points.keys()].sort()).toEqual([1, 2]);
      await pg.exec(
        `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 1; DELETE FROM "Image" WHERE id = 2;`
      );
      await syncIds(getVideoDocs, [1, 2], deps);
      expect(points.size).toBe(0);
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('media the embedder refuses', () => {
  test('is not sent again until the file changes', async () => {
    const pg = await pglite(`${video(1)} ${video(2)}`);
    try {
      const { points, sent, deps } = fakes(pg, [2]);
      await syncIds(getVideoDocs, [1, 2], deps);
      expect([...points.keys()]).toEqual([1]);
      sent.length = 0;

      const again = await syncIds(getVideoDocs, [1, 2], deps);
      expect(sent).toEqual([]);
      expect(again.failed).toBe(1);

      await pg.exec(`UPDATE "Image" SET url = 'key-2b' WHERE id = 2`);
      await syncIds(getVideoDocs, [2], deps);
      expect(sent.map((i) => i.id)).toEqual(['2']);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('only media faults are remembered; another failure is sent again', async () => {
    const pg = await pglite(`${video(1)} ${video(2)} ${video(3)}`);
    try {
      const { sent, deps } = fakes(pg, [2, 3], [3]);
      await syncIds(getVideoDocs, [1, 2, 3], deps);
      sent.length = 0;
      await syncIds(getVideoDocs, [2, 3], deps);
      expect(sent.map((i) => i.id)).toEqual(['2']);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('a call where everything is refused is not remembered: it reads as an incident', async () => {
    const pg = await pglite(`${video(1)} ${video(2)}`);
    try {
      const { sent, deps } = fakes(pg, [1, 2]);
      await syncIds(getVideoDocs, [1, 2], deps);
      sent.length = 0;
      await syncIds(getVideoDocs, [1, 2], deps);
      expect(sent.map((i) => i.id).sort()).toEqual(['1', '2']);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('a replaced clip that is refused loses its old point and is not sent again', async () => {
    const pg = await pglite(`${video(1)}`);
    try {
      const { points, sent, deps, store } = fakes(pg, [1]);
      const healthy = fakes(pg);
      await syncIds(getVideoDocs, [1], { ...(healthy.deps as object), store } as never);
      expect(points.has(1)).toBe(true);

      await pg.exec(`UPDATE "Image" SET url = 'key-1b' WHERE id = 1; ${video(2)}`);
      await syncIds(getVideoDocs, [1, 2], deps);
      sent.length = 0;
      await syncIds(getVideoDocs, [1], deps);
      expect(sent).toEqual([]);
      expect(points.has(1)).toBe(false);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('an unreadable memo sends the clips rather than failing the sync', async () => {
    const pg = await pglite(`${video(1)}`);
    try {
      const { sent, deps } = fakes(pg);
      const broken = kvRejectedMemo(
        {
          mGet: async () => {
            throw new Error('redis down');
          },
          set: async () => {
            throw new Error('redis down');
          },
        },
        'c'
      );
      await syncIds(getVideoDocs, [1], { ...(deps as object), rejected: broken } as never);
      expect(sent.map((i) => i.id)).toEqual(['1']);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('the memo matches only the same id and docHash', async () => {
    const memo = new Map<string, string>();
    const m: RejectedMemo = kvRejectedMemo(
      {
        mGet: async (k) => k.map((x) => memo.get(x) ?? null),
        set: async (k, v) => void memo.set(k, v),
      },
      'c'
    );
    await m.add([[1, 'h1']]);
    expect(
      await m.has([
        [1, 'h1'],
        [1, 'h2'],
        [2, 'h1'],
      ])
    ).toEqual(new Set([1]));
  });
});

describe('video change events', () => {
  test('an Image change is routed only for videos; a delete and a tag row always are', () => {
    expect(
      videoRefFromEvent('postgres.Image', { op: 'u', after: { id: 1, type: 'video' } })
    ).toEqual({ id: 1 });
    expect(
      videoRefFromEvent('postgres.Image', { op: 'u', after: { id: 2, type: 'image' } })
    ).toBeNull();
    expect(
      videoRefFromEvent('postgres.Image', { op: 'd', before: { id: 3 }, after: null })
    ).toEqual({ id: 3 });
    expect(
      videoRefFromEvent('postgres.TagsOnImageNew', { op: 'c', after: { imageId: 4, tagId: 1 } })
    ).toEqual({ id: 4 });
    expect(
      videoRefFromEvent('postgres.Image', { op: 'r', after: { id: 5, type: 'video' } })
    ).toBeNull();
  });
});

describe('walks over the videos of Image', () => {
  const seed = `${video(
    1
  )} INSERT INTO "Image" (id, url, type) VALUES (2, 'k', 'image'), (3, 'k', 'image');
    ${video(4)} ${video(5)}`;

  test('the refresh walk reads only video ids', async () => {
    const pg = await pglite(seed);
    try {
      expect(await nextRefreshIds(pg as unknown as Pg, videoDomain, 0, 2)).toEqual({
        ids: [1, 4],
        next: 4,
      });
      expect(await nextRefreshIds(pg as unknown as Pg, videoDomain, 4, 2)).toEqual({
        ids: [5],
        next: 0,
      });
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('the backfill pages over videos only', async () => {
    const pg = await pglite(seed);
    try {
      const { sent, store, embedder } = fakes(pg);
      let pages = 0;
      const counted = {
        query: (sql: string, params?: unknown[]) => {
          if (/ORDER BY id DESC LIMIT/.test(sql)) pages++;
          return pg.query(sql, params);
        },
      };
      const { complete } = await backfillDomain(
        videoDomain,
        { from: 0, to: 10, page: 2 },
        { pg: counted as unknown as Pg, store, embedder }
      );
      expect(complete).toBe(true);
      expect(sent.map((i) => i.id).sort()).toEqual(['1', '4', '5']);
      // Ids 5,4 then 1; over all of Image it would be 5,4 then 3,2 then 1.
      expect(pages).toBe(2);
    } finally {
      await pg.close();
    }
  }, 60_000);

  test('--max-rate spaces pages so writes average at most the rate', async () => {
    const pg = await pglite(seed);
    try {
      const { store, embedder } = fakes(pg);
      let clock = 0;
      const sleeps: number[] = [];
      await backfillDomain(
        videoDomain,
        { from: 0, to: 10, page: 2, maxRate: 1 },
        {
          pg: pg as unknown as Pg,
          store,
          embedder,
          now: () => clock,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          },
        }
      );
      // Two writes on the first page at 1 write/s: the next page waits two seconds.
      expect(sleeps).toEqual([2000]);
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('video collection stamp', () => {
  const client = (metadata: Record<string, string>) =>
    ({ getCollection: async () => ({ config: { metadata } }) } as never);

  test('a collection filled only with clips counts as stamped once the video profile is recorded', async () => {
    const stamp = { model: 'wemm-2b', modelRevision: 'r1', videoProfile: 'video-v1' };
    expect(await new VectorStore(client(stamp), 'v', VIDEO_COLLECTION).isStamped()).toBe(true);
    // The image collection still waits for its image profile.
    expect(await new VectorStore(client(stamp), 'i').isStamped()).toBe(false);
  });
});
