import { readFileSync } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queues, onReactionRemoved, chInsert, logToAxiom } = vi.hoisted(() => ({
  queues: {
    article: vi.fn<(ids: number[]) => Promise<undefined>>(async () => undefined),
    post: vi.fn<(ids: number[]) => Promise<undefined>>(async () => undefined),
    bountyEntry: vi.fn<(ids: number[]) => Promise<undefined>>(async () => undefined),
    question: vi.fn<(ids: number[]) => Promise<undefined>>(async () => undefined),
    answer: vi.fn<(ids: number[]) => Promise<undefined>>(async () => undefined),
  },
  onReactionRemoved: vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
  chInsert: vi.fn<(input: { table: string; values: unknown[] }) => Promise<undefined>>(
    async () => undefined
  ),
  logToAxiom: vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
}));

vi.mock('~/server/metrics', () => ({
  articleMetrics: { queueUpdate: queues.article },
  postMetrics: { queueUpdate: queues.post },
  bountyEntryMetrics: { queueUpdate: queues.bountyEntry },
  questionMetrics: { queueUpdate: queues.question },
  answerMetrics: { queueUpdate: queues.answer },
}));
vi.mock('~/server/events/points/hooks', () => ({ onReactionRemoved }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: chInsert } }));
vi.mock('~/server/logging/client', () => ({ logToAxiom }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  countUserReactions,
  IMAGE_ROWS_PER_RUN,
  REACTION_TABLES,
  removeUserReactions,
} from '~/server/services/user-reaction-erasure.service';

const USER = 3001;
const OTHER = 4002;
/** More DELETEs than this on one table in one call means the batch loop did not stop. */
const DELETE_BUDGET = 20;

type Row = { id: number; userId: number; [fk: string]: number };
type World = { tables: Record<string, Row[]>; owners: Record<string, Record<number, number>> };

/**
 * An in-memory Postgres for the statement shapes the service sends. A statement of any other shape
 * throws, so a rewritten query cannot pass by falling through to an empty answer. `userId`, `LIMIT` and
 * the id list come from the bound values, so a query that drops or misbinds its user filter deletes the
 * other account's rows; a RETURNING column the rows do not have throws, as Postgres would.
 */
function installDb(world: World) {
  const { tables, owners } = world;
  const statements: string[] = [];
  const deletes: Record<string, number> = {};
  dbMock.dbWrite.$queryRaw.mockImplementation(async (first: unknown, ...rest: unknown[]) => {
    const q: { text: string; values: unknown[] } = Array.isArray(first)
      ? Prisma.sql(first as unknown as TemplateStringsArray, ...(rest as never[]))
      : (first as { text: string; values: unknown[] });
    const text = q.text.replace(/\s+/g, ' ').trim();
    const v = (n: string) => q.values[Number(n) - 1];
    statements.push(text);

    const deleteRows = (table: string, rows: Row[], fk: string) => {
      deletes[table] = (deletes[table] ?? 0) + 1;
      if (deletes[table] > DELETE_BUDGET) throw new Error(`loop did not stop on ${table}`);
      const gone = new Set(rows);
      tables[table] = tables[table].filter((r) => !gone.has(r));
      return rows.map((r) => {
        if (!(fk in r)) throw new Error(`column "${fk}" does not exist on ${table}`);
        return { entityId: r[fk] };
      });
    };

    let m = text.match(
      /^DELETE FROM "(\w+)" WHERE id IN \( SELECT id FROM "\1" WHERE "userId" = \$(\d+) LIMIT \$(\d+) \) RETURNING "(\w+)" AS "entityId"$/
    );
    if (m) {
      const [, table, u, l, fk] = m;
      const mine = tables[table].filter((r) => r.userId === v(u)).slice(0, Number(v(l)));
      return deleteRows(table, mine, fk);
    }
    m = text.match(
      /^DELETE FROM "(\w+)" WHERE "userId" = \$(\d+) RETURNING "(\w+)" AS "entityId"$/
    );
    if (m) {
      const [, table, u, fk] = m;
      return deleteRows(
        table,
        tables[table].filter((r) => r.userId === v(u)),
        fk
      );
    }
    m = text.match(
      /^SELECT id, "userId" AS "ownerId" FROM "(\w+)" WHERE id = ANY\(\$(\d+)::int\[\]\)$/
    );
    if (m) {
      const [, table, ids] = m;
      const known = owners[table];
      if (!known) throw new Error(`no owner table ${table}`);
      return (v(ids) as number[])
        .filter((id) => id in known)
        .map((id) => ({ id, ownerId: known[id] }));
    }
    m = text.match(
      /^SELECT count\(\*\)::int AS remaining FROM "ImageReaction" WHERE "userId" = \$(\d+)$/
    );
    if (m) return [{ remaining: tables.ImageReaction.filter((r) => r.userId === v(m![1])).length }];
    if (text.includes(' UNION ALL ')) {
      return text.split(' UNION ALL ').map((part) => {
        const c = part.match(
          /^SELECT \$(\d+) AS "table", count\(\*\)::int AS n FROM "(\w+)" WHERE "userId" = \$(\d+)$/
        );
        if (!c) throw new Error(`unexpected count statement: ${part}`);
        const [, t, table, u] = c;
        if (v(t) !== table) throw new Error(`label ${String(v(t))} does not name ${table}`);
        return { table, n: tables[table].filter((r) => r.userId === v(u)).length };
      });
    }
    throw new Error(`unexpected statement: ${text}`);
  });
  return { tables, statements };
}

const rows = (userId: number, fk: string, entityIds: number[], idFrom = 1): Row[] =>
  entityIds.map((e, i) => ({ id: idFrom + i, userId, [fk]: e }));

function world(): World {
  return {
    tables: {
      // Image 12 has no row any more: an orphaned reaction, whose owner cannot be read.
      ImageReaction: [
        ...rows(USER, 'imageId', [10, 11, 11, 12]),
        ...rows(OTHER, 'imageId', [10], 100),
      ],
      ArticleReaction: [
        ...rows(USER, 'articleId', [20, 20, 21]),
        ...rows(OTHER, 'articleId', [20], 100),
      ],
      PostReaction: rows(USER, 'postId', [30]),
      BountyEntryReaction: rows(USER, 'bountyEntryId', [40, 41]),
      CommentV2Reaction: [...rows(USER, 'commentId', [50]), ...rows(OTHER, 'commentId', [50], 100)],
      CommentReaction: rows(USER, 'commentId', [60]),
      ResourceReviewReaction: rows(USER, 'reviewId', [70]),
      ClubPostReaction: rows(USER, 'clubPostId', [75]),
      QuestionReaction: rows(USER, 'questionId', [80]),
      AnswerReaction: rows(USER, 'answerId', [90]),
    },
    owners: {
      // Article 21 is the reactor's own: the score never counted it.
      Image: { 10: 500, 11: 501 },
      Article: { 20: 600, 21: USER },
      Post: { 30: 700 },
      BountyEntry: { 40: 800, 41: 800 },
      CommentV2: { 50: 900 },
      Comment: { 60: 901 },
      Question: { 80: 902 },
      Answer: { 90: 903 },
    },
  };
}

const ownerScoreRows = () =>
  chInsert.mock.calls
    .map(([input]) => {
      expect(input.table).toBe('reactions_owner_scores');
      return input.values as { ownerId: number; score: number }[];
    })
    .flat()
    .sort((a, b) => a.ownerId - b.ownerId);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('removeUserReactions', () => {
  it("removes the user's rows from every table and leaves everyone else's", async () => {
    const { tables } = installDb(world());

    const result = await removeUserReactions(USER);

    expect(result).toEqual({
      removed: {
        ImageReaction: 4,
        ArticleReaction: 3,
        PostReaction: 1,
        BountyEntryReaction: 2,
        CommentV2Reaction: 1,
        CommentReaction: 1,
        ResourceReviewReaction: 1,
        ClubPostReaction: 1,
        QuestionReaction: 1,
        AnswerReaction: 1,
      },
      remaining: 0,
    });
    for (const [table, left] of Object.entries(tables))
      expect(
        left.every((r) => r.userId === OTHER),
        table
      ).toBe(true);
    expect(tables.ImageReaction).toHaveLength(1);
    expect(tables.ArticleReaction).toHaveLength(1);
    expect(tables.CommentV2Reaction).toHaveLength(1);
  });

  it('queues the Postgres metric recompute once per table, for each distinct entity', async () => {
    installDb(world());
    await removeUserReactions(USER);

    for (const [queue, ids] of [
      [queues.article, [20, 21]],
      [queues.post, [30]],
      [queues.bountyEntry, [40, 41]],
      [queues.question, [80]],
      [queues.answer, [90]],
    ] as const) {
      expect(queue).toHaveBeenCalledTimes(1);
      expect(queue).toHaveBeenCalledWith(ids);
    }
  });

  it('queues nothing for a table it removed nothing from', async () => {
    const w = world();
    w.tables.ArticleReaction = rows(OTHER, 'articleId', [20], 100);
    installDb(w);
    await removeUserReactions(USER);
    expect(queues.article).not.toHaveBeenCalled();
    expect(queues.post).toHaveBeenCalledWith([30]);
  });

  it("lowers each content owner's reactions-received score by the reactions removed from them", async () => {
    installDb(world());
    await removeUserReactions(USER);

    expect(ownerScoreRows()).toEqual([
      { ownerId: 500, score: -1 },
      { ownerId: 501, score: -2 },
      { ownerId: 600, score: -2 },
      { ownerId: 700, score: -1 },
      { ownerId: 800, score: -2 },
      { ownerId: 900, score: -1 },
      { ownerId: 901, score: -1 },
      { ownerId: 902, score: -1 },
      { ownerId: 903, score: -1 },
    ]);
  });

  it('writes no reactor id to ClickHouse', async () => {
    installDb(world());
    await removeUserReactions(USER);
    expect(JSON.stringify(chInsert.mock.calls)).not.toContain(String(USER));
  });

  it('withdraws event points once per distinct image and article', async () => {
    installDb(world());
    await removeUserReactions(USER);

    expect(onReactionRemoved.mock.calls.map(([input]) => input)).toEqual([
      { entityType: 'image', entityId: 10, userId: USER },
      { entityType: 'image', entityId: 11, userId: USER },
      { entityType: 'image', entityId: 12, userId: USER },
      { entityType: 'article', entityId: 20, userId: USER },
      { entityType: 'article', entityId: 21, userId: USER },
    ]);
  });

  it('logs a failed follow-up with its ids and carries on with the erasure', async () => {
    queues.article.mockRejectedValueOnce(new Error('redis down'));
    const { tables } = installDb(world());

    const result = await removeUserReactions(USER);

    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'user-reaction-erasure-follow-up',
        details: { table: 'ArticleReaction', step: 'queue', entityIds: [20, 21] },
      })
    );
    // The same table's other follow-ups and every later table still ran.
    expect(ownerScoreRows()).toContainEqual({ ownerId: 600, score: -2 });
    expect(queues.answer).toHaveBeenCalledWith([90]);
    expect(result.removed.AnswerReaction).toBe(1);
    expect(tables.AnswerReaction).toHaveLength(0);
  });

  it(`stops after ${IMAGE_ROWS_PER_RUN} image reactions and reports the rest`, async () => {
    const extra = 3_000;
    const w = world();
    w.tables.ImageReaction = rows(
      USER,
      'imageId',
      Array.from({ length: IMAGE_ROWS_PER_RUN + extra }, (_, i) => i + 1)
    );
    const { tables } = installDb(w);

    const first = await removeUserReactions(USER);
    expect(first.removed.ImageReaction).toBe(IMAGE_ROWS_PER_RUN);
    expect(first.remaining).toBe(extra);
    // Everything else is cleared on the first run.
    expect(first.removed.CommentV2Reaction).toBe(1);

    const second = await removeUserReactions(USER);
    expect(second.removed.ImageReaction).toBe(extra);
    expect(second.removed.CommentV2Reaction).toBe(0);
    expect(second.remaining).toBe(0);
    expect(tables.ImageReaction).toHaveLength(0);
  });
});

describe('countUserReactions', () => {
  it("counts only the user's rows, every table present including the empty ones", async () => {
    const w = world();
    w.tables.ClubPostReaction = [];
    installDb(w);
    expect(await countUserReactions(USER)).toEqual({
      ImageReaction: 4,
      ArticleReaction: 3,
      PostReaction: 1,
      BountyEntryReaction: 2,
      CommentV2Reaction: 1,
      CommentReaction: 1,
      ResourceReviewReaction: 1,
      ClubPostReaction: 0,
      QuestionReaction: 1,
      AnswerReaction: 1,
    });
  });

  it('writes nothing', async () => {
    const { statements } = installDb(world());
    await countUserReactions(USER);
    expect(statements.some((s) => /^DELETE/.test(s))).toBe(false);
    expect(chInsert).not.toHaveBeenCalled();
  });
});

describe('the table list', () => {
  // An erasure that misses a table leaves the person's data behind with nothing to say so.
  it('names every *Reaction model in the schema that has a userId', () => {
    const schema = readFileSync(
      path.resolve(__dirname, '../../../../packages/civitai-db-schema/prisma/schema.full.prisma'),
      'utf8'
    );
    const models = [...schema.matchAll(/^model (\w*Reaction) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+userId\s/m.test(body))
      .map(([, name]) => name)
      .sort();

    expect(models.length).toBeGreaterThan(5);
    expect([...REACTION_TABLES].sort()).toEqual(models);
  });
});
