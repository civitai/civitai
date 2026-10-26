import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { compileHarness } from '@civitai/db-queries/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReviewSort } from '~/server/common/enums';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import { getAllCommentsWithCachedUserSelect } from '~/server/selectors/comment.selector';
import {
  countTopLevelCommentsViaKysely,
  countTopLevelCommentsViaPrisma,
  findPinnedCommentsViaPrisma,
  findTopLevelCommentsViaPrisma,
  listPinnedCommentsViaKysely,
  listTopLevelCommentsViaKysely,
  topLevelCommentsWhere,
  type CommentListItem,
  type KyselyCommentListPage,
  type PinnedScope,
  type TopLevelCommentsFilter,
} from '~/server/services/hot-reads-4.reads';

/**
 * Parity gate for the model page's comment reads behind `kysely-hot-reads-4`: the visible top-level
 * comment count (`comment.getVisibleCountByModel`) and the `comment.getAll` lists (the unpinned
 * first page and the pinned block). Both paths run against the same rows in the same database, from
 * the same `TopLevelCommentsFilter`, and must return the same value, `toStrictEqual`: timestamps as
 * UTC Dates, enums as strings, NULL as `null`, counts as numbers, and rows in the same order (every
 * fixture below keeps `createdAt` and `pinnedAt` distinct, so neither path is comparing a tie). The
 * reactions under each comment are the one unordered relation: Prisma's nested read has no
 * `orderBy`, so both sides are compared sorted by id.
 *
 * Every viewer-dependent branch of the filter is a case of its own, with literal fixtures: no
 * exclusions, hidden and blocked authors excluded, one author only (which wins over exclusions), the
 * moderator view (ToS violations included), the hidden view (a NULL `hidden` matching neither), and
 * no model filter at all.
 *
 * The Prisma side of each read is the reader the service runs (hot-reads-4.reads.ts).
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_4_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost, so the suite cannot skip itself
 * there unnoticed. Locally, KYSELY_PARITY_DATABASE_URL works too, and must point at a THROWAWAY
 * database: the suite drops and recreates the `hot_reads_4_parity` schema. It deliberately does NOT
 * fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW (an aggregate view joined or filtered on a non-key column is computed in full).
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_4_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_4_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-4-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a count, a limit or another id.
const AUTHOR = 2401;
const DELETED = 2402;
const HIDDEN_USER = 2403;
const BLOCKER = 2404;
const REACTOR = 2405;
const OWNER = 2406;
const MODEL = 2501;
const OTHER_MODEL = 2502;
const EMPTY_MODEL = 2503;
const MISSING_MODEL = 2599;

// MODEL's comments. Top-level and visible to a plain viewer: C_FIRST, C_DELETED, C_BY_HIDDEN,
// C_BY_BLOCKER (unpinned), C_PINNED, C_PINNED_BLOCKER (pinned).
const C_FIRST = 2601;
const C_DELETED = 2602; // author deleted (NULL username), nsfw, NULL locked
const C_PINNED = 2603;
const C_PINNED_BLOCKER = 2604;
const C_REPLY = 2605; // a reply: never listed or counted
const C_TOS = 2606; // ToS violation: the moderator view only
const C_HIDDEN = 2607; // hidden: the hidden view only
const C_HIDDEN_NULL = 2608; // NULL hidden: matches neither view
const C_BY_HIDDEN = 2609;
const C_BY_BLOCKER = 2610;
const C_OTHER_MODEL = 2611; // OTHER_MODEL's
const C_PINNED_TOS = 2612;
const C_PINNED_HIDDEN = 2613;
const C_HIDDEN_TOS = 2614;

const viewer: TopLevelCommentsFilter = {
  modelId: MODEL,
  excludedUserIds: [],
  excludeTosViolations: true,
  hidden: false,
};
const FILTERS: [string, TopLevelCommentsFilter][] = [
  ['a viewer with no exclusions', viewer],
  [
    'a viewer excluding a hidden and a blocked author',
    {
      ...viewer,
      excludedUserIds: [HIDDEN_USER, BLOCKER],
    },
  ],
  [
    'one author only, which wins over the exclusions',
    {
      ...viewer,
      userId: AUTHOR,
      excludedUserIds: [AUTHOR, BLOCKER],
    },
  ],
  ['the moderator view (ToS violations included)', { ...viewer, excludeTosViolations: false }],
  ['the hidden view', { ...viewer, hidden: true }],
  ['the moderator hidden view', { ...viewer, excludeTosViolations: false, hidden: true }],
  ['no model filter (an undefined Prisma condition)', { ...viewer, modelId: undefined }],
  ['another model', { ...viewer, modelId: OTHER_MODEL }],
  ['a model with no comments', { ...viewer, modelId: EMPTY_MODEL }],
  ['a missing model', { ...viewer, modelId: MISSING_MODEL }],
];

const PAGES: [string, KyselyCommentListPage][] = [
  ['newest first', { limit: 25, sort: ReviewSort.Newest }],
  ['oldest first', { limit: 25, sort: ReviewSort.Oldest }],
  ['newest first, capped', { limit: 2, sort: ReviewSort.Newest }],
  ['newest first, the second page by skip', { limit: 2, skip: 2, sort: ReviewSort.Newest }],
  ['oldest first, a skip of 0', { limit: 3, skip: 0, sort: ReviewSort.Oldest }],
];

const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
const sortReactions = (comments: CommentListItem[]) =>
  comments.map((comment) => ({ ...comment, reactions: byId(comment.reactions) }));

describe.skipIf(!parityUrl)('hot reads 4: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('User')} (id, username, image, "deletedAt") VALUES
        (${AUTHOR}, 'alpha', 'a.png', NULL),
        (${DELETED}, NULL, NULL, '2026-02-01 00:00:00.123'),
        (${HIDDEN_USER}, 'hiddenone', NULL, NULL),
        (${BLOCKER}, 'blocker', 'b.png', NULL),
        (${REACTOR}, 'reactor', NULL, NULL),
        (${OWNER}, 'owner', NULL, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Model')} (id, name, "userId") VALUES
        (${MODEL}, 'Parity model', ${OWNER}),
        (${OTHER_MODEL}, 'Other model', ${OWNER}),
        (${EMPTY_MODEL}, 'Empty model', ${OWNER})
    `);
    // Ids out of createdAt order, every createdAt and pinnedAt distinct.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Comment')} (id, content, "createdAt", nsfw, "tosViolation", "parentId",
        "userId", "modelId", locked, hidden, "pinnedAt") VALUES
        (${C_FIRST}, '<p>first</p>', '2026-03-03 00:00:00.003', false, false, NULL, ${AUTHOR},
          ${MODEL}, false, false, NULL),
        (${C_DELETED}, 'by a deleted user', '2026-03-01 00:00:00.001', true, false, NULL,
          ${DELETED}, ${MODEL}, NULL, false, NULL),
        (${C_PINNED}, 'pinned', '2026-03-05 00:00:00.005', false, false, NULL, ${AUTHOR}, ${MODEL},
          true, false, '2026-04-02 00:00:00.002'),
        (${C_PINNED_BLOCKER}, 'pinned blocker', '2026-03-06 00:00:00.006', false, false, NULL,
          ${BLOCKER}, ${MODEL}, false, false, '2026-04-03 00:00:00.003'),
        (${C_REPLY}, 'a reply', '2026-03-11 00:00:00.011', false, false, ${C_FIRST}, ${AUTHOR},
          ${MODEL}, false, false, NULL),
        (${C_TOS}, 'tos', '2026-03-04 00:00:00.004', false, true, NULL, ${DELETED}, ${MODEL},
          false, false, NULL),
        (${C_HIDDEN}, 'hidden', '2026-03-07 00:00:00.007', false, false, NULL, ${AUTHOR}, ${MODEL},
          false, true, NULL),
        (${C_HIDDEN_NULL}, 'hidden null', '2026-03-08 00:00:00.008', false, false, NULL, ${AUTHOR},
          ${MODEL}, false, NULL, NULL),
        (${C_BY_HIDDEN}, 'by a hidden user', '2026-03-02 00:00:00.002', false, false, NULL,
          ${HIDDEN_USER}, ${MODEL}, false, false, NULL),
        (${C_BY_BLOCKER}, 'by a blocker', '2026-03-09 00:00:00.009', false, false, NULL,
          ${BLOCKER}, ${MODEL}, false, false, NULL),
        (${C_OTHER_MODEL}, 'other model', '2026-03-10 00:00:00.010', false, false, NULL, ${AUTHOR},
          ${OTHER_MODEL}, false, false, NULL),
        (${C_PINNED_TOS}, 'pinned tos', '2026-02-28 00:00:00.000', false, true, NULL, ${AUTHOR},
          ${MODEL}, false, false, '2026-04-01 00:00:00.001'),
        (${C_PINNED_HIDDEN}, 'pinned hidden', '2026-03-12 00:00:00.012', false, false, NULL,
          ${HIDDEN_USER}, ${MODEL}, false, true, '2026-04-04 00:00:00.004'),
        (${C_HIDDEN_TOS}, 'hidden tos', '2026-03-13 00:00:00.013', false, true, NULL, ${AUTHOR},
          ${MODEL}, false, true, NULL)
    `);
    // Ids out of insertion order on C_FIRST, a reactor with a NULL username, a reaction on a reply.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('CommentReaction')} (id, "commentId", "userId", reaction) VALUES
        (2703, ${C_FIRST}, ${REACTOR}, 'Like'),
        (2701, ${C_FIRST}, ${AUTHOR}, 'Heart'),
        (2702, ${C_FIRST}, ${DELETED}, 'Laugh'),
        (2704, ${C_PINNED}, ${REACTOR}, 'Cry'),
        (2705, ${C_REPLY}, ${REACTOR}, 'Like'),
        (2706, ${C_OTHER_MODEL}, ${REACTOR}, 'Dislike')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe('the visible count', () => {
    const scopes: PinnedScope[] = ['any', 'unpinned', 'pinned'];
    const cases = FILTERS.flatMap(([label, filter]) =>
      scopes.map((scope) => [`${label}, ${scope}`, filter, scope] as const)
    );

    it.each(cases)('%s', async (_, filter, scope) => {
      const viaPrisma = await countTopLevelCommentsViaPrisma(prisma, filter, scope);
      const viaKysely = await countTopLevelCommentsViaKysely(kysely, filter, scope);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: each filter branch counts the fixture rows expected', async () => {
      const count = (filter: TopLevelCommentsFilter, scope: PinnedScope = 'any') =>
        countTopLevelCommentsViaKysely(kysely, filter, scope);
      expect(await count(viewer)).toBe(6);
      expect(await count(viewer, 'unpinned')).toBe(4);
      expect(await count(viewer, 'pinned')).toBe(2);
      expect(await count({ ...viewer, excludedUserIds: [HIDDEN_USER, BLOCKER] })).toBe(3);
      expect(await count({ ...viewer, userId: AUTHOR, excludedUserIds: [AUTHOR] })).toBe(2);
      expect(await count({ ...viewer, excludeTosViolations: false })).toBe(8);
      expect(await count({ ...viewer, hidden: true })).toBe(2);
      expect(await count({ ...viewer, excludeTosViolations: false, hidden: true })).toBe(3);
      expect(await count({ ...viewer, modelId: undefined })).toBe(7);
      expect(await count({ ...viewer, modelId: MISSING_MODEL })).toBe(0);
    });
  });

  describe('the unpinned list', () => {
    const cases = FILTERS.flatMap(([label, filter]) =>
      PAGES.map(([pageLabel, page]) => [`${label}, ${pageLabel}`, filter, page] as const)
    );

    it.each(cases)('%s', async (_, filter, page) => {
      const viaPrisma = await findTopLevelCommentsViaPrisma(
        prisma,
        filter,
        page,
        getAllCommentsWithCachedUserSelect
      );
      const viaKysely = await listTopLevelCommentsViaKysely(kysely, filter, page);
      expect(sortReactions(viaKysely)).toStrictEqual(sortReactions(viaPrisma));
    });

    it('control: the fixtures exercise order, every filter branch and the paging', async () => {
      const ids = async (filter: TopLevelCommentsFilter, page: KyselyCommentListPage) =>
        (await listTopLevelCommentsViaKysely(kysely, filter, page)).map((c) => c.id);
      const newest = { limit: 25, sort: ReviewSort.Newest } as const;
      expect(await ids(viewer, newest)).toEqual([C_BY_BLOCKER, C_FIRST, C_BY_HIDDEN, C_DELETED]);
      expect(await ids(viewer, { limit: 25, sort: ReviewSort.Oldest })).toEqual([
        C_DELETED,
        C_BY_HIDDEN,
        C_FIRST,
        C_BY_BLOCKER,
      ]);
      expect(await ids(viewer, { limit: 2, skip: 2, sort: ReviewSort.Newest })).toEqual([
        C_BY_HIDDEN,
        C_DELETED,
      ]);
      expect(await ids({ ...viewer, excludedUserIds: [HIDDEN_USER, BLOCKER] }, newest)).toEqual([
        C_FIRST,
        C_DELETED,
      ]);
      expect(await ids({ ...viewer, userId: AUTHOR, excludedUserIds: [AUTHOR] }, newest)).toEqual([
        C_FIRST,
      ]);
      expect(await ids({ ...viewer, excludeTosViolations: false }, newest)).toEqual([
        C_BY_BLOCKER,
        C_TOS,
        C_FIRST,
        C_BY_HIDDEN,
        C_DELETED,
      ]);
      expect(await ids({ ...viewer, hidden: true }, newest)).toEqual([C_HIDDEN]);
      expect(await ids({ ...viewer, excludeTosViolations: false, hidden: true }, newest)).toEqual([
        C_HIDDEN_TOS,
        C_HIDDEN,
      ]);
      expect(await ids({ ...viewer, modelId: undefined }, newest)).toEqual([
        C_OTHER_MODEL,
        C_BY_BLOCKER,
        C_FIRST,
        C_BY_HIDDEN,
        C_DELETED,
      ]);
    });

    it('control: one item carries the author, the reactions and the model name', async () => {
      const list = await listTopLevelCommentsViaKysely(kysely, viewer, {
        limit: 25,
        sort: ReviewSort.Newest,
      });
      const first = list.find((c) => c.id === C_FIRST);
      expect(first && { ...first, reactions: byId(first.reactions) }).toStrictEqual({
        id: C_FIRST,
        createdAt: new Date('2026-03-03T00:00:00.003Z'),
        nsfw: false,
        content: '<p>first</p>',
        modelId: MODEL,
        parentId: null,
        locked: false,
        tosViolation: false,
        hidden: false,
        pinnedAt: null,
        user: { id: AUTHOR, username: 'alpha', deletedAt: null, image: 'a.png' },
        reactions: [
          { id: 2701, reaction: 'Heart', user: { id: AUTHOR, username: 'alpha' } },
          { id: 2702, reaction: 'Laugh', user: { id: DELETED, username: null } },
          { id: 2703, reaction: 'Like', user: { id: REACTOR, username: 'reactor' } },
        ],
        model: { name: 'Parity model' },
      });
      expect(list.find((c) => c.id === C_DELETED)).toStrictEqual({
        id: C_DELETED,
        createdAt: new Date('2026-03-01T00:00:00.001Z'),
        nsfw: true,
        content: 'by a deleted user',
        modelId: MODEL,
        parentId: null,
        locked: null,
        tosViolation: false,
        hidden: false,
        pinnedAt: null,
        user: {
          id: DELETED,
          username: null,
          deletedAt: new Date('2026-02-01T00:00:00.123Z'),
          image: null,
        },
        reactions: [],
        model: { name: 'Parity model' },
      });
    });
  });

  describe('the pinned block', () => {
    it.each(FILTERS)('%s', async (_, filter) => {
      const viaPrisma = await findPinnedCommentsViaPrisma(
        prisma,
        filter,
        getAllCommentsWithCachedUserSelect
      );
      const viaKysely = await listPinnedCommentsViaKysely(kysely, filter);
      expect(sortReactions(viaKysely)).toStrictEqual(sortReactions(viaPrisma));
    });

    it('control: pinned rows come back pinnedAt desc, filtered like the list', async () => {
      const ids = async (filter: TopLevelCommentsFilter) =>
        (await listPinnedCommentsViaKysely(kysely, filter)).map((c) => c.id);
      expect(await ids(viewer)).toEqual([C_PINNED_BLOCKER, C_PINNED]);
      expect(await ids({ ...viewer, excludeTosViolations: false })).toEqual([
        C_PINNED_BLOCKER,
        C_PINNED,
        C_PINNED_TOS,
      ]);
      expect(await ids({ ...viewer, excludedUserIds: [BLOCKER] })).toEqual([C_PINNED]);
      expect(await ids({ ...viewer, hidden: true })).toEqual([C_PINNED_HIDDEN]);
      const [, pinned] = await listPinnedCommentsViaKysely(kysely, viewer);
      expect(pinned.pinnedAt).toEqual(new Date('2026-04-02T00:00:00.002Z'));
      expect(pinned.reactions).toStrictEqual([
        { id: 2704, reaction: 'Cry', user: { id: REACTOR, username: 'reactor' } },
      ]);
    });
  });
});

describe('hot reads 4: the Prisma where is the one the service always built', () => {
  // The where the comment service built inline before this change, for each filter branch.
  it.each<[string, TopLevelCommentsFilter, object]>([
    [
      'no exclusions',
      viewer,
      {
        modelId: MODEL,
        userId: undefined,
        parentId: { equals: null },
        tosViolation: false,
        hidden: false,
      },
    ],
    [
      'exclusions',
      { ...viewer, excludedUserIds: [HIDDEN_USER, BLOCKER] },
      {
        modelId: MODEL,
        userId: { notIn: [HIDDEN_USER, BLOCKER] },
        parentId: { equals: null },
        tosViolation: false,
        hidden: false,
      },
    ],
    [
      'one author over exclusions',
      { ...viewer, userId: AUTHOR, excludedUserIds: [BLOCKER] },
      {
        modelId: MODEL,
        userId: AUTHOR,
        parentId: { equals: null },
        tosViolation: false,
        hidden: false,
      },
    ],
    [
      'the moderator hidden view',
      { ...viewer, excludeTosViolations: false, hidden: true },
      {
        modelId: MODEL,
        userId: undefined,
        parentId: { equals: null },
        tosViolation: undefined,
        hidden: true,
      },
    ],
  ])('%s', (_, filter, expected) => {
    expect(topLevelCommentsWhere(filter)).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// No statement reads a VIEW. Offline: the statements are compiled, not run.

const SCHEMA_PRISMA = resolve(
  here,
  '../../../../packages/civitai-db-schema/prisma/schema.full.prisma'
);

const schemaLines = () => readFileSync(SCHEMA_PRISMA, 'utf-8').split('\n');
const isViewMarker = (line: string) => line.trim() === '/// @view';

/**
 * Every model declared `/// @view` in schema.full.prisma. The marker sits above the model, in its
 * doc comment block, sometimes with a blank line between them, so the walk up from each `model`
 * line skips blank and `///` lines and stops at anything else.
 */
function declaredViews(): Set<string> & { markersAttributed: number } {
  const lines = schemaLines();
  const views = new Set<string>();
  const attributed = new Set<number>();
  lines.forEach((line, i) => {
    const model = /^model (\w+) \{/.exec(line);
    if (!model) return;
    for (let j = i - 1; j >= 0 && (lines[j].trim() === '' || lines[j].startsWith('///')); j--)
      if (isViewMarker(lines[j])) {
        views.add(model[1]);
        attributed.add(j);
      }
  });
  return Object.assign(views, { markersAttributed: attributed.size });
}

/** The quoted relation names a compiled statement reads FROM or JOINs. */
function relationsOf(sqlText: string): string[] {
  return [...sqlText.matchAll(/\b(?:from|join)\s+"(\w+)"/gi)].map((match) => match[1]);
}

async function compiledRelations(read: (db: never) => Promise<unknown>) {
  const harness = compileHarness();
  // The dummy driver returns no rows, so a read that requires one throws after compiling.
  await read(harness.db as never).catch(() => undefined);
  return harness.queries.map((query) => relationsOf(query.sql));
}

describe('hot reads 4: no statement reads a view', () => {
  it('control: the view list is read from the schema, and names the known aggregate views', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ModelReportStat', 'GenerationCoverage', 'ImageTag'])
      expect(views.has(known), known).toBe(true);
    for (const table of ['Comment', 'User', 'Model', 'CommentReaction'])
      expect(views.has(table), table).toBe(false);
    // Every marker line in the file is attributed to a model, so none is missed.
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it('control: the relation extractor finds a view a statement reads', () => {
    expect(relationsOf('select * from "UserStat" inner join "User" on 1 = 1')).toEqual([
      'UserStat',
      'User',
    ]);
  });

  const filter: TopLevelCommentsFilter = {
    modelId: 1,
    excludedUserIds: [2],
    excludeTosViolations: true,
    hidden: false,
  };
  // The reactions subquery sits in the select list, so it is compiled before the FROM.
  const LIST = ['CommentReaction', 'User', 'Comment', 'User', 'Model'];

  it.each<[string, (db: never) => Promise<unknown>, string[][]]>([
    ['the visible count', (db) => countTopLevelCommentsViaKysely(db, filter, 'any'), [['Comment']]],
    [
      'the unpinned list (one statement)',
      (db) => listTopLevelCommentsViaKysely(db, filter, { limit: 3, sort: ReviewSort.Newest }),
      [LIST],
    ],
    ['the pinned block (one statement)', (db) => listPinnedCommentsViaKysely(db, filter), [LIST]],
  ])('%s', async (_, read, expected) => {
    const relations = await compiledRelations(read);
    // An exact ledger: a joined view, or any extra relation, fails here.
    expect(relations).toEqual(expected);
    const views = declaredViews();
    for (const relation of relations.flat()) expect(views.has(relation), relation).toBe(false);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
