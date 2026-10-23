import { readFileSync } from 'fs';
import path from 'path';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queues, onReactionRemoved, chInsert } = vi.hoisted(() => ({
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

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
type World = { tables: Record<string, Row[]> };

/**
 * An in-memory Postgres for the statement shapes the service sends. A statement of any other shape
 * throws, so a rewritten query cannot pass by falling through to an empty answer. `userId`, `LIMIT` and
 * the id list come from the bound values, so a query that drops or misbinds its user filter deletes the
 * other account's rows; a RETURNING column the rows do not have throws, as Postgres would.
 */
function installDb(world: World) {
  const { tables } = world;
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
      // Image 12 has no row any more: an orphaned reaction.
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
      CommentV3Reaction: [...rows(USER, 'commentId', [55]), ...rows(OTHER, 'commentId', [55], 100)],
      CommentReaction: rows(USER, 'commentId', [60]),
      ResourceReviewReaction: rows(USER, 'reviewId', [70]),
      ClubPostReaction: rows(USER, 'clubPostId', [75]),
      QuestionReaction: rows(USER, 'questionId', [80]),
      AnswerReaction: rows(USER, 'answerId', [90]),
    },
  };
}

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
        CommentV3Reaction: 1,
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
    expect(tables.CommentV3Reaction).toHaveLength(1);
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

  // Deliberately: see the service's note on `reactions_owner_scores`.
  it('writes nothing to ClickHouse', async () => {
    installDb(world());
    await removeUserReactions(USER);
    expect(chInsert).not.toHaveBeenCalled();
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

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'user-reaction-erasure-follow-up',
        details: { table: 'ArticleReaction', step: 'queue', entities: 2 },
      })
    );
    // The log carries a count, never the ids of what the person reacted to.
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('[20,21]');
    // The same table's other follow-ups and every later table still ran.
    expect(onReactionRemoved).toHaveBeenCalledWith({
      entityType: 'article',
      entityId: 20,
      userId: USER,
    });
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
      CommentV3Reaction: 1,
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
