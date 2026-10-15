import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
  sql.lit = (value: number): Ident => ({ ident: String(value) });
  return { sql };
});

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { getReactors } = await import('../reactors');
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
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int, ingestion text, "nsfwLevel" int, url text);
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
