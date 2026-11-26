import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '$lib/server/__tests__/abuse-detection-pglite.harness';
import { IMAGE_PAGES_SCHEMA } from '$lib/server/__tests__/appeal-media-schema';
import { applyGrants } from '$lib/server/access';

/**
 * What each Trials tab sends for an image the media access rule withholds from this moderator: the
 * item with no key or name, and the control image beside it as it is. The withheld image carries no
 * mark of its own; a copy on its url is blocked as CSAM. Each action that would grade Acolytes
 * against such an image is refused. Policy: civitai/civitai#10428 and its follow-up.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
const db_ = () => {
  if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
  return dbHandle.current;
};
vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return db_();
  },
  get dbWrite() {
    return db_();
  },
}));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

const WITHHELD = 901;
const CONTROL = 902;
const COPY = 903;
const KEY = 'withheld-key';
const CONTROL_KEY = 'control-key';
const AXIS = 'knights.yesno.violence';

const WITHOUT_GRANT = { id: 2, roles: ['moderator:knights'] };
const WITH_GRANT = { id: 3, roles: ['moderator:knights', 'moderator:csam'] };

let db: PGlite;

beforeAll(() => {
  applyGrants({
    '/knights-of-new-order/trials': ['moderator:knights'],
    '/images/csam': ['moderator:csam'],
  });
});

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(IMAGE_PAGES_SCHEMA);
  // The columns the Acolyte servability check reads.
  await db.exec(`
    ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'Public',
      ADD COLUMN IF NOT EXISTS "modelVersionId" INTEGER;
    ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS poi BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS minor BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "tosViolation" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "bannedAt" TIMESTAMP,
      ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Model" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Published',
      ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'Public',
      ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;
    ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Published',
      ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'Public';
  `);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  await db.exec(`
    INSERT INTO "User" (id, username) VALUES (7, 'owner');
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (50, 7, now() - interval '1 day');
    INSERT INTO "Image" (id, url, name, type, "nsfwLevel", "userId", "postId") VALUES
      (${WITHHELD}, '${KEY}', 'withheld.png', 'image', 1, 7, 50),
      (${CONTROL}, '${CONTROL_KEY}', 'control.png', 'image', 1, 7, 50);
    INSERT INTO "Image" (id, url, type, ingestion, "blockedFor", "nsfwLevel", "userId") VALUES
      (${COPY}, '${KEY}', 'image', 'Blocked', 'CSAM', 1, 7);
    INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('${AXIS}','bool','Violence?','[]')
      ON CONFLICT DO NOTHING;
    INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","prompt","active","createdBy") VALUES
      (${WITHHELD}, '${AXIS}', true, 'Violence?', true, 7),
      (${CONTROL}, '${AXIS}', true, 'Violence?', true, 7);
    INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","priority","status","audience","prompt","externalId","voteCount","yesEffect","noEffect")
      VALUES
      ('${AXIS}', ${WITHHELD}, 'yesno-import', 'Knight', 4, 2, 'Open', 'players', 'Violence?', 'ext-1', 0, 'R4', 'R3'),
      ('${AXIS}', ${CONTROL}, 'yesno-import', 'Knight', 4, 2, 'Open', 'players', 'Violence?', 'ext-2', 0, 'R4', 'R3');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

type Item = { imageId?: number; imageKey: string; imageName?: string | null; restricted: boolean };
type User = { id: number; roles: string[] };

/** One reference per image, so each tab seeds its own kind. */
const REFERENCE: Record<string, { source: string; status: string }> = {
  core: { source: 'core', status: 'active' },
  fresh: { source: 'harvested', status: 'active' },
  'spot-check': { source: 'harvested', status: 'pending' },
};

const load = async (tab: string, user: User) => {
  const ref = REFERENCE[tab];
  if (ref)
    await db.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status") VALUES
        ($1, 'trials', '1', $3, $4), ($2, 'trials', '1', $3, $4)`,
      [WITHHELD, CONTROL, ref.source, ref.status]
    );
  const route = await import('../+page.server');
  return (await route.load({
    url: new URL(`http://moderator.test/knights-of-new-order/trials?tab=${tab}`),
    params: {},
    locals: { user, grants: {} },
  } as never)) as Record<string, unknown> & {
    items: Item[];
    spotCheck: Item[];
    yesNo: { items: Item[] };
    questionQueue: { items: Item[] };
  };
};

/** Each tab and the items it sends. */
const tabs: { tab: string; items: (data: Awaited<ReturnType<typeof load>>) => Item[] }[] = [
  { tab: 'core', items: (d) => d.items },
  { tab: 'fresh', items: (d) => d.items },
  { tab: 'yes-no', items: (d) => d.yesNo.items },
  { tab: 'questions', items: (d) => d.questionQueue.items },
];

describe.each(tabs)('Trials $tab tab', ({ tab, items }) => {
  const byId = (rows: Item[], id: number) => rows.find((r) => r.imageId === id);

  it('sends a withheld image with no key or name to a moderator without the grant', async () => {
    const data = await load(tab, WITHOUT_GRANT);
    expect(byId(items(data), WITHHELD)).toMatchObject({
      imageKey: '',
      imageName: null,
      restricted: true,
    });
    expect(JSON.stringify(data)).not.toContain(KEY);
    expect(JSON.stringify(data)).not.toContain('withheld.png');
  });

  it('sends the control image with its key', async () => {
    expect(byId(items(await load(tab, WITHOUT_GRANT)), CONTROL)).toMatchObject({
      imageKey: CONTROL_KEY,
      imageName: 'control.png',
      restricted: false,
    });
  });

  it('sends the withheld image to a moderator with the grant', async () => {
    expect(byId(items(await load(tab, WITH_GRANT)), WITHHELD)).toMatchObject({
      imageKey: KEY,
      restricted: false,
    });
  });
});

describe('Trials spot-check tab', () => {
  it('sends a withheld image with no key to a moderator without the grant, and the control as it is', async () => {
    const data = await load('spot-check', WITHOUT_GRANT);
    expect(data.spotCheck).toHaveLength(2);
    expect(data.spotCheck.filter((i) => i.restricted)).toEqual([
      expect.objectContaining({ imageKey: '', restricted: true }),
    ]);
    expect(data.spotCheck.find((i) => !i.restricted)?.imageKey).toBe(CONTROL_KEY);
    expect(JSON.stringify(data)).not.toContain(KEY);
  });

  it('sends both keys to a moderator with the grant', async () => {
    const data = await load('spot-check', WITH_GRANT);
    expect(data.spotCheck.map((i) => i.imageKey).sort()).toEqual([CONTROL_KEY, KEY].sort());
  });
});

const AXIS_2 = 'knights.yesno.weapons';

const act = async (name: string, fields: Record<string, string>, user: User) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  const route = await import('../+page.server');
  return (await route.actions[name]({
    request: { formData: async () => data },
    url: new URL('http://moderator.test/knights-of-new-order/trials'),
    params: {},
    locals: { user, grants: {} },
  } as never)) as { status?: number; data?: { error: string }; success?: boolean };
};

const referenceId = async (imageId: number, source: string, status: string) => {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","status")
     VALUES ($1, 'trials', '1', $2, $3) RETURNING id`,
    [imageId, source, status]
  );
  return rows[0].id;
};

const pairId = async (imageId: number) => {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM "KnightsYesNoReference" WHERE "imageId" = $1`,
    [imageId]
  );
  return rows[0].id;
};

const rowsFor = async (imageId: number) =>
  JSON.stringify(
    (
      await db.query(
        `SELECT 'ref' AS t, id, answer, source, status, explanation FROM "KnightsReferenceImage" WHERE "imageId" = $1
         UNION ALL
         SELECT 'pair', id, answer::text, "questionKey", active::text, explanation FROM "KnightsYesNoReference" WHERE "imageId" = $1
         ORDER BY 1, 2`,
        [imageId]
      )
    ).rows
  );

/** Each action that grades Acolytes against an image: the form it posts for that image. */
const gradingActions: {
  action: string;
  fields: (imageId: number) => Promise<Record<string, string>>;
}[] = [
  {
    action: 'add',
    fields: async (image) => ({ image: String(image), level: '2', explanation: 'why' }),
  },
  {
    action: 'update',
    fields: async (image) => ({
      id: String(await referenceId(image, 'core', 'active')),
      level: '2',
      explanation: 'why',
    }),
  },
  {
    action: 'promote',
    fields: async (image) => ({ id: String(await referenceId(image, 'harvested', 'active')) }),
  },
  {
    action: 'spotCheck',
    fields: async (image) => ({
      id: String(await referenceId(image, 'harvested', 'pending')),
      level: '1',
    }),
  },
  {
    action: 'addYesNo',
    fields: async (image) => ({
      image: String(image),
      questionKey: AXIS_2,
      prompt: 'Weapons?',
      answer: 'no',
    }),
  },
  {
    action: 'updateYesNo',
    fields: async (image) => ({ id: String(await pairId(image)), prompt: 'Gore?', answer: 'no' }),
  },
  {
    action: 'toggleYesNo',
    fields: async (image) => {
      const id = await pairId(image);
      await db.query(`UPDATE "KnightsYesNoReference" SET active = false WHERE id = $1`, [id]);
      return { id: String(id), active: 'true' };
    },
  },
];

describe.each(gradingActions)('Trials $action action', ({ action, fields }) => {
  beforeEach(async () => {
    await db.exec(
      `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('${AXIS_2}','bool','Weapons?','[]')
       ON CONFLICT DO NOTHING;`
    );
  });

  it('refuses a withheld image to a moderator without the grant, and writes nothing', async () => {
    const form = await fields(WITHHELD);
    const before = await rowsFor(WITHHELD);
    const result = await act(action, form, WITHOUT_GRANT);
    expect(result).toMatchObject({ status: 403 });
    expect(result.data?.error).toContain(String(WITHHELD));
    expect(await rowsFor(WITHHELD)).toBe(before);
  });

  it('acts on the control image for the same moderator', async () => {
    const form = await fields(CONTROL);
    const before = await rowsFor(CONTROL);
    expect(await act(action, form, WITHOUT_GRANT)).toMatchObject({ success: true });
    expect(await rowsFor(CONTROL)).not.toBe(before);
  });

  it('acts on the withheld image for a moderator with the grant', async () => {
    const form = await fields(WITHHELD);
    const before = await rowsFor(WITHHELD);
    expect(await act(action, form, WITH_GRANT)).toMatchObject({ success: true });
    expect(await rowsFor(WITHHELD)).not.toBe(before);
  });
});

describe('Trials actions that take an item out of grading', () => {
  it('lets a moderator without the grant deactivate and retire a withheld item', async () => {
    const pair = await pairId(WITHHELD);
    expect(
      await act('toggleYesNo', { id: String(pair), active: 'false' }, WITHOUT_GRANT)
    ).toMatchObject({ success: true });
    const ref = await referenceId(WITHHELD, 'core', 'active');
    expect(await act('retire', { id: String(ref) }, WITHOUT_GRANT)).toMatchObject({
      success: true,
    });
  });
});

it('reports an image id that does not exist as not found, not as withheld', async () => {
  const result = await act(
    'add',
    { image: '9999', level: '2', explanation: 'why' },
    WITHOUT_GRANT
  );
  expect(result).toMatchObject({ status: 409 });
  expect(result.data?.error).toContain('not found');
});
