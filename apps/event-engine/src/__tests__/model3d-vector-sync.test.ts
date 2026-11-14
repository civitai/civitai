import { describe, expect, test } from 'vitest';
import { model3dDomain, model3dRefFromEvent } from '@/vector-sync/models3d/domain';
import { getModel3DDocs, type Model3DPayload } from '@/vector-sync/models3d/source';
import { contentRoute, OUTBOX_TOPIC, selectDomains } from '@/vector-sync/content/consumer';
import { nextRefreshIds } from '@/vector-sync/domain/refresh';
import { syncIds } from '@/vector-sync/domain/sync';
import type { EmbedInput } from '@/vector-sync/embedder';

const SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp);
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, url text, ingestion text,
    "needsReview" text, "tosViolation" boolean, "blockedFor" text, "nsfwLevel" int DEFAULT 1,
    minor boolean DEFAULT false, poi boolean DEFAULT false);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  CREATE TABLE "EvidenceHeldUser" ("userId" int);
  CREATE TABLE "Model3DLicense" (id int PRIMARY KEY, name text);
  CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
  CREATE TABLE "Model3D" (id int PRIMARY KEY, name text, description text, "userId" int,
    "thumbnailImageId" int, "licenseId" int, "generationParams" jsonb, status text,
    "deletedAt" timestamp, "nsfwLevel" int, "tosViolation" boolean, unlisted boolean,
    minor boolean, poi boolean, availability text, "publishedAt" timestamp);
  CREATE TABLE "TagsOnModel3D" ("model3dId" int, "tagId" int);
  INSERT INTO "User" VALUES (7, 'someone', NULL, NULL), (8, 'other', NULL, NULL);
  INSERT INTO "Model3DLicense" VALUES (1, 'CC-BY');
`;

/** An eligible model `id` owned by `owner`, with its own clean thumbnail `id * 10`. */
const eligibleModel = (id: number, owner = 7) => `
  INSERT INTO "Image" VALUES (${id * 10}, ${owner}, 'key-${id * 10}', 'Scanned', NULL, false, NULL);
  INSERT INTO "Model3D" VALUES (${id}, 'Model ${id}', NULL, ${owner}, ${id * 10}, 1, NULL,
    'Published', NULL, 1, false, false, false, false, 'Public', '2026-01-01');`;

async function pglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(SCHEMA);
  return pg;
}

/** A Qdrant and embedder stand-in: the points, and every input the embedder was sent. */
function fakes(pg: unknown) {
  const points = new Map<number, Model3DPayload>();
  const sent: EmbedInput[] = [];
  const store = {
    payloadFields: async (ids: number[]) =>
      new Map(ids.flatMap((id) => (points.has(id) ? [[id, points.get(id)!] as const] : []))),
    delete: async (ids: number[]) => ids.forEach((id) => points.delete(id)),
    setPayloads: async (p: Map<number, Model3DPayload>) =>
      p.forEach((payload, id) => points.set(id, payload)),
    upsert: async (ps: { id: number; payload: Model3DPayload }[]) =>
      ps.forEach((p) => points.set(p.id, p.payload)),
    assertModel: async () => undefined,
  };
  const embedder = {
    embed: async (
      inputs: EmbedInput[],
      o: { onVectors?: (v: Map<number, number[]>) => Promise<void> } = {}
    ) => {
      sent.push(...inputs);
      const vectors = new Map(inputs.map((i) => [Number(i.id), [1]]));
      await o.onVectors?.(vectors);
      return { vectors, failed: [], stamp: undefined };
    },
  };
  const deps = { pg, store, embedder, embedInput: model3dDomain.embedInput } as never;
  return { points, sent, deps };
}

// Eligibility itself is pinned to the site's rule by the site's model3d-eligibility parity test.
describe('3D model payload, against the real query', () => {
  test('carries the fields the site filters on; a new thumbnail changes the docHash', async () => {
    const pg = await pglite();
    await pg.exec(`
      INSERT INTO "Image" VALUES (70, 7, 'key-70', 'Scanned', NULL, false, NULL),
        (71, 7, 'key-71', 'Scanned', NULL, false, NULL), (80, 7, 'key-80', 'Pending', NULL, false, NULL);
      INSERT INTO "Tag" VALUES (3, 'robot'), (4, 'mech');
      INSERT INTO "Model3D" VALUES
        (1, 'Mech  Walker', '<p>A <b>walking</b> mech</p>', 7, 70, 1,
          '{"enableAnimation": true}', 'Published', NULL, 4, false, false, false, false, 'Public',
          '2026-01-01'),
        (2, 'Unscanned thumbnail', NULL, 7, 80, 1, NULL, 'Published', NULL, 1, false, false,
          false, false, 'Public', '2026-01-01');
      INSERT INTO "TagsOnModel3D" VALUES (1, 3), (1, 4);
    `);
    try {
      const read = () =>
        getModel3DDocs(pg as unknown as Parameters<typeof getModel3DDocs>[0], [1, 2]);
      const docs = await read();
      expect([...docs.keys()]).toEqual([1]);
      expect(docs.get(1)).toMatchObject({
        title_normalized: 'mech walker',
        name: 'Mech  Walker',
        tags: ['mech', 'robot'],
        tagIds: [4, 3],
        nsfwLevel: [4],
        animated: true,
        license: 'CC-BY',
        publishedAt: '2026-01-01T00:00:00.000Z',
        userId: 7,
        username: 'someone',
        thumbnailImageId: 70,
        thumbnailUrl: 'key-70',
      });
      expect(docs.get(1)?.search_text).toBe(
        'Name: Mech Walker\nCreator: someone\nTags: mech, robot\nDescription: A walking mech'
      );

      await pg.exec(`UPDATE "Model3D" SET "thumbnailImageId" = 71 WHERE id = 1`);
      const after = (await read()).get(1)!;
      expect(after.search_text).toBe(docs.get(1)!.search_text);
      expect(after.docHash).not.toBe(docs.get(1)!.docHash);
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('3D model thumbnail level', () => {
  test('a thumbnail re-rated above its model is carried on the next sync', async () => {
    const pg = await pglite();
    try {
      await pg.exec(eligibleModel(1));
      const { points, deps } = fakes(pg);
      await syncIds(getModel3DDocs, [1], deps);
      expect(points.get(1)).toMatchObject({ nsfwLevel: [1], thumbnailNsfwLevel: [1] });

      // A re-rate touches only the Image row; the refresh walk re-syncs the model.
      await pg.exec(`UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 10`);
      await syncIds(getModel3DDocs, [1], deps);
      expect(points.get(1)).toMatchObject({ nsfwLevel: [1], thumbnailNsfwLevel: [4] });
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('3D model removal', () => {
  // Each change takes indexed model 1 out of eligibility; the next sync of its id deletes the point.
  // Model 2 (another owner) is the control: it must keep its point.
  const leaves: [string, string][] = [
    ['taken down', `UPDATE "Model3D" SET "tosViolation" = true WHERE id = 1`],
    ['soft-deleted', `UPDATE "Model3D" SET "deletedAt" = now() WHERE id = 1`],
    ['unpublished', `UPDATE "Model3D" SET status = 'Unpublished' WHERE id = 1`],
    ['flagged minor', `UPDATE "Model3D" SET minor = true WHERE id = 1`],
    ['flagged POI', `UPDATE "Model3D" SET poi = true WHERE id = 1`],
    ['owner banned', `UPDATE "User" SET "bannedAt" = now() WHERE id = 7`],
    ['owner reported', `INSERT INTO "CsamReport" ("userId") VALUES (7)`],
    ['owner under an evidence hold', `INSERT INTO "EvidenceHeldUser" VALUES (7)`],
    ['thumbnail sent to review', `UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 10`],
    ['thumbnail taken down', `UPDATE "Image" SET "tosViolation" = true WHERE id = 10`],
    ['thumbnail blocked for CSAM', `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 10`],
    ['thumbnail rated Blocked', `UPDATE "Image" SET "nsfwLevel" = 32 WHERE id = 10`],
    ['thumbnail listed on a report', `INSERT INTO "CsamReport" (images) VALUES ('["10"]')`],
  ];
  test.each(leaves)(
    'a model %s loses its point on the next sync',
    async (_, change) => {
      const pg = await pglite();
      try {
        await pg.exec(eligibleModel(1) + eligibleModel(2, 8));
        const { points, deps } = fakes(pg);
        await syncIds(getModel3DDocs, [1, 2], deps);
        expect([...points.keys()].sort()).toEqual([1, 2]);

        await pg.exec(change);
        const stats = await syncIds(getModel3DDocs, [1, 2], deps);
        expect([...points.keys()]).toEqual([2]);
        expect(stats.deleted).toBe(1);
      } finally {
        await pg.close();
      }
    },
    60_000
  );

  test('the refresh walk visits every model, ineligible ones too, by keyset, and wraps', async () => {
    const pg = await pglite();
    try {
      await pg.exec([1, 2, 3, 4, 5].map((id) => eligibleModel(id)).join(''));
      // The walk exists to reach models that left eligibility, so it must not filter them.
      await pg.exec(`UPDATE "Model3D" SET "tosViolation" = true WHERE id = 3`);
      const db = pg as unknown as Parameters<typeof nextRefreshIds>[0];
      const seen: number[][] = [];
      let cursor = 0;
      for (let i = 0; i < 4; i++) {
        const { ids, next } = await nextRefreshIds(db, model3dDomain, cursor, 2);
        seen.push(ids);
        cursor = next;
      }
      expect(seen).toEqual([[1, 2], [3, 4], [5], [1, 2]]);
    } finally {
      await pg.close();
    }
  }, 60_000);

  // Listed on a report is a leg only the held-content rule catches: the image is otherwise clean.
  test('a held thumbnail is never sent to the embedder', async () => {
    const pg = await pglite();
    try {
      await pg.exec(eligibleModel(1) + eligibleModel(2, 8));
      await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('[{"id": 20}]')`);
      const { points, sent, deps } = fakes(pg);
      await syncIds(getModel3DDocs, [1, 2], deps);
      expect([...points.keys()]).toEqual([1]);
      expect(sent.map((i) => i.id)).toEqual(['1']);
    } finally {
      await pg.close();
    }
  }, 60_000);
});

describe('3D model embedding', () => {
  const payload = (thumbnailUrl: string) => ({ thumbnailUrl } as Model3DPayload);

  test('embeds the thumbnail image, not the text', () => {
    expect(model3dDomain.embedInput!(5, payload('abc/key.png'))).toEqual({
      id: '5',
      imageUrl: expect.stringMatching(/\/abc\/key\.png\/[^/]+\/abc\/key\.jpeg$/),
    });
  });

  test('a thumbnail off our CDN is not sent to the embedder', () => {
    expect(model3dDomain.embedInput!(5, payload('https://elsewhere.test/a.png'))).toBeNull();
  });

  test('stays off until VECTOR_MODEL3D_EMBED_ENABLED is true, even with the global switch on', async () => {
    const { config, domainEmbedEnabled } = await import('@/config');
    const global = config.vectorSync.embedEnabled;
    const own = process.env.VECTOR_MODEL3D_EMBED_ENABLED;
    try {
      config.vectorSync.embedEnabled = true;
      delete process.env.VECTOR_MODEL3D_EMBED_ENABLED;
      expect(domainEmbedEnabled(model3dDomain.name, model3dDomain.embedByDefault)).toBe(false);
      process.env.VECTOR_MODEL3D_EMBED_ENABLED = 'true';
      expect(domainEmbedEnabled(model3dDomain.name, model3dDomain.embedByDefault)).toBe(true);
    } finally {
      config.vectorSync.embedEnabled = global;
      if (own === undefined) delete process.env.VECTOR_MODEL3D_EMBED_ENABLED;
      else process.env.VECTOR_MODEL3D_EMBED_ENABLED = own;
    }
  });
});

describe('3D model change signals', () => {
  test('a model or tag change names the model; a tag delete names it too', () => {
    expect(model3dRefFromEvent('postgres.Model3D', { op: 'u', after: { id: 3 } })).toEqual({
      id: 3,
    });
    expect(
      model3dRefFromEvent('postgres.TagsOnModel3D', {
        op: 'd',
        before: { model3dId: 4, tagId: 2 },
        after: null,
      })
    ).toEqual({ id: 4 });
    expect(model3dRefFromEvent('postgres.Model3D', { op: 'r', after: { id: 5 } })).toBeNull();
  });

  test('the content consumer routes both topics to the model3d domain', () => {
    const route = contentRoute(selectDomains(['model3d']));
    expect(route('postgres.TagsOnModel3D', { op: 'c', after: { model3dId: 9, tagId: 1 } })).toEqual(
      [['model3d', { id: 9 }]]
    );
    expect(
      route(OUTBOX_TOPIC, {
        op: 'c',
        after: { event: 'search.update', entityType: 'Comic', entityId: '9' },
      })
    ).toEqual([]);
  });
});
