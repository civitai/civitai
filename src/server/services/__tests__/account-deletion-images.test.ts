import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { blockedForNamesCsam } from '@civitai/shared/csam-blocked-for';

const { mockResetNsfwLevel, mockDropDeleteQueue, mockQueueSearchIndex, mockBustCachesForPosts } =
  vi.hoisted(() => ({
    mockResetNsfwLevel: vi.fn(async () => undefined),
    mockDropDeleteQueue: vi.fn(async () => undefined),
    mockQueueSearchIndex: vi.fn(async () => undefined),
    mockBustCachesForPosts: vi.fn(async () => undefined),
  }));

vi.mock('~/server/services/image.service', () => ({
  resetBlockedNsfwLevel: mockResetNsfwLevel,
  refreshImageLevelCaches: vi.fn(async () => undefined),
  dropBlockedImageDeleteQueue: mockDropDeleteQueue,
  queueImageSearchIndexUpdate: mockQueueSearchIndex,
}));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: mockBustCachesForPosts }));
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  countPendingAccountDeletionImageRestores,
  disarmAccountDeletionImagePurge,
  recordPendingImageRestore,
  releaseAccountDeletionPendingDeletes,
  unblockAccountDeletionImages,
  MAX_RESTORE_BATCHES,
  RESTORE_BATCH_SIZE,
} from '~/server/services/account-deletion-images';
import {
  PRIOR_BLOCKED_FOR_KEY,
  PRIOR_INGESTION_KEY,
  PRIOR_NEEDS_REVIEW_KEY,
} from '~/server/utils/image-removal-mode';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { moderatorWithheldSql } from '@civitai/shared/retracted-media-tier';
const mockLogToAxiom = loggingMock.logToAxiom;
const mockSysRedis = redisMock.sysRedis;
const mockDbWrite = dbMock.dbWrite;

/**
 * A tiny in-memory Postgres for the reversal. The statements are interpreted rather than
 * pattern-matched: the scope predicate, the batch bound and every `SET` expression are read out of
 * the SQL and evaluated against the fixture, so a reversal that keys off `blockedFor` (which a
 * moderator block also writes), that claims the gallery unbounded, or that flattens the restored
 * state hands back the wrong rows here. The enum cast is modelled the way Postgres runs it — a
 * value outside `ImageIngestionStatus` aborts the whole statement — so a reversal that lets a
 * malformed breadcrumb into its claim loses the batch rather than the row.
 */
const WITHHELD_SQL = moderatorWithheldSql('i', { csamReview: false });
const WITHHELD = '__withheld__';

type ImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  ingestion: string;
  blockedFor: string | null;
  needsReview?: string | null;
  metadata: Record<string, string>;
  /** Fiction: a row the claim matches but the UPDATE never moves off `Blocked`. */
  stuck?: boolean;
  /** Withheld from a moderator without the CSAM grant; what that means is pinned on Postgres. */
  withheld?: boolean;
};

type QueueRow = { entityId: number; entityType: string; type: string };

const INGESTION_STATUSES: string[] = Object.values(ImageIngestionStatus);

let images: ImageRow[] = [];
let queue: QueueRow[] = [];
/** Rows handed back per reversal pass, terminating empty pass included. */
let claimedPerPass: number[] = [];
/** The owner is neither deleted nor banned. */
let ownerLive = true;

function splitTopLevel(body: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

const METADATA_LOOKUP = /^\(?"metadata"->>\?::text\)?(::"\w+")?$/;
const METADATA_MINUS = /^"metadata"(\s*-\s*\?::text)+$/;
const SCOPED_ON_BREADCRUMB = /"metadata"->>\?::text IS NOT NULL/;
const CLAIM_START =
  /FROM \(\s*SELECT i\.id, i\."needsReview" AS "currentReview",[\s\S]*?AS "recordedReview"[\s\S]*?\s+FROM "Image" i\s+WHERE\s/;
// Bounded, and locking what it claims: see account-deletion-restore-race.pg.test.ts.
const BOUNDED_CLAIM = /^LIMIT \?\s*FOR UPDATE OF i\s*\)\s*c\s+WHERE "Image"\.id = c\.id\s*$/;
const OWNER_CHECK = /^\s*\(SELECT [^()]*\([^()]*\)[^()]* FROM "User" u WHERE u\.id = \?\)\s*$/;
const ENUM_RANGE = /\(SELECT unnest\(enum_range\(NULL::"ImageIngestionStatus"\)\)::text\)/;

const COALESCE_EXPR = /^COALESCE\(("\w+"),\s*([\s\S]+)\)$/;
// `csamInBlockedForSql`, read here with its JS twin.
const CSAM_IN_EXPR =
  /^EXISTS \(\s*SELECT 1 FROM unnest\(string_to_array\(([\s\S]+?), ','\)\) AS mw_reason\(value\)\s*WHERE lower\(btrim\(mw_reason\.value\)\) = 'csam'\s*\)$/;
const CASE_EXPR = /^CASE\s+WHEN\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END$/;
const takeKeys = (part: string, keys: string[]) => keys.splice(0, (part.match(/\?/g) ?? []).length);

/** One SET value: a breadcrumb lookup, `"blockedFor"`, a Blocked literal, or a CASE over those.
 *  `keys` holds the expression's parameters in text order and is consumed. */
function evalValue(expr: string, keys: string[], row: ImageRow): string | null {
  const caseExpr = expr.match(CASE_EXPR);
  if (caseExpr) {
    const [, cond, then, otherwise] = caseExpr;
    const condKeys = takeKeys(cond, keys);
    // Every conjunct is evaluated (none short-circuits), so each consumes its own parameters.
    const conjunct = (clause: string) => {
      const csamIn = clause.match(CSAM_IN_EXPR);
      if (csamIn) {
        const operand = csamIn[1].trim().replace(/^\(([\s\S]*)\)$/, '$1');
        return blockedForNamesCsam(evalValue(operand, takeKeys(operand, condKeys), row));
      }
      const anyOf = clause.match(/^([\s\S]+?)\s*=\s*ANY\(\?::text\[\]\)$/);
      if (anyOf) {
        const operandKeys = takeKeys(anyOf[1], condKeys);
        const allowed = condKeys.shift() as unknown as string[];
        return allowed.includes(evalValue(anyOf[1].trim(), operandKeys, row) as string);
      }
      const isLiteral = clause.match(/^([\s\S]+?)\s*=\s*'(\w+)'$/);
      if (isLiteral)
        return (
          evalValue(isLiteral[1].trim(), takeKeys(isLiteral[1], condKeys), row) === isLiteral[2]
        );
      const notLiteral = clause.match(/^([\s\S]+?)\s*<>\s*'(\w+)'$/);
      if (notLiteral) {
        const value = evalValue(notLiteral[1].trim(), takeKeys(notLiteral[1], condKeys), row);
        return value !== null && value !== notLiteral[2];
      }
      const [operand, compared] = clause.split(/\s*=\s*\?\s*$/);
      if (compared !== '') throw new Error(`unhandled CASE condition: ${clause}`);
      const operandKeys = takeKeys(operand, condKeys);
      return evalValue(operand.trim(), operandKeys, row) === condKeys.shift();
    };
    const holds = cond
      .split(/\s+OR\s+/)
      .map((clause) => clause.split(/\s+AND\s+/).map(conjunct))
      .some((results) => results.every(Boolean));
    const thenKeys = takeKeys(then, keys);
    const elseKeys = takeKeys(otherwise, keys);
    return holds ? evalValue(then, thenKeys, row) : evalValue(otherwise, elseKeys, row);
  }
  const coalesce = expr.match(COALESCE_EXPR);
  if (coalesce) return evalValue(coalesce[1], [], row) ?? evalValue(coalesce[2], keys, row);
  const lookup = expr.match(METADATA_LOOKUP);
  if (lookup) {
    const value = row.metadata[keys[0]] ?? null;
    if (lookup[1] === '::"ImageIngestionStatus"' && !INGESTION_STATUSES.includes(value!))
      throw new Error(`invalid input value for enum ImageIngestionStatus: "${value}"`);
    return value;
  }
  if (expr === '"blockedFor"') return row.blockedFor;
  if (expr === '"needsReview"') return row.needsReview ?? null;
  if (expr === 'NULL') return null;
  if (expr === `'Blocked'::"ImageIngestionStatus"`) return 'Blocked';
  throw new Error(`unhandled assignment: ${expr}`);
}

function applyRestoreUpdate(rawSql: string, values: unknown[]) {
  const sql = rawSql.replace(/--[^\n]*/g, '');
  const params = [...values];
  // The whole gallery reaching Node in one statement is the failure this batching exists to
  // prevent, so a claim without its own bound is rejected rather than run.
  const claimAt = sql.search(CLAIM_START);
  if (claimAt < 0) throw new Error(`the reversal must claim rows by id: ${sql}`);
  const assignments = splitTopLevel(sql.slice(sql.indexOf('SET ') + 4, claimAt)).map(
    (assignment) => {
      const split = assignment.indexOf('=');
      const expr = assignment.slice(split + 1).trim();
      return {
        column: assignment.slice(0, split).trim().replace(/"/g, ''),
        expr,
        keys: (expr.match(/\?/g) ?? []).map(() => params.shift() as string),
      };
    }
  );

  const claim = sql.slice(claimAt, sql.indexOf('RETURNING'));
  const innerWhereAt = claim.indexOf('WHERE', claim.indexOf('FROM "Image" i'));
  // Which recorded review counts (a decided appeal's does not) is pinned on Postgres too.
  const recordedReviewKey = params.splice(
    0,
    (claim.slice(0, innerWhereAt).match(/\?/g) ?? []).length
  )[0] as string;
  const limitAt = claim.lastIndexOf('LIMIT');
  if (limitAt < innerWhereAt || !BOUNDED_CLAIM.test(claim.slice(limitAt).trim()))
    throw new Error(`the claim must be bounded by a LIMIT: ${claim}`);

  const where = claim.slice(innerWhereAt + 5, limitAt);
  if (!SCOPED_ON_BREADCRUMB.test(where))
    throw new Error(`the reversal must scope on the block's own breadcrumb: ${where}`);

  // Every predicate is applied, and one this does not recognise is rejected rather than assumed,
  // so a reversal that widens its scope cannot pass by relying on the harness to narrow it back.
  const predicates = where.split(/\s+AND\s+/).map((clause) => {
    const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
    if (/^\s*i\."userId" = \?/.test(clause)) return (row: ImageRow) => row.userId === args[0];
    if (/^\s*i\.ingestion = 'Blocked'/.test(clause))
      return (row: ImageRow) => row.ingestion === 'Blocked';
    if (/^\s*i\."metadata"->>\?::text IS NOT NULL/.test(clause))
      return (row: ImageRow) => row.metadata[args[0] as string] != null;
    if (/^\s*i\."metadata"->>\?::text IN /.test(clause) && ENUM_RANGE.test(clause))
      return (row: ImageRow) => INGESTION_STATUSES.includes(row.metadata[args[0] as string]);
    // What the owner check means is pinned against Postgres below; here it only gates the claim.
    if (OWNER_CHECK.test(clause)) return (row: ImageRow) => row.userId === args[0] && ownerLive;
    if (clause.trim() === `NOT ${WITHHELD}`) return (row: ImageRow) => !row.withheld;
    throw new Error(`unrecognized reversal predicate: ${clause.trim()}`);
  });

  const limit = params.shift() as number;
  const claimed = images.filter((row) => predicates.every((holds) => holds(row))).slice(0, limit);

  // Staged before anything is written: a statement that trips the enum cast leaves no row behind.
  const staged = claimed.map((row) => {
    const next: Partial<ImageRow> = {};
    for (const { column, expr, keys } of assignments) {
      // Which review flag survives, and the rating put back, are pinned on Postgres, in
      // scan-outcome-csam-block.behavior.test.ts.
      if (column === 'needsReview' || column === 'nsfwLevel' || column === 'nsfwLevelLocked')
        continue;
      if (METADATA_MINUS.test(expr)) {
        const metadata = { ...row.metadata };
        for (const key of keys) delete metadata[key];
        next.metadata = metadata;
      } else next[column as 'ingestion'] = evalValue(expr, [...keys], row)!;
    }
    return { row, next, recordedReview: row.metadata[recordedReviewKey] ?? null };
  });
  for (const { row, next } of staged) if (!row.stuck) Object.assign(row, next);

  claimedPerPass.push(claimed.length);
  return staged.map(({ row, recordedReview }) => ({
    id: row.id,
    postId: row.postId,
    ingestion: row.ingestion,
    blockedFor: row.blockedFor,
    needsReview: row.needsReview ?? null,
    currentReview: row.needsReview ?? null,
    recordedReview,
    recordedLevel: null,
  }));
}

/**
 * Same discipline for the counts — the reversal's own skipped-row audit and the pending count
 * `restoreUser` reports: predicates are read out, not assumed, so a count that widens or narrows
 * its scope answers off a different set of rows here.
 */
function countMatchingImages(sql: string, values: unknown[]) {
  const params = [...values];
  const predicates = sql
    .slice(sql.indexOf('WHERE') + 5)
    .split(/\s+AND\s+/)
    .map((clause) => {
      const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
      if (clause.trim() === WITHHELD) return (row: ImageRow) => !!row.withheld;
      clause = clause.replace(/^(\s*)i\./, '$1');
      if (/^\s*"userId" = \?/.test(clause)) return (row: ImageRow) => row.userId === args[0];
      if (/^\s*ingestion = 'Blocked'/.test(clause))
        return (row: ImageRow) => row.ingestion === 'Blocked';
      if (/^\s*"metadata"->>\?::text IS NOT NULL/.test(clause))
        return (row: ImageRow) => row.metadata[args[0] as string] != null;
      if (/^\s*"metadata"->>\?::text NOT IN /.test(clause) && ENUM_RANGE.test(clause))
        return (row: ImageRow) => !INGESTION_STATUSES.includes(row.metadata[args[0] as string]);
      throw new Error(`unrecognized image-count predicate: ${clause.trim()}`);
    });

  return [{ count: images.filter((row) => predicates.every((holds) => holds(row))).length }];
}

/**
 * Every predicate of the queue delete is read out of the statement and applied; one this does not
 * recognise is rejected rather than assumed, so a delete that widens its scope cannot pass by
 * relying on the harness to narrow it back.
 */
function matchesQueueDelete(sql: string, values: unknown[], row: QueueRow) {
  const params = [...values];
  return sql
    .slice(sql.indexOf('WHERE') + 5)
    .split(/\s+AND\s+/)
    .every((clause) => {
      const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
      if (/^\s*type = \?/.test(clause)) return row.type === args[0];
      if (/^\s*"entityType" = \?/.test(clause)) return row.entityType === args[0];
      if (
        /^\s*"entityId" IN \(\s*SELECT i\.id FROM "Image" i\s+WHERE i\."userId" = \?\s*$/.test(
          clause
        )
      )
        return images.some((image) => image.userId === args[0] && image.id === row.entityId);
      // `->`, so a JSON-null breadcrumb counts as present.
      if (/^\s*\(i\."metadata" -> \?::text\) IS NOT NULL\s*\)\s*$/.test(clause))
        return images.some(
          (image) =>
            image.id === row.entityId && !!image.metadata && (args[0] as string) in image.metadata
        );
      throw new Error(`unrecognized JobQueue delete predicate: ${clause.trim()}`);
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  images = [];
  queue = [];
  claimedPerPass = [];
  ownerLive = true;
  mockSysRedis.sAdd.mockResolvedValue(1);

  mockDbWrite.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...raw: unknown[]) => {
    // Nested fragments flattened, as Prisma sends them.
    const { strings: flat, values } = Prisma.sql(strings, ...(raw as never[]));
    const sql = flat.join('?').replaceAll(WITHHELD_SQL, WITHHELD);
    if (sql.includes('UPDATE "Image"')) return Promise.resolve(applyRestoreUpdate(sql, values));
    if (sql.includes('SELECT COUNT(*)')) return Promise.resolve(countMatchingImages(sql, values));
    throw new Error(`unexpected read: ${sql}`);
  });

  mockDbWrite.$executeRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (!sql.includes('DELETE FROM "JobQueue"')) throw new Error(`unexpected write: ${sql}`);
      const before = queue.length;
      queue = queue.filter((row) => !matchesQueueDelete(sql, values, row));
      return Promise.resolve(before - queue.length);
    }
  );
});

const hidden = (id: number, priorIngestion: string, extra: Partial<ImageRow> = {}): ImageRow => ({
  id,
  userId: 7,
  postId: null,
  ingestion: 'Blocked',
  blockedFor: 'moderated',
  metadata: { [PRIOR_INGESTION_KEY]: priorIngestion },
  ...extra,
});

describe('unblockAccountDeletionImages', () => {
  it('leaves a moderator block in place while undoing the deletion block', async () => {
    images = [
      hidden(1, 'Scanned'),
      {
        id: 2,
        userId: 7,
        postId: null,
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        metadata: {},
      },
    ];

    const result = await unblockAccountDeletionImages(7);

    // `handleBlockImages` writes `blockedFor = 'moderated'` too, so anything scoped that way
    // would hand a restored account back content a moderator deliberately hid.
    expect(images[0]).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(images[1]).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(result.unblocked).toBe(1);
  });

  it('leaves a withheld image blocked, and counts it', async () => {
    images = [hidden(1, 'Scanned', { withheld: true }), hidden(2, 'Scanned')];

    const result = await unblockAccountDeletionImages(7);

    expect(images[0]).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
    expect(images[1]).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(result).toMatchObject({ unblocked: 1, withheld: 1 });
  });

  it('restores the ingestion the image actually had', async () => {
    images = [hidden(1, 'Pending')];

    await unblockAccountDeletionImages(7);

    // A flat `Scanned` would promote an image past a scan it never had.
    expect(images[0].ingestion).toBe('Pending');
  });

  it('puts back the block reason the grace pass overwrote', async () => {
    images = [
      hidden(1, 'Blocked', {
        blockedFor: 'moderated',
        metadata: {
          [PRIOR_INGESTION_KEY]: 'Blocked',
          [PRIOR_BLOCKED_FOR_KEY]: 'AiNotVerified',
        },
      }),
    ];

    const result = await unblockAccountDeletionImages(7);

    expect(images[0]).toMatchObject({ ingestion: 'Blocked', blockedFor: 'AiNotVerified' });
    expect(result.unblocked).toBe(0);
    expect(result.stillBlocked).toBe(1);
  });

  // Readers that gate on ingestion alone must see a CSAM row as Blocked too, so its prior
  // ingestion is not restored.
  it('puts back a CSAM reason and keeps that image Blocked', async () => {
    images = [
      hidden(1, 'Error', {
        metadata: { [PRIOR_INGESTION_KEY]: 'Error', [PRIOR_BLOCKED_FOR_KEY]: 'CSAM' },
      }),
      hidden(2, 'Scanned'),
    ];

    const result = await unblockAccountDeletionImages(7);

    expect(images[0]).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM', metadata: {} });
    // Control: the other image is restored and goes through the unhide follow-ups.
    expect(images[1]).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(mockResetNsfwLevel.mock.calls).toEqual([[[2], { unlockedOnly: true }]]);
    expect(result).toMatchObject({ unblocked: 1, stillBlocked: 1 });
  });

  it('keeps a CSAM block applied during the grace window over the older breadcrumb', async () => {
    images = [
      hidden(1, 'Scanned', {
        blockedFor: 'CSAM',
        metadata: { [PRIOR_INGESTION_KEY]: 'Scanned', [PRIOR_BLOCKED_FOR_KEY]: 'moderated' },
      }),
      hidden(2, 'Scanned', {
        metadata: { [PRIOR_INGESTION_KEY]: 'Scanned', [PRIOR_BLOCKED_FOR_KEY]: 'moderated' },
      }),
    ];

    const result = await unblockAccountDeletionImages(7);

    expect(images[0]).toMatchObject({ ingestion: 'Blocked', blockedFor: 'CSAM', metadata: {} });
    // Control: the same breadcrumb on a non-CSAM row is put back as written.
    expect(images[1]).toMatchObject({ ingestion: 'Scanned', blockedFor: 'moderated' });
    expect(result).toMatchObject({ unblocked: 1, stillBlocked: 1 });
  });

  it('clears the breadcrumbs so a later moderator block is not mistaken for this one', async () => {
    images = [
      hidden(1, 'Blocked', {
        metadata: {
          [PRIOR_INGESTION_KEY]: 'Blocked',
          [PRIOR_BLOCKED_FOR_KEY]: 'AiNotVerified',
          [PRIOR_NEEDS_REVIEW_KEY]: 'minor',
        },
      }),
    ];

    await unblockAccountDeletionImages(7);

    expect(images[0].metadata).toEqual({});
  });

  it('resets the blocked nsfwLevel only for images that came back visible', async () => {
    images = [
      hidden(1, 'Scanned'),
      hidden(2, 'Blocked', {
        metadata: {
          [PRIOR_INGESTION_KEY]: 'Blocked',
          [PRIOR_BLOCKED_FOR_KEY]: 'AiNotVerified',
        },
      }),
    ];

    await unblockAccountDeletionImages(7);

    // A still-blocked row has to keep its Blocked rating; only the rows the block hid get the
    // reset-and-recompute that undoes the forced level and the rating lock.
    expect(mockResetNsfwLevel).toHaveBeenCalledWith([1], { unlockedOnly: true });
    expect(mockQueueSearchIndex).toHaveBeenCalledWith({
      ids: [1],
      action: SearchIndexUpdateQueueAction.Update,
    });
  });

  it('disarms the blocked-image purge for the rows it restores', async () => {
    images = [hidden(1, 'Scanned')];

    await unblockAccountDeletionImages(7);

    // The grace block queued these for deletion. A leftover queue row carries the FIRST
    // block's timestamp, so a later re-delete would purge them with no retention at all.
    expect(mockDropDeleteQueue).toHaveBeenCalledWith([1]);
  });

  it('busts the caches of the posts that held the restored images', async () => {
    images = [hidden(1, 'Scanned', { postId: 900 }), hidden(2, 'Scanned', { postId: 900 })];

    await unblockAccountDeletionImages(7);

    expect(mockBustCachesForPosts).toHaveBeenCalledWith([900]);
  });

  it('leaves a row a moderator already unblocked at its current state', async () => {
    images = [hidden(1, 'Pending', { ingestion: 'Scanned', blockedFor: null })];

    const result = await unblockAccountDeletionImages(7);

    // The breadcrumb outlives a manual unblock, so acting on it alone would drag a moderator's
    // `Scanned` back to the pre-block `Pending`.
    expect(images[0]).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(result.unblocked).toBe(0);
  });

  it('does nothing when the account holds no deletion-blocked images', async () => {
    images = [
      { id: 1, userId: 7, postId: null, ingestion: 'Scanned', blockedFor: null, metadata: {} },
    ];

    const result = await unblockAccountDeletionImages(7);

    expect(result).toEqual({
      unblocked: 0,
      stillBlocked: 0,
      skipped: 0,
      withheld: 0,
      drained: true,
    });
    expect(mockResetNsfwLevel).not.toHaveBeenCalled();
    expect(mockBustCachesForPosts).not.toHaveBeenCalled();
  });

  it('walks the gallery in bounded passes instead of one unbounded statement', async () => {
    const total = RESTORE_BATCH_SIZE * 2 + 3;
    images = Array.from({ length: total }, (_, i) => hidden(i + 1, 'Scanned'));

    const result = await unblockAccountDeletionImages(7);

    // The largest account holds ~785K images; a single statement returns all of them to Node.
    expect(claimedPerPass).toEqual([RESTORE_BATCH_SIZE, RESTORE_BATCH_SIZE, 3, 0]);
    expect(result.unblocked).toBe(total);
    expect(images.every((row) => row.ingestion === 'Scanned')).toBe(true);
    for (const [ids] of mockResetNsfwLevel.mock.calls as unknown as number[][][])
      expect(ids.length).toBeLessThanOrEqual(RESTORE_BATCH_SIZE);
  });

  it('stops at the next pass once the owner is banned or deleted again', async () => {
    images = Array.from({ length: RESTORE_BATCH_SIZE + 3 }, (_, i) => hidden(i + 1, 'Scanned'));
    mockResetNsfwLevel.mockImplementationOnce(async () => {
      ownerLive = false;
    });

    const result = await unblockAccountDeletionImages(7);

    expect(claimedPerPass).toEqual([RESTORE_BATCH_SIZE, 0]);
    expect(result.unblocked).toBe(RESTORE_BATCH_SIZE);
    expect(images.filter((row) => row.ingestion === 'Blocked')).toHaveLength(3);
  });

  it('claims only for an owner that is neither deleted nor banned, in Postgres', async () => {
    await unblockAccountDeletionImages(7);
    const sql = (mockDbWrite.$queryRaw.mock.calls[0][0] as unknown as string[]).join('?');
    const where = sql.slice(
      sql.indexOf('WHERE', sql.indexOf('FROM "Image" i')) + 5,
      sql.lastIndexOf('LIMIT')
    );
    const check = where.split(/\s+AND\s+/).find((clause) => OWNER_CHECK.test(clause));
    expect(check, 'the claim carries no owner check').toBeDefined();

    const db = new PGlite();
    await db.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
      INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, now(), now());
    `);
    const live = async (id: number) =>
      (
        await db.query<{ live: boolean | null }>(`SELECT ${check!.replace('?', '$1')} AS live`, [
          id,
        ])
      ).rows[0].live === true;
    expect(await Promise.all([1, 2, 3, 4, 5].map(live))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    await db.close();
  });

  it('skips a row whose breadcrumb is not a real ingestion status and restores the rest', async () => {
    images = [hidden(1, 'Scanned'), hidden(2, 'Scannned'), hidden(3, 'Pending')];

    const result = await unblockAccountDeletionImages(7);

    // Claiming the malformed row would put `('Scannned')::"ImageIngestionStatus"` in the statement
    // and take rows 1 and 3 down with it.
    expect(images[0]).toMatchObject({ ingestion: 'Scanned', blockedFor: null });
    expect(images[2]).toMatchObject({ ingestion: 'Pending', blockedFor: null });
    expect(images[1]).toMatchObject({
      ingestion: 'Blocked',
      metadata: { [PRIOR_INGESTION_KEY]: 'Scannned' },
    });
    expect(result).toEqual({
      unblocked: 2,
      stillBlocked: 0,
      skipped: 1,
      withheld: 0,
      drained: true,
    });
    expect(mockResetNsfwLevel).toHaveBeenCalledWith([1, 3], { unlockedOnly: true });
  });

  it('stops instead of spinning when a claimed row comes back unchanged', async () => {
    images = [hidden(1, 'Scanned', { stuck: true })];

    const result = await unblockAccountDeletionImages(7);

    expect(claimedPerPass).toHaveLength(MAX_RESTORE_BATCHES);
    expect(result.unblocked).toBe(0);
    // `restore-user-images` drops the account off its worklist on this flag; reported as finished,
    // a reversal stopped at the ceiling is never resumed.
    expect(result.drained).toBe(false);
  });

  it('runs the nsfwLevel reset and the search-index queue of a pass concurrently', async () => {
    images = [hidden(1, 'Scanned')];
    let searchIndexQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      searchIndexQueued = resolve;
    });
    // Serial follow-up never reaches the queue call, so the reset never settles and this hangs.
    mockResetNsfwLevel.mockImplementationOnce(async () => {
      await queued;
    });
    mockQueueSearchIndex.mockImplementationOnce(async () => {
      searchIndexQueued();
    });

    const result = await unblockAccountDeletionImages(7);

    expect(result.unblocked).toBe(1);
    expect(mockQueueSearchIndex).toHaveBeenCalledTimes(1);
  });

  it('busts the post caches only after the pass has reset the levels', async () => {
    images = [hidden(1, 'Scanned', { postId: 900 })];
    const order: string[] = [];
    mockResetNsfwLevel.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('reset');
    });
    mockBustCachesForPosts.mockImplementationOnce(async () => {
      order.push('bust');
    });

    await unblockAccountDeletionImages(7);

    // A bust racing the reset lets a reader re-cache the Blocked level for the whole cache TTL.
    expect(order).toEqual(['reset', 'bust']);
  });
});

describe('countPendingAccountDeletionImageRestores', () => {
  it('counts the images this account is still waiting on', async () => {
    images = [
      hidden(1, 'Scanned'),
      hidden(2, 'Pending'),
      // Unblocked already, so no longer waiting on anything.
      hidden(3, 'Scanned', { ingestion: 'Scanned', blockedFor: null, metadata: {} }),
      // A moderator block, which the restore deliberately leaves alone.
      {
        id: 4,
        userId: 7,
        postId: null,
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        metadata: {},
      },
      { ...hidden(5, 'Scanned'), userId: 8 },
    ];

    expect(await countPendingAccountDeletionImageRestores(7)).toBe(2);
  });

  it('reports nothing pending for a deletion that blocked no images', async () => {
    images = [
      { id: 1, userId: 7, postId: null, ingestion: 'Scanned', blockedFor: null, metadata: {} },
    ];

    expect(await countPendingAccountDeletionImageRestores(7)).toBe(0);
  });
});

describe('recordPendingImageRestore', () => {
  it('names the account on the job worklist', async () => {
    expect(await recordPendingImageRestore(7)).toBe(true);
    expect(mockSysRedis.sAdd).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.SYSTEM.PENDING_IMAGE_RESTORES,
      '7'
    );
  });

  it('swallows a Redis failure rather than failing a restore that already committed', async () => {
    mockSysRedis.sAdd.mockRejectedValueOnce(new Error('sysRedis down'));

    // Thrown, this surfaces as a failed restore — and the retry is locked out by restoreUser's own
    // guard, because the account no longer reads as deleted.
    expect(await recordPendingImageRestore(7)).toBe(false);
    expect(mockLogToAxiom).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }));
  });
});

describe('disarmAccountDeletionImagePurge', () => {
  it('keeps the purge of a block written during the grace period, in Postgres', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
      CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete');
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, metadata jsonb);
      CREATE TABLE "JobQueue" (
        "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
        UNIQUE ("entityType", "entityId", type)
      );
      -- 1: still grace-blocked. 2: a JSON-null breadcrumb, still grace-blocked. 3: a block written
      -- during the grace period, which strips the breadcrumb. 4: no metadata. 5: another account.
      INSERT INTO "Image" VALUES
        (1, 7, '{"${PRIOR_INGESTION_KEY}": "Scanned", "keepMe": 1}'),
        (2, 7, '{"${PRIOR_INGESTION_KEY}": null}'),
        (3, 7, '{"keepMe": 3}'),
        (4, 7, NULL),
        (5, 8, '{"${PRIOR_INGESTION_KEY}": "Scanned"}');
      INSERT INTO "JobQueue" SELECT id, 'Image', 'BlockedImageDelete' FROM "Image";
    `);
    mockDbWrite.$executeRaw.mockImplementationOnce((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
    }) as never);

    await disarmAccountDeletionImagePurge(7);

    const { rows } = await db.query<{ entityId: number }>(
      `SELECT "entityId" FROM "JobQueue" ORDER BY "entityId"`
    );
    // Only the grace rows lose their purge; the block that outlives the restore keeps its own.
    expect(rows.map((r) => r.entityId)).toEqual([3, 4, 5]);
    await db.close();
  });

  it('drops the delete-queue rows for this account images only', async () => {
    images = [hidden(1, 'Scanned'), { ...hidden(2, 'Scanned'), userId: 8 }];
    queue = [
      { entityId: 1, entityType: 'Image', type: 'BlockedImageDelete' },
      { entityId: 2, entityType: 'Image', type: 'BlockedImageDelete' },
    ];

    const deleted = await disarmAccountDeletionImagePurge(7);

    expect(deleted).toBe(1);
    expect(queue).toEqual([{ entityId: 2, entityType: 'Image', type: 'BlockedImageDelete' }]);
  });

  it('leaves the account other queued work alone', async () => {
    images = [hidden(1, 'Scanned')];
    queue = [
      { entityId: 1, entityType: 'Image', type: 'BlockedImageDelete' },
      { entityId: 1, entityType: 'Image', type: 'ImageScan' },
      // `JobQueue` is keyed on (entityType, entityId, type): an id only identifies a row
      // together with its entity type, so an unscoped delete reaches into another table's queue.
      { entityId: 1, entityType: 'Post', type: 'BlockedImageDelete' },
    ];

    await disarmAccountDeletionImagePurge(7);

    expect(queue).toEqual([
      { entityId: 1, entityType: 'Image', type: 'ImageScan' },
      { entityId: 1, entityType: 'Post', type: 'BlockedImageDelete' },
    ]);
  });
});

describe('releaseAccountDeletionPendingDeletes', () => {
  it("takes the drain's ask off the account's pending deletes, keeping anyone else's", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
      CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete');
      CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, metadata jsonb);
      CREATE TABLE "JobQueue" (
        "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
        data jsonb, UNIQUE ("entityType", "entityId", type)
      );
      INSERT INTO "Image" VALUES (1, 7), (2, 7), (3, 7), (4, 8);
      INSERT INTO "Post" VALUES (10, 7);
      INSERT INTO "JobQueue" VALUES
        (1, 'Image', 'PendingDelete', '{"deletedBy": "remove-deleted-user-images"}'),
        (2, 'Image', 'PendingDelete', '{"ownerId": 7, "deletedBy": "remove-deleted-user-images"}'),
        (3, 'Image', 'PendingDelete', '{"deletedBy": "moderator:99", "moderatorDelete": true}'),
        (4, 'Image', 'PendingDelete', '{"deletedBy": "remove-deleted-user-images"}'),
        (10, 'Post', 'PendingDelete', '{"deletedBy": "remove-deleted-user-images"}');
    `);
    await db.exec(imageUseTablesSql);
    mockDbWrite.$queryRaw.mockImplementationOnce((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values as unknown[])).rows;
    }) as never);

    await releaseAccountDeletionPendingDeletes(7);

    const { rows } = await db.query<{ entityId: number; data: unknown }>(
      `SELECT "entityId", data FROM "JobQueue" ORDER BY "entityType", "entityId"`
    );
    // The drain's own go; the owner's ask stays; a moderator's and another account's are untouched.
    expect(rows).toEqual([
      { entityId: 2, data: { ownerId: 7 } },
      { entityId: 3, data: { deletedBy: 'moderator:99', moderatorDelete: true } },
      { entityId: 4, data: { deletedBy: 'remove-deleted-user-images' } },
    ]);
    await db.close();
  });

  it("keeps the drain's delete of what an open case keeps, so the restore cannot publish it", async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
      CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete');
      CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, metadata jsonb);
      CREATE TABLE "JobQueue" (
        "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
        data jsonb, UNIQUE ("entityType", "entityId", type)
      );
    `);
    await db.exec(imageUseTablesSql);
    await db.exec(`
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (1, 7, 'csam'), (2, 7, NULL);
      INSERT INTO "Post" VALUES (10, 7), (11, 7);
      INSERT INTO "Report" (id) VALUES (1); UPDATE "Report" SET reason = 'CSAM' WHERE id = 1;
      INSERT INTO "PostReport" VALUES (10, 1);
      INSERT INTO "JobQueue" SELECT e.id, e.t::"EntityType", 'PendingDelete', '{"deletedBy": "remove-deleted-user-images"}'
        FROM (VALUES (1, 'Image'), (2, 'Image'), (10, 'Post'), (11, 'Post')) e(id, t);
    `);
    mockDbWrite.$queryRaw.mockImplementationOnce((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(sql.text, sql.values as unknown[])).rows;
    }) as never);

    await releaseAccountDeletionPendingDeletes(7);

    const { rows } = await db.query<{ entityType: string; entityId: number; released: boolean }>(
      `SELECT "entityType"::text AS "entityType", "entityId", data ? 'releasedOnRestore' AS released
       FROM "JobQueue" ORDER BY 1, 2`
    );
    // Left for its case, marked so pending-deletes releases rather than deletes it once it closes;
    // the account's others wait with it, to be released together.
    expect(rows).toEqual([
      { entityType: 'Image', entityId: 1, released: true },
      { entityType: 'Image', entityId: 2, released: true },
      { entityType: 'Post', entityId: 10, released: true },
      { entityType: 'Post', entityId: 11, released: true },
    ]);
    await db.close();
  });
});
