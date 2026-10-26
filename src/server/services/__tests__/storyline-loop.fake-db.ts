import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * An in-memory stand-in for the tables the storyline continuation loop touches,
 * installed onto the canonical `dbWrite`/`dbRead` mocks, so a test can run the
 * real submit, approve, settle, edge and read code end to end.
 *
 * Strict by design: a `where` operator, a relation or a raw statement it does
 * not model throws by name instead of matching everything. A fake that answers
 * a question it was never taught makes the test pass for the wrong reason.
 *
 * What it models, because the code under test relies on it:
 * - interactive transactions that roll every table back when the callback throws;
 * - unique constraints that throw the real `PrismaClientKnownRequestError` P2002;
 * - reads that return copies, so a row a caller holds does not change under it;
 * - nested relation selects with their own `where`, `orderBy` and `take`.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

type Relation =
  | { kind: 'one'; model: string; from: string; to: string }
  | { kind: 'many'; model: string; from: string; to: string };

const RELATIONS: Record<string, Record<string, Relation>> = {
  placement: { placer: { kind: 'one', model: 'user', from: 'placerId', to: 'id' } },
  post: {
    user: { kind: 'one', model: 'user', from: 'userId', to: 'id' },
    images: { kind: 'many', model: 'image', from: 'id', to: 'postId' },
    storylineChapter: { kind: 'one', model: 'storylineChapter', from: 'id', to: 'postId' },
  },
  storyline: {
    user: { kind: 'one', model: 'user', from: 'userId', to: 'id' },
    chapters: { kind: 'many', model: 'storylineChapter', from: 'id', to: 'storylineId' },
  },
  storylineChapter: {
    storyline: { kind: 'one', model: 'storyline', from: 'storylineId', to: 'id' },
    post: { kind: 'one', model: 'post', from: 'postId', to: 'id' },
    parents: { kind: 'many', model: 'storylineChapterEdge', from: 'id', to: 'chapterId' },
  },
  storylineChapterEdge: {
    chapter: { kind: 'one', model: 'storylineChapter', from: 'chapterId', to: 'id' },
  },
  storylinePendingChapter: {
    storyline: { kind: 'one', model: 'storyline', from: 'storylineId', to: 'id' },
    parentChapter: { kind: 'one', model: 'storylineChapter', from: 'parentChapterId', to: 'id' },
  },
};

type Unique = { columns: string[]; where?: (row: Row) => boolean };

/**
 * Column sets each table refuses to duplicate, as the migrations define them,
 * partial indexes included, and the compound-key names Prisma gives them.
 */
const UNIQUES: Record<string, Unique[]> = {
  placementTransaction: [{ columns: ['placementId', 'kind'] }],
  storylineChapter: [
    { columns: ['postId'] },
    { columns: ['placementId'] },
    // StorylineChapter_storylineId_root_key: one first chapter per storyline.
    { columns: ['storylineId'], where: (row) => row.depth === 0 },
  ],
  storylineChapterEdge: [
    { columns: ['chapterId', 'parentChapterId'] },
    // StorylineChapterEdge_one_canon_key: at most one canon child per parent.
    { columns: ['parentChapterId'], where: (row) => row.canon === true },
  ],
  storylineCollaborator: [{ columns: ['storylineId', 'userId'] }],
  storylinePendingChapter: [
    { columns: ['postId'] },
    // StorylinePendingChapter_storylineId_root_key: one chapter-1 draft per storyline.
    { columns: ['storylineId'], where: (row) => row.parentChapterId == null },
  ],
  placementSpace: [{ columns: ['surface', 'entityType', 'entityId'] }],
  placementSuspension: [{ columns: ['userId'] }],
};
const COMPOUND_KEYS: Record<string, string[]> = {
  placementId_kind: ['placementId', 'kind'],
  storylineId_userId: ['storylineId', 'userId'],
  surface_entityType_entityId: ['surface', 'entityType', 'entityId'],
};

const DEFAULTS: Record<string, () => Row> = {
  placement: () => ({
    sellerId: null,
    free: false,
    spendType: null,
    status: 'pending',
    removedBy: null,
    feeWaived: false,
    expiresAt: null,
    resolvedAt: null,
    resolvedById: null,
    takenDownAt: null,
    takenDownById: null,
    data: {},
    createdAt: new Date(),
  }),
  placementTransaction: () => ({
    transactionId: null,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    createdAt: new Date(),
  }),
  storyline: () => ({
    tosViolationByScan: false,
    tosViolationByModerator: false,
    minorByScan: false,
    scanFlagLiftedTextHash: null,
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
  }),
  storylineChapter: () => ({
    postId: null,
    placementId: null,
    createdAt: new Date(),
    removedAt: null,
  }),
  storylineChapterEdge: () => ({ canon: false, createdAt: new Date() }),
  storylinePendingChapter: () => ({ parentChapterId: null, createdAt: new Date() }),
};

const MODELS = [
  'keyValue',
  'user',
  'post',
  'image',
  'storyline',
  'storylineChapter',
  'storylineChapterEdge',
  'storylineCollaborator',
  'storylinePendingChapter',
  'placement',
  'placementTransaction',
  'placementSpace',
  'placementSuspension',
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPERATORS = new Set(['in', 'notIn', 'not', 'lt', 'lte', 'gt', 'gte', 'equals', 'path']);

export function createFakeDb() {
  let tables: Record<string, Row[]> = Object.fromEntries(MODELS.map((model) => [model, []]));
  const nextId: Record<string, number> = Object.fromEntries(MODELS.map((model) => [model, 1000]));

  /** Users either side of a block, as the primary-read block check sees them. */
  const blocks = new Set<string>();

  const related = (model: string, row: Row, name: string) => {
    const relation = RELATIONS[model]?.[name];
    if (!relation) throw new Error(`fake db: ${model} has no relation ${name}`);
    const matches = tables[relation.model].filter(
      (other) => row[relation.from] != null && same(other[relation.to], row[relation.from])
    );
    return { relation, matches };
  };

  const matchesField = (value: unknown, condition: unknown): boolean => {
    if (!isPlainObject(condition)) return same(value, condition);
    for (const op of Object.keys(condition))
      if (!OPERATORS.has(op)) throw new Error(`fake db: unsupported operator ${op}`);
    if ('path' in condition) {
      const path = condition.path as string[];
      let cursor: unknown = value;
      for (const key of path) cursor = isPlainObject(cursor) ? cursor[key] : undefined;
      return same(cursor, condition.equals);
    }
    if ('equals' in condition && !same(value, condition.equals)) return false;
    if ('in' in condition && !(condition.in as unknown[]).some((v) => same(v, value))) return false;
    if ('notIn' in condition && (condition.notIn as unknown[]).some((v) => same(v, value)))
      return false;
    if ('not' in condition) {
      const not = condition.not;
      if (isPlainObject(not)) {
        if (matchesField(value, not)) return false;
      } else if (same(value, not)) return false;
    }
    // NULL compared with anything is unknown in Postgres, so the row is excluded.
    const ranged = ['lt', 'lte', 'gt', 'gte'].some((op) => op in condition);
    if (ranged && value == null) return false;
    const cmp = value as number | Date;
    if ('lt' in condition && !(cmp < (condition.lt as typeof cmp))) return false;
    if ('lte' in condition && !(cmp <= (condition.lte as typeof cmp))) return false;
    if ('gt' in condition && !(cmp > (condition.gt as typeof cmp))) return false;
    if ('gte' in condition && !(cmp >= (condition.gte as typeof cmp))) return false;
    return true;
  };

  const matches = (model: string, row: Row, where: Where | undefined): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) return true;
      if (key === 'OR') return (condition as Where[]).some((w) => matches(model, row, w));
      if (key === 'AND') return (condition as Where[]).every((w) => matches(model, row, w));
      if (key === 'NOT') return !matches(model, row, condition as Where);
      if (COMPOUND_KEYS[key])
        return COMPOUND_KEYS[key].every((column) => same(row[column], (condition as Row)[column]));
      if (RELATIONS[model]?.[key]) {
        const { relation, matches: others } = related(model, row, key);
        if (relation.kind !== 'one') throw new Error(`fake db: to-many filter on ${key}`);
        if (condition === null) return others.length === 0;
        return others.some((other) => matches(relation.model, other, condition as Where));
      }
      return matchesField(row[key], condition);
    });
  };

  const order = (rows: Row[], orderBy: unknown) => {
    if (!orderBy) return rows;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) =>
      Object.entries(o as Record<string, 'asc' | 'desc'>)
    );
    return [...rows].sort((a, b) => {
      for (const [key, dir] of keys) {
        const x = a[key] as number | Date;
        const y = b[key] as number | Date;
        if (x < y) return dir === 'asc' ? -1 : 1;
        if (x > y) return dir === 'asc' ? 1 : -1;
      }
      return 0;
    });
  };

  const project = (model: string, row: Row, select?: Record<string, unknown>): Row => {
    if (!select) return structuredClone(row);
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (!spec) continue;
      if (key === '_count') {
        const counts: Row = {};
        for (const [relationKey, on] of Object.entries((spec as { select: Row }).select)) {
          if (!on) continue;
          if (RELATIONS[model]?.[relationKey]?.kind !== 'many')
            throw new Error(`fake db: ${model} has no list relation ${relationKey} to count`);
          counts[relationKey] = related(model, row, relationKey).matches.length;
        }
        out[key] = counts;
      } else if (RELATIONS[model]?.[key]) {
        const { relation, matches: others } = related(model, row, key);
        const nested = (spec === true ? {} : spec) as {
          select?: Record<string, unknown>;
          where?: Where;
          orderBy?: unknown;
          take?: number;
        };
        if (relation.kind === 'one') {
          out[key] = others[0] ? project(relation.model, others[0], nested.select) : null;
        } else {
          let list = others.filter((other) => matches(relation.model, other, nested.where));
          list = order(list, nested.orderBy);
          if (nested.take != null) list = list.slice(0, nested.take);
          out[key] = list.map((other) => project(relation.model, other, nested.select));
        }
      } else {
        if (!(key in row)) throw new Error(`fake db: ${model} row has no column ${key}`);
        out[key] = structuredClone(row[key]);
      }
    }
    return out;
  };

  const assertUnique = (model: string, row: Row, ignore?: Row) => {
    for (const { columns, where } of UNIQUES[model] ?? []) {
      if (columns.some((column) => row[column] == null)) continue;
      if (where && !where(row)) continue;
      const clash = tables[model].find(
        (other) =>
          other !== ignore &&
          (!where || where(other)) &&
          columns.every((column) => same(other[column], row[column]))
      );
      if (clash)
        throw new Prisma.PrismaClientKnownRequestError(
          `Unique constraint failed on the fields: (${columns.join(',')})`,
          { code: 'P2002', clientVersion: 'fake' }
        );
    }
  };

  const applyData = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && 'increment' in value)
        row[key] = (row[key] as number) + (value.increment as number);
      else row[key] = structuredClone(value);
    }
  };

  /** The edge table's CHECK and composite foreign keys: both ends in the edge's own storyline. */
  const assertEdge = (row: Row) => {
    if (same(row.chapterId, row.parentChapterId))
      throw new Error('fake db: StorylineChapterEdge_not_self_check violated');
    for (const end of ['chapterId', 'parentChapterId']) {
      const chapter = tables.storylineChapter.find((c) => same(c.id, row[end]));
      if (!chapter || !same(chapter.storylineId, row.storylineId))
        throw new Error(`fake db: StorylineChapterEdge ${end} is not a chapter of its storyline`);
    }
  };

  /**
   * Row locks and a writer that has to wait for them. `FOR SHARE` on a chapter holds it until the
   * transaction ends, and a removal arriving meanwhile (`concurrentRemoval`) is applied when it
   * does, as Postgres would: its UPDATE waits for the lock. Edges written while an end was
   * already removed are kept in `edgesOnRemoved`, which is what the lock is there to prevent.
   */
  const shareLocked = new Set<number>();
  const deferredRemovals: number[] = [];
  const beforeEdgeCreate: (() => void)[] = [];
  const edgesOnRemoved: { chapterId: number; parentChapterId: number }[] = [];
  const removeNow = (id: number) => {
    const found = tables.storylineChapter.find((c) => same(c.id, id));
    if (found && found.removedAt == null) found.removedAt = new Date();
  };
  const endTransaction = () => {
    shareLocked.clear();
    for (const id of deferredRemovals.splice(0)) removeNow(id);
  };

  const insert = (model: string, data: Row) => {
    const row: Row = { ...(DEFAULTS[model]?.() ?? {}), ...structuredClone(data) };
    if (row.id == null && !['storylineChapterEdge', 'storylinePendingChapter'].includes(model))
      row.id = nextId[model]++;
    if (model === 'storylineChapterEdge') {
      beforeEdgeCreate.splice(0).forEach((fn) => fn());
      assertEdge(row);
      if (
        [row.chapterId, row.parentChapterId].some(
          (id) => tables.storylineChapter.find((c) => same(c.id, id))?.removedAt != null
        )
      )
        edgesOnRemoved.push({
          chapterId: row.chapterId as number,
          parentChapterId: row.parentChapterId as number,
        });
    }
    assertUnique(model, row);
    tables[model].push(row);
    return row;
  };

  const findAll = (model: string, args: { where?: Where; orderBy?: unknown; take?: number }) => {
    let rows = order(
      tables[model].filter((row) => matches(model, row, args.where)),
      args.orderBy
    );
    if (args.take != null) rows = rows.slice(0, args.take);
    return rows;
  };

  const delegate = (model: string) => ({
    findUnique: async (args: { where: Where; select?: Record<string, unknown> }) => {
      const row = tables[model].find((r) => matches(model, r, args.where));
      return row ? project(model, row, args.select) : null;
    },
    findFirst: async (args: {
      where?: Where;
      select?: Record<string, unknown>;
      orderBy?: unknown;
    }) => {
      const [row] = findAll(model, { ...args, take: 1 });
      return row ? project(model, row, args.select) : null;
    },
    findMany: async (
      args: {
        where?: Where;
        select?: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
      } = {}
    ) => findAll(model, args).map((row) => project(model, row, args.select)),
    count: async (args: { where?: Where } = {}) =>
      tables[model].filter((row) => matches(model, row, args.where)).length,
    create: async (args: { data: Row; select?: Record<string, unknown> }) =>
      project(model, insert(model, args.data), args.select),
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const data of args.data) {
        try {
          insert(model, data);
          count++;
        } catch (error) {
          if (!(args.skipDuplicates && error instanceof Prisma.PrismaClientKnownRequestError))
            throw error;
        }
      }
      return { count };
    },
    update: async (args: { where: Where; data: Row; select?: Record<string, unknown> }) => {
      const row = tables[model].find((r) => matches(model, r, args.where));
      if (!row)
        throw new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'fake',
        });
      const next = { ...row };
      applyData(next, args.data);
      assertUnique(model, next, row);
      Object.assign(row, next);
      return project(model, row, args.select);
    },
    updateMany: async (args: { where?: Where; data: Row }) => {
      const rows = tables[model].filter((row) => matches(model, row, args.where));
      for (const row of rows) applyData(row, args.data);
      return { count: rows.length };
    },
    delete: async (args: { where: Where }) => {
      const index = tables[model].findIndex((r) => matches(model, r, args.where));
      if (index < 0)
        throw new Prisma.PrismaClientKnownRequestError('Record to delete does not exist', {
          code: 'P2025',
          clientVersion: 'fake',
        });
      const [row] = tables[model].splice(index, 1);
      return structuredClone(row);
    },
    deleteMany: async (args: { where?: Where } = {}) => {
      const before = tables[model].length;
      tables[model] = tables[model].filter((row) => !matches(model, row, args.where));
      return { count: before - tables[model].length };
    },
    upsert: async (args: { where: Where; create: Row; update: Row }) => {
      const row = tables[model].find((r) => matches(model, r, args.where));
      if (row) {
        applyData(row, args.update);
        return structuredClone(row);
      }
      return structuredClone(insert(model, args.create));
    },
  });

  const queryRaw = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    const text = sql.text;
    const v = sql.values;
    if (text.includes('"UserEngagement"') && text.includes("'Block'")) {
      // Either side's block counts. Answered from the statement's own two clauses,
      // so a query that drops one direction is caught rather than answered.
      const compact = text.replace(/\s+/g, ' ');
      const clauses =
        compact.includes('("userId" = $1 AND "targetUserId" = $2)') &&
        compact.includes('("userId" = $3 AND "targetUserId" = $4)');
      const [a, b, c, d] = v as number[];
      if (!clauses || a !== d || b !== c)
        throw new Error(`fake db: block check is not two-way: ${compact} [${v.join(',')}]`);
      return [{ exists: blocks.has(`${a}:${b}`) || blocks.has(`${c}:${d}`) }];
    }
    if (text.includes("'scores'")) return [{ score: 0 }];
    if (text.includes('FROM "StorylinePendingChapter"') && text.includes('WHERE "postId" =')) {
      // The link a promotion reads, which it must lock: two writers then take turns on it.
      // Modelled only while the statement locks, so one that drops the lock is refused.
      if (!/FOR UPDATE\s*$/.test(text.trim()))
        throw new Error(`fake db: pending-chapter read is not locked: ${text}`);
      const [postId] = v as [number];
      return tables.storylinePendingChapter
        .filter((row) => same(row.postId, postId))
        .map(({ storylineId, parentChapterId, userId }) => ({
          storylineId,
          parentChapterId,
          userId,
        }));
    }
    // Storyline images (first images, chosen covers): this loop seeds no images, and which
    // images a reader may see is storyline.service.test's subject, not this one's.
    if (text.includes('FROM "Image" i') && text.includes('JOIN "StorylineChapter" c')) return [];
    if (text.includes('FOR NO KEY UPDATE')) return [];
    if (text.includes('FROM "Storyline"') && /FOR SHARE( OF st)?$/.test(text.trim())) return [];
    if (text.includes('FROM "StorylineChapter"') && text.includes('FOR SHARE')) {
      // The live chapters among the ids asked for, locked until the transaction ends. Modelled only
      // while the statement carries both its filters, so one that drops either is refused.
      const compact = text.replace(/\s+/g, ' ');
      if (!compact.includes('WHERE id = ANY(') || !compact.includes('"removedAt" IS NULL'))
        throw new Error(`fake db: chapter lock is not a live-chapter read: ${compact}`);
      const [ids] = v as [number[]];
      const live = tables.storylineChapter.filter(
        (c) => ids.includes(c.id as number) && c.removedAt == null
      );
      for (const c of live) shareLocked.add(c.id as number);
      return live.map((c) => ({ id: c.id }));
    }
    if (text.includes('FROM "Placement" pl') && text.includes('JOIN "Post" p')) {
      if (text.includes('pl."createdAt" >')) throw new Error('fake db: queue keyset not modelled');
      const [surface, targetType, ownerId, limit] = v as [string, string, number, number];
      // Modelled only while the statement carries the clause, so dropping it is caught here.
      const needsLiveParent = text
        .replace(/\s+/g, ' ')
        .includes(
          'AND EXISTS ( SELECT 1 FROM "StorylineChapter" sc WHERE sc."postId" = pl."targetId" AND sc."removedAt" IS NULL )'
        );
      const rows = tables.placement.filter((pl) => {
        const data = pl.data as Row | null;
        const post = tables.post.find((p) => same(p.id, data?.postId));
        const parent = tables.storylineChapter.find((c) => same(c.postId, pl.targetId));
        return (
          !!post &&
          !(needsLiveParent && (!parent || parent.removedAt != null)) &&
          pl.surface === surface &&
          pl.targetType === targetType &&
          pl.ownerId === ownerId &&
          pl.status === 'pending' &&
          data?.awaitingReadiness == null &&
          !post.tosViolation
        );
      });
      return order(rows, [{ createdAt: 'asc' }, { id: 'asc' }])
        .slice(0, limit)
        .map((pl) => ({ id: pl.id, createdAt: pl.createdAt }));
    }
    if (
      text.includes('sc."postId" = pl."targetId" AND sc."removedAt" IS NULL') &&
      text.includes('pl.amount = 0 OR')
    ) {
      // Orphaned continuations: pending, whose target no live chapter holds, fully paid or
      // free; optionally only those continuing chapters these placements added. Every clause
      // is required by its text, so a statement that drops one is refused rather than answered.
      const compact = text.replace(/\s+/g, ' ');
      const clauses = [
        `WHERE pl.surface = $1 AND pl."targetType" = $2 AND pl.status = 'pending'`,
        `AND NOT EXISTS ( SELECT 1 FROM "StorylineChapter" sc WHERE sc."postId" = pl."targetId" AND sc."removedAt" IS NULL )`,
        `AND (pl.amount = 0 OR ( SELECT COALESCE(SUM(t.amount), 0) FROM "PlacementTransaction" t WHERE t."placementId" = pl.id AND t.kind IN ($3,$4) AND t."transactionId" IS NOT NULL ) >= pl.amount)`,
        'ORDER BY pl.id ASC LIMIT',
      ];
      const missing = clauses.filter((clause) => !compact.includes(clause));
      if (missing.length)
        throw new Error(`fake db: orphan selection lacks ${missing.join(' | ')}: ${compact}`);
      const filtered = compact.includes(
        'AND pl."targetId" IN ( SELECT "postId" FROM "StorylineChapter" WHERE "placementId" IN ('
      );
      const [surface, targetType, holdFee, holdPrincipal, ...rest] = v as [
        string,
        string,
        string,
        string,
        ...number[]
      ];
      const placementIds = filtered ? rest.slice(0, -1) : null;
      const limit = rest[rest.length - 1];
      const receipted = (placementId: unknown) =>
        tables.placementTransaction
          .filter(
            (t) =>
              same(t.placementId, placementId) &&
              (t.kind === holdFee || t.kind === holdPrincipal) &&
              t.transactionId != null
          )
          .reduce((sum, t) => sum + (t.amount as number), 0);
      const rows = tables.placement.filter((pl) => {
        const live = tables.storylineChapter.some(
          (c) => same(c.postId, pl.targetId) && c.removedAt == null
        );
        const taken = tables.storylineChapter.filter(
          (c) => c.postId != null && placementIds?.some((id) => same(id, c.placementId))
        );
        return (
          pl.surface === surface &&
          pl.targetType === targetType &&
          pl.status === 'pending' &&
          !live &&
          ((pl.amount as number) === 0 || receipted(pl.id) >= (pl.amount as number)) &&
          (!placementIds || taken.some((c) => same(c.postId, pl.targetId)))
        );
      });
      return order(rows, [{ id: 'asc' }])
        .slice(0, limit)
        .map((pl) => ({ id: pl.id, amount: pl.amount }));
    }
    throw new Error(`fake db: raw statement not modelled: ${text.slice(0, 120)}`);
  };

  const executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Prisma.sql(strings, ...values).text;
    // Prisma binds a JS number as int8, which pg_advisory_xact_lock(int, int) does not accept.
    if (text.includes('pg_advisory_xact_lock')) {
      if (!/pg_advisory_xact_lock\(\$1::int, \$2::int\)/.test(text))
        throw new Error(`fake db: advisory lock arguments are not cast to int: ${text}`);
      return 0;
    }
    throw new Error(`fake db: raw statement not modelled: ${text.slice(0, 120)}`);
  };
  const executeRawUnsafe = async (text: string) => {
    if (text.startsWith('SET LOCAL lock_timeout')) return 0;
    throw new Error(`fake db: raw statement not modelled: ${text}`);
  };

  const install = () => {
    for (const client of [dbMock.dbWrite, dbMock.dbRead]) {
      for (const model of MODELS) {
        const methods = delegate(model);
        for (const [name, fn] of Object.entries(methods))
          (
            client[model][name] as unknown as { mockImplementation: (f: unknown) => void }
          ).mockImplementation(fn);
      }
      client.$queryRaw.mockImplementation(queryRaw);
      client.$executeRaw.mockImplementation(executeRaw);
      client.$executeRawUnsafe.mockImplementation(executeRawUnsafe);
    }
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) => {
      if (typeof fn !== 'function') throw new Error('fake db: only interactive transactions');
      const snapshot = structuredClone(tables);
      const ids = { ...nextId };
      try {
        return await (fn as (tx: unknown) => unknown)(dbMock.dbWrite);
      } catch (error) {
        tables = snapshot;
        Object.assign(nextId, ids);
        throw error;
      } finally {
        endTransaction();
      }
    });
  };

  return {
    install,
    insert,
    rows: (model: (typeof MODELS)[number]) => structuredClone(tables[model]),
    row: (model: (typeof MODELS)[number], where: Where) => {
      const found = tables[model].find((r) => matches(model, r, where));
      return found ? structuredClone(found) : undefined;
    },
    update: (model: (typeof MODELS)[number], where: Where, data: Row) => {
      const found = tables[model].filter((r) => matches(model, r, where));
      if (found.length !== 1)
        throw new Error(`fake db: expected one ${model} row, got ${found.length}`);
      applyData(found[0], data);
    },
    block: (a: number, b: number) => blocks.add(`${a}:${b}`),
    /**
     * A removal that commits just before the next edge is written, as one landing between a
     * link's checks and its insert would. Waits for the lock when the link holds one.
     */
    removeBeforeNextEdge: (id: number) =>
      beforeEdgeCreate.push(() =>
        shareLocked.has(id) ? deferredRemovals.push(id) : removeNow(id)
      ),
    edgesOnRemoved: () => structuredClone(edgesOnRemoved),
    isShareLocked: (id: number) => shareLocked.has(id),
  };
}

export type FakeDb = ReturnType<typeof createFakeDb>;
