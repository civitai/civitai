import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

type Fragment = { strings: readonly string[]; values: unknown[] };
type Ident = { ident: string };

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// kysely's `sql` tag, rendered to the statement Postgres receives and run on PGlite, so the "hide me from
// reaction lists" predicate is checked against real rows rather than read as text.
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
        const text = render(frag, params);
        return { rows: (await holder.db.query(text, params)).rows };
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

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getReactors, imageAudienceListable } = await import('../reactors');
const { getCollectors } = await import('../collectors');

const OWNER = 42;
const IMAGE = 900;
const LISTED = 30;
const HIDDEN = 20;
const OPTED_BACK_IN = 10;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "deletedAt" timestamp, "bannedAt" timestamp,
      "profilePictureId" int, settings jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int, ingestion text, "nsfwLevel" int, url text, "blockedFor" text
    );
    CREATE TABLE "ImageReaction" ("imageId" int, "userId" int, reaction text, "createdAt" timestamp DEFAULT now());
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "Collection" (
      id int PRIMARY KEY, "userId" int, read text, availability text, mode text
    );
    CREATE TABLE "CollectionItem" (
      "collectionId" int, "imageId" int, status text, "addedById" int, "createdAt" timestamp DEFAULT now()
    );
    INSERT INTO "User" (id, username, settings) VALUES
      (${OWNER}, 'owner', '{}'),
      (${LISTED}, 'listed', '{"hideFromCreatorShowcase": true}'),
      (${HIDDEN}, 'hidden', '{"hideFromReactionLists": true}'),
      (${OPTED_BACK_IN}, 'back', '{"hideFromReactionLists": false}');
    INSERT INTO "Image" (id, "userId") VALUES (${IMAGE}, ${OWNER});
    INSERT INTO "ImageReaction" ("imageId", "userId", reaction) VALUES
      (${IMAGE}, ${LISTED}, 'Like'), (${IMAGE}, ${HIDDEN}, 'Like'), (${IMAGE}, ${OPTED_BACK_IN}, 'Like');
    INSERT INTO "Collection" VALUES
      (1, ${LISTED}, 'Public', 'Public', NULL),
      (2, ${HIDDEN}, 'Public', 'Public', NULL),
      (3, ${OPTED_BACK_IN}, 'Public', 'Public', NULL);
    INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "addedById") VALUES
      (1, ${IMAGE}, 'ACCEPTED', ${LISTED}),
      (2, ${IMAGE}, 'ACCEPTED', ${HIDDEN}),
      (3, ${IMAGE}, 'ACCEPTED', ${OPTED_BACK_IN});
  `);
});

describe('Creator Studio "Who reacted" and reactions from before the lists launched', () => {
  const PRE_IMAGE = 901;
  const ARTICLE = 700;
  const BEFORE = '2026-09-23 17:07:39';
  const AT_LAUNCH = '2026-09-23 17:07:40';
  const QUIET = 60;
  const OPTED_IN = 50;
  const OPTED_IN_BUT_HIDDEN = 40;
  const AFTER = 31;
  const reactors = async (entity: 'image' | 'article', id: number) =>
    (
      await getReactors(holder.db as never, OWNER, entity, id, {
        reaction: 'Like',
        cursor: null,
      } as never)
    )?.reactors.map((r) => r.userId);

  beforeAll(async () => {
    await holder.db.exec(`
      CREATE TABLE "Article" (id int PRIMARY KEY, "userId" int);
      CREATE TABLE "ArticleReaction" ("articleId" int, "userId" int, reaction text, "createdAt" timestamp);
      INSERT INTO "User" (id, username, settings) VALUES
        (${QUIET}, 'quiet', '{}'),
        (${OPTED_IN}, 'optin', '{"showPreLaunchReactions": true}'),
        (${OPTED_IN_BUT_HIDDEN}, 'both', '{"showPreLaunchReactions": true, "hideFromReactionLists": true}'),
        (${AFTER}, 'after', '{}');
      INSERT INTO "Image" (id, "userId") VALUES (${PRE_IMAGE}, ${OWNER});
      INSERT INTO "Article" VALUES (${ARTICLE}, ${OWNER});
      INSERT INTO "ImageReaction" ("imageId", "userId", reaction, "createdAt") VALUES
        (${PRE_IMAGE}, ${QUIET}, 'Like', '${BEFORE}'),
        (${PRE_IMAGE}, ${OPTED_IN}, 'Like', '${BEFORE}'),
        (${PRE_IMAGE}, ${OPTED_IN_BUT_HIDDEN}, 'Like', '${BEFORE}'),
        (${PRE_IMAGE}, ${AFTER}, 'Like', '${AT_LAUNCH}'),
        (${PRE_IMAGE}, ${OWNER}, 'Like', '${BEFORE}');
      INSERT INTO "ArticleReaction" VALUES (${ARTICLE}, ${QUIET}, 'Like', '${BEFORE}');
    `);
  });

  afterEach(() =>
    holder.db.exec(`UPDATE "User" SET settings = '{}' WHERE id IN (${QUIET}, ${AFTER})`)
  );

  it('leaves out an older image reaction by default, still in the count', async () => {
    const page = await getReactors(holder.db as never, OWNER, 'image', PRE_IMAGE, {
      reaction: 'Like',
      cursor: null,
    } as never);
    expect(page?.reactors.map((r) => r.userId)).toEqual([OPTED_IN, OWNER, AFTER]);
    expect(page?.counts.Like).toBe(5);
  });

  it('lists the same older reaction once its reactor opts in', async () => {
    await holder.db.exec(
      `UPDATE "User" SET settings = '{"showPreLaunchReactions": true}' WHERE id = ${QUIET}`
    );
    expect(await reactors('image', PRE_IMAGE)).toEqual([QUIET, OPTED_IN, OWNER, AFTER]);
  });

  it('still hides a newer reaction from someone who opted out of reaction lists', async () => {
    await holder.db.exec(
      `UPDATE "User" SET settings = '{"hideFromReactionLists": true}' WHERE id = ${AFTER}`
    );
    expect(await reactors('image', PRE_IMAGE)).toEqual([OPTED_IN, OWNER]);
  });

  it('leaves article reactions alone', async () => {
    expect(await reactors('article', ARTICLE)).toEqual([QUIET]);
  });
});

describe('Creator Studio lists leave out a user who opted out', () => {
  it('"Who reacted": absent from the list, still in the count', async () => {
    const page = await getReactors(holder.db as never, OWNER, 'image', IMAGE, {
      reaction: 'Like',
      cursor: null,
    } as never);
    expect(page?.reactors.map((r) => r.userId)).toEqual([LISTED, OPTED_BACK_IN]);
    expect(page?.counts.Like).toBe(3);
  });

  it('"Who collected": absent from the list, still in the total', async () => {
    const page = await getCollectors(holder.db as never, OWNER, 'image', IMAGE, null);
    expect(page?.collectors.map((c) => c.userId)).toEqual([LISTED, OPTED_BACK_IN]);
    expect(page?.total).toBe(3);
  });
});

describe('Creator Studio lists on a blocked image', () => {
  // [id, ingestion, blockedFor, listed]
  const CASES: [number, string, string | null, boolean][] = [
    [910, 'Blocked', 'moderated', false],
    [913, 'Blocked', 'tos', false],
    [914, 'Blocked', 'CSAM', false],
    [915, 'Blocked', null, false],
    [911, 'Blocked', 'AiNotVerified', true],
    [912, 'Scanned', 'moderated', true],
    [916, 'Pending', 'moderated', true],
  ];
  const lists = async (imageId: number, ownerId = OWNER) => ({
    reactors: (
      await getReactors(holder.db as never, ownerId, 'image', imageId, {
        reaction: 'Like',
        cursor: null,
      } as never)
    )?.reactors.map((r) => r.userId),
    collectors: (
      await getCollectors(holder.db as never, ownerId, 'image', imageId, null)
    )?.collectors.map((c) => c.userId),
  });

  beforeAll(async () => {
    for (const [id, ingestion, blockedFor] of CASES) {
      await holder.db.query(
        `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor") VALUES ($1, $2, $3, $4)`,
        [id, OWNER, ingestion, blockedFor]
      );
      await holder.db.query(
        `INSERT INTO "ImageReaction" ("imageId", "userId", reaction) VALUES ($1, $2, 'Like')`,
        [id, LISTED]
      );
      await holder.db.query(
        `INSERT INTO "CollectionItem" ("collectionId", "imageId", status, "addedById") VALUES (1, $1, 'ACCEPTED', $2)`,
        [id, LISTED]
      );
    }
  });

  it.each(CASES)('image %i (%s, %s): listed = %s', async (id, ingestion, blockedFor, listed) => {
    expect(await lists(id)).toEqual(
      listed
        ? { reactors: [LISTED], collectors: [LISTED] }
        : { reactors: undefined, collectors: undefined }
    );
    // The page decides whether to render the lists with the same rule, in TypeScript.
    expect(imageAudienceListable({ ingestion, blockedFor })).toBe(listed);
  });

  it('still refuses a caller who does not own the image', async () => {
    expect(await lists(911, 999)).toEqual({ reactors: undefined, collectors: undefined });
  });
});
