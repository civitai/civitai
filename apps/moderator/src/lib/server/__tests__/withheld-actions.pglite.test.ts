import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import { applyGrants } from '../access';
import { IMAGE_PAGES_SCHEMA } from './appeal-media-schema';

/**
 * The tag, image-help, showcase and rescan actions, and the reads that send a url rather than an
 * image id (a legacy profile image, a generator trigger's inputs), against the media access rule
 * (`restrictedImageIds`) on pglite. Each withheld case sits beside an open control. The main-app
 * calls and the moderator database are faked.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, calls } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  calls: {
    callModEndpoint: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, body: {} })),
    moderateImageTags: vi.fn(async (_input: unknown) => ({ tagIds: [] })),
    resolveHelpRequest: vi.fn(async (_input: unknown) => ({ ok: true })),
    getHelpRequestImageIds: vi.fn(async (_id: number) => [] as number[]),
  },
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../user-actions.service')>()),
  callModEndpoint: calls.callModEndpoint,
}));
vi.mock('../image-tags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-tags.service')>()),
  moderateImageTags: calls.moderateImageTags,
}));
// The help requests live in the moderator database; which images one names is the input here.
vi.mock('../image-help.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../image-help.service')>()),
  resolveHelpRequest: calls.resolveHelpRequest,
  getHelpRequestImageIds: calls.getHelpRequestImageIds,
}));
// The restriction rows are this file's input; their own read is pinned elsewhere.
const { restrictionRows } = vi.hoisted(() => ({ restrictionRows: { current: [] as unknown[] } }));
vi.mock('../user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../user-restriction.service')>()),
  getGenerationRestrictions: vi.fn(async () => ({
    items: restrictionRows.current,
    totalCount: restrictionRows.current.length,
  })),
  getRestrictionFacets: vi.fn(async () => undefined),
}));
vi.mock('../mod-activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mod-activity')>()),
  recordModActivity: vi.fn(async () => undefined),
}));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ query: async () => ({ json: async () => [] }) }),
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const tagsPage = await import('../../../routes/images/tags/+page.server');
const helpPage = await import('../../../routes/retool/image-help/+page.server');
const showcasePage = await import('../../../routes/models/version-showcases/+page.server');
const { rescanStuckImages } = await import('../ingestion.service');
const { withheldUrls } = await import('../retracted-media');
const { withheldProfileMedia } = await import('../user-lookup.service');
const { getTrainingModelsFeed } = await import('../training-moderation.service');
const { triggerInputsFor, restrictionTriageLoad } = await import('../restriction-queue');

// A routine block reason, kept by the other row on its url, which is in the CSAM queue.
const WITHHELD = 501;
const CONTROL = 502;
const WITHHELD_UUID = '5565c259-95e6-4c89-898e-993eabf8ef88';
const CDN = (key: string) => `https://image.civitai.com/hash/${key}/original=true/x.jpeg`;

const HELPER = 'moderator:helper';
const WITHOUT_GRANT = { id: 2, username: 'mod', roles: [HELPER] };
const WITH_GRANT = { id: 3, username: 'lead', roles: ['moderator:admin'] };

let db: PGlite;

beforeEach(async () => {
  for (const call of Object.values(calls)) call.mockClear();
  applyGrants({ '/retool/image-help': [HELPER] });
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  await db.exec(`
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS image TEXT;
    INSERT INTO "User" (id, username) VALUES (7, 'owner'), (8, 'other'), (9, 'clean');
    INSERT INTO "Image" (id, url, ingestion, "blockedFor", "userId") VALUES
      (${WITHHELD}, 'shared-key', 'Blocked', 'moderated', 7),
      (503, 'shared-key', 'Scanned', NULL, 8),
      (${CONTROL}, 'control-key', 'Blocked', 'moderated', 7),
      (601, '${WITHHELD_UUID}', 'Blocked', 'moderated', 7),
      (602, '${WITHHELD_UUID}', 'Scanned', NULL, 8);
    UPDATE "Image" SET "needsReview" = 'csam' WHERE id IN (503, 602);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  applyGrants({});
  dbHandle.current = null;
  await db.close();
});

const event = (user: object, fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request('https://mod.test/x', { method: 'POST', body: form }),
    locals: { user },
  } as never;
};

type Result = { status?: number; data?: { error: string } } | undefined;
type Action = (e: never) => Promise<unknown>;

describe('the single-image actions', () => {
  const cases: [string, Action, (id: number) => Record<string, string>, () => unknown][] = [
    [
      'a tag verdict',
      tagsPage.actions.moderate as Action,
      (id) => ({ imageId: String(id), disable: 'true' }),
      () => calls.moderateImageTags,
    ],
    [
      'a showcase removal',
      showcasePage.actions.remove as Action,
      (id) => ({ modelVersionId: '10', imageId: String(id) }),
      () => calls.callModEndpoint,
    ],
    [
      'an image-help resolve',
      helpPage.actions.resolve as Action,
      (id) => {
        calls.getHelpRequestImageIds.mockResolvedValueOnce([id]);
        return { requestId: '1' };
      },
      () => calls.resolveHelpRequest,
    ],
  ];

  it.each(cases)('%s refuses a withheld image without the grant', async (_, act, fields, call) => {
    const result = (await act(event(WITHOUT_GRANT, fields(WITHHELD)))) as Result;
    expect(result?.status).toBe(403);
    expect(result?.data?.error).toContain(String(WITHHELD));
    expect(call()).not.toHaveBeenCalled();
  });

  it.each(cases)('%s acts on an open image without the grant', async (_, act, fields, call) => {
    await act(event(WITHOUT_GRANT, fields(CONTROL)));
    expect(call()).toHaveBeenCalledOnce();
  });

  it.each(cases)(
    '%s acts on the withheld image for a grant holder',
    async (_, act, fields, call) => {
      await act(event(WITH_GRANT, fields(WITHHELD)));
      expect(call()).toHaveBeenCalledOnce();
    }
  );
});

describe('the bulk tag verdict', () => {
  const bulk = (user: object, ids: number[]) =>
    tagsPage.actions.bulkModerate(
      event(user, { imageIds: ids.join(','), disable: 'true' })
    ) as Promise<Result>;

  it('refuses a batch with a withheld image without the grant, acting on none of it', async () => {
    expect((await bulk(WITHOUT_GRANT, [CONTROL, WITHHELD]))?.status).toBe(403);
    expect(calls.moderateImageTags).not.toHaveBeenCalled();
  });

  it('acts on a batch with nothing withheld without the grant', async () => {
    await bulk(WITHOUT_GRANT, [CONTROL]);
    expect(calls.moderateImageTags).toHaveBeenCalledOnce();
  });

  it('acts on the whole batch for a grant holder', async () => {
    await bulk(WITH_GRANT, [CONTROL, WITHHELD]);
    expect(calls.moderateImageTags).toHaveBeenCalledTimes(2);
  });
});

describe('the stuck-image rescan', () => {
  beforeEach(async () => {
    await db.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Rescan', 'Error');
      ALTER TABLE "Image" ALTER COLUMN ingestion DROP DEFAULT,
        ALTER COLUMN ingestion TYPE "ImageIngestionStatus" USING ingestion::"ImageIngestionStatus";
      UPDATE "Image" SET ingestion = 'Pending', "createdAt" = now() - INTERVAL '1 day'
        WHERE id IN (${WITHHELD}, ${CONTROL});
    `);
  });
  const status = async (id: number) =>
    (await db.query<{ ingestion: string }>(`SELECT ingestion FROM "Image" WHERE id = ${id}`))
      .rows[0].ingestion;
  const rescan = (viewer: { id: number; roles: string[] }, imageIds?: number[]) =>
    rescanStuckImages({ imageIds, userId: viewer.id, viewer: viewer as never });

  it('refuses a selection with a withheld image without the grant, rescanning none', async () => {
    const result = await rescan(WITHOUT_GRANT, [CONTROL, WITHHELD]);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain(String(WITHHELD));
    expect(await status(CONTROL)).toBe('Pending');
  });

  it('rescans a selection with nothing withheld without the grant', async () => {
    expect(await rescan(WITHOUT_GRANT, [CONTROL])).toEqual({ ok: true, count: 1, skipped: 0 });
    expect(await status(CONTROL)).toBe('Rescan');
  });

  it('rescans all but the withheld image without the grant, and says how many it left out', async () => {
    expect(await rescan(WITHOUT_GRANT)).toEqual({ ok: true, count: 1, skipped: 1 });
    expect(await status(CONTROL)).toBe('Rescan');
    expect(await status(WITHHELD)).toBe('Pending');
  });

  it('rescans all of them for a grant holder', async () => {
    expect(await rescan(WITH_GRANT)).toEqual({ ok: true, count: 2, skipped: 0 });
  });
});

describe('a url naming an image', () => {
  it('is withheld when it is a withheld image key, bare or in a CDN link, without the grant', async () => {
    const urls = ['shared-key', CDN(WITHHELD_UUID), 'control-key', 'https://elsewhere.test/a.png'];
    expect(await withheldUrls(urls, WITHOUT_GRANT as never, 'test')).toEqual(
      new Set(['shared-key', CDN(WITHHELD_UUID)])
    );
  });

  it('is not withheld from a grant holder', async () => {
    expect(
      await withheldUrls(['shared-key', CDN(WITHHELD_UUID)], WITH_GRANT as never, 'test')
    ).toEqual(new Set());
  });
});

describe('the legacy profile image', () => {
  const shown = async (image: string, viewer: object) =>
    (await withheldProfileMedia({ image, profilePictureId: null } as never, null, viewer as never))
      .identity;

  it('is sent as null when its url names a withheld image, without the grant', async () => {
    expect(await shown(CDN(WITHHELD_UUID), WITHOUT_GRANT)).toMatchObject({ image: null });
  });

  it('is sent as it is when it names an open image or no image', async () => {
    expect(await shown('control-key', WITHOUT_GRANT)).toMatchObject({ image: 'control-key' });
    const url = 'https://elsewhere.test/a.png';
    expect(await shown(url, WITHOUT_GRANT)).toMatchObject({ image: url });
  });
});

describe("the training models feed's owner avatar", () => {
  beforeEach(async () => {
    // The feed's own columns, in place of the narrower tables the shared schema has.
    await db.exec(`
      DROP TABLE IF EXISTS "Model", "ModelVersion", "ModelFile" CASCADE;
      CREATE TABLE "Model" (
        "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'm', "type" TEXT NOT NULL DEFAULT 'LORA',
        "nsfw" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE,
        "minor" BOOLEAN NOT NULL DEFAULT FALSE, "tosViolation" BOOLEAN NOT NULL DEFAULT FALSE,
        "status" TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "publishedAt" TIMESTAMP, "userId" INTEGER NOT NULL, "uploadType" TEXT NOT NULL DEFAULT 'Trained',
        "deletedAt" TIMESTAMP, "meta" JSONB
      );
      CREATE TABLE "ModelVersion" (
        "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "name" TEXT NOT NULL DEFAULT 'v1',
        "status" TEXT NOT NULL DEFAULT 'Published', "baseModel" TEXT NOT NULL DEFAULT 'SDXL 1.0',
        "trainingStatus" TEXT, "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      );
      CREATE TABLE "ModelFile" (
        "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "name" TEXT NOT NULL DEFAULT 'f.zip',
        "sizeKB" DOUBLE PRECISION NOT NULL DEFAULT 1, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "type" TEXT NOT NULL, "dataPurged" BOOLEAN NOT NULL DEFAULT FALSE, "metadata" JSONB
      );
      UPDATE "User" SET image = 'shared-key' WHERE id = 7;
      UPDATE "User" SET image = 'control-key' WHERE id = 9;
      INSERT INTO "Model" ("id", "userId") VALUES (10, 7), (11, 9);
      INSERT INTO "ModelVersion" ("id", "modelId") VALUES (100, 10), (110, 11);
      INSERT INTO "ModelFile" ("id", "modelVersionId", "type") VALUES
        (1000, 100, 'Training Data'), (1100, 110, 'Training Data');
    `);
  });
  const avatars = async (viewer: object) =>
    Object.fromEntries(
      (await getTrainingModelsFeed({ limit: 10, viewer: viewer as never })).items.map((m) => [
        m.id,
        m.userImage,
      ])
    );

  it('is sent as null when it names a withheld image, beside an open one, without the grant', async () => {
    expect(await avatars(WITHOUT_GRANT)).toEqual({ 10: null, 11: 'control-key' });
  });

  it('is sent to a grant holder', async () => {
    expect(await avatars(WITH_GRANT)).toEqual({ 10: 'shared-key', 11: 'control-key' });
  });
});

describe("a generator restriction trigger's inputs", () => {
  const row = {
    triggers: [
      {
        key: 'a',
        inputImages: [CDN(WITHHELD_UUID), 'control-key', 'https://elsewhere.test/a.png'],
        inputVideo: 'shared-key',
      },
    ],
  } as never as { triggers: { inputImages?: string[]; inputVideo?: string }[] };
  const shown = async (viewer: object) => {
    const view = await triggerInputsFor([row as never], {}, viewer as never);
    return (view(row as never) as typeof row).triggers[0];
  };

  it('leave out a url naming a withheld image without the grant, keeping the rest', async () => {
    expect(await shown(WITHOUT_GRANT)).toMatchObject({
      inputImages: ['control-key', 'https://elsewhere.test/a.png'],
      inputVideo: undefined,
    });
  });

  it('are sent whole to a grant holder', async () => {
    expect(await shown(WITH_GRANT)).toMatchObject(row.triggers[0]);
  });

  it('are filtered on the queue page a moderator loads', async () => {
    restrictionRows.current = [{ id: 1, type: 'Prompt', userId: 7, ...row }];
    const load = (viewer: object) =>
      restrictionTriageLoad(
        new URL('https://mod.test/audit/generator-restrictions'),
        { types: ['Prompt'], fallback: 'Prompt' } as never,
        viewer as never
      );
    const [trigger] = (await load(WITHOUT_GRANT)).items[0].triggers;
    expect(trigger).toMatchObject({ inputImages: ['control-key', 'https://elsewhere.test/a.png'] });
    expect(trigger.inputVideo).toBeUndefined();
    expect((await load(WITH_GRANT)).items[0].triggers[0]).toMatchObject(row.triggers[0]);
  });
});
