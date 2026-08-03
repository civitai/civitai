import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockResetNsfwLevel,
  mockQueueSearchIndex,
  mockBustCachesForPosts,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockResetNsfwLevel: vi.fn(async () => undefined),
  mockQueueSearchIndex: vi.fn(async () => undefined),
  mockBustCachesForPosts: vi.fn(async () => undefined),
  mockLogToAxiom: vi.fn(async () => undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  resetBlockedNsfwLevel: mockResetNsfwLevel,
  queueImageSearchIndexUpdate: mockQueueSearchIndex,
}));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: mockBustCachesForPosts }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  disarmAccountDeletionImagePurge,
  unblockAccountDeletionImages,
  MAX_RESTORE_BATCHES,
  RESTORE_BATCH_SIZE,
} from '~/server/services/account-deletion-images';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * A tiny in-memory Postgres for the reversal. The statements are interpreted rather than
 * pattern-matched: the scope predicate, the batch bound and every `SET` expression are read out of
 * the SQL and evaluated against the fixture, so a reversal that keys off `blockedFor` (which a
 * moderator block also writes), that claims the gallery unbounded, or that flattens the restored
 * state hands back the wrong rows here. The enum cast is modelled the way Postgres runs it — a
 * value outside `ImageIngestionStatus` aborts the whole statement — so a reversal that lets a
 * malformed breadcrumb into its claim loses the batch rather than the row.
 */
type ImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  ingestion: string;
  blockedFor: string | null;
  metadata: Record<string, string>;
  /** Fiction: a row the claim matches but the UPDATE never moves off `Blocked`. */
  stuck?: boolean;
};

type QueueRow = { entityId: number; entityType: string; type: string };

const INGESTION_STATUSES: string[] = Object.values(ImageIngestionStatus);

let images: ImageRow[] = [];
let queue: QueueRow[] = [];
/** Rows handed back per reversal pass, terminating empty pass included. */
let claimedPerPass: number[] = [];

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
const CLAIMS_BY_ID = /^WHERE\s+id IN \(\s*SELECT i\.id\s+FROM "Image" i\s+WHERE\s/;
const BOUNDED_CLAIM = /^LIMIT \?\s*\)\s*$/;
const ENUM_RANGE = /\(SELECT unnest\(enum_range\(NULL::"ImageIngestionStatus"\)\)::text\)/;

function applyRestoreUpdate(sql: string, values: unknown[]) {
  const params = [...values];
  const whereAt = sql.indexOf('WHERE');
  const assignments = splitTopLevel(sql.slice(sql.indexOf('SET ') + 4, whereAt)).map(
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

  // The whole gallery reaching Node in one statement is the failure this batching exists to
  // prevent, so a claim without its own bound is rejected rather than run.
  const claim = sql.slice(whereAt, sql.indexOf('RETURNING'));
  if (!CLAIMS_BY_ID.test(claim)) throw new Error(`the reversal must claim rows by id: ${claim}`);
  const innerWhereAt = claim.indexOf('WHERE', 1);
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
    throw new Error(`unrecognized reversal predicate: ${clause.trim()}`);
  });

  const limit = params.shift() as number;
  const claimed = images.filter((row) => predicates.every((holds) => holds(row))).slice(0, limit);

  // Staged before anything is written: a statement that trips the enum cast leaves no row behind.
  const staged = claimed.map((row) => {
    const next: Partial<ImageRow> = {};
    for (const { column, expr, keys } of assignments) {
      const lookup = expr.match(METADATA_LOOKUP);
      if (lookup) {
        const value = row.metadata[keys[0]] ?? null;
        if (lookup[1] === '::"ImageIngestionStatus"' && !INGESTION_STATUSES.includes(value!))
          throw new Error(`invalid input value for enum ImageIngestionStatus: "${value}"`);
        next[column as 'ingestion'] = value!;
      } else if (METADATA_MINUS.test(expr)) {
        const metadata = { ...row.metadata };
        for (const key of keys) delete metadata[key];
        next.metadata = metadata;
      } else throw new Error(`unhandled assignment: ${expr}`);
    }
    return { row, next };
  });
  for (const { row, next } of staged) if (!row.stuck) Object.assign(row, next);

  claimedPerPass.push(claimed.length);
  return claimed.map(({ id, postId, ingestion }) => ({ id, postId, ingestion }));
}

/** Same discipline for the audit count: predicates are read out, not assumed. */
function countUnreadableBreadcrumbs(sql: string, values: unknown[]) {
  const params = [...values];
  const predicates = sql
    .slice(sql.indexOf('WHERE') + 5)
    .split(/\s+AND\s+/)
    .map((clause) => {
      const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
      if (/^\s*"userId" = \?/.test(clause)) return (row: ImageRow) => row.userId === args[0];
      if (/^\s*ingestion = 'Blocked'/.test(clause))
        return (row: ImageRow) => row.ingestion === 'Blocked';
      if (/^\s*"metadata"->>\?::text IS NOT NULL/.test(clause))
        return (row: ImageRow) => row.metadata[args[0] as string] != null;
      if (/^\s*"metadata"->>\?::text NOT IN /.test(clause) && ENUM_RANGE.test(clause))
        return (row: ImageRow) => !INGESTION_STATUSES.includes(row.metadata[args[0] as string]);
      throw new Error(`unrecognized breadcrumb-audit predicate: ${clause.trim()}`);
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
      if (/^\s*"entityId" IN \(SELECT i\.id FROM "Image" i WHERE i\."userId" = \?\)/.test(clause))
        return images.some((image) => image.userId === args[0] && image.id === row.entityId);
      throw new Error(`unrecognized JobQueue delete predicate: ${clause.trim()}`);
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  images = [];
  queue = [];
  claimedPerPass = [];

  mockDbWrite.$queryRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('UPDATE "Image"')) return Promise.resolve(applyRestoreUpdate(sql, values));
      if (sql.includes('SELECT COUNT(*)'))
        return Promise.resolve(countUnreadableBreadcrumbs(sql, values));
      throw new Error(`unexpected read: ${sql}`);
    }
  );

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

  it('clears the breadcrumbs so a later moderator block is not mistaken for this one', async () => {
    images = [
      hidden(1, 'Blocked', {
        metadata: {
          [PRIOR_INGESTION_KEY]: 'Blocked',
          [PRIOR_BLOCKED_FOR_KEY]: 'AiNotVerified',
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
    expect(mockResetNsfwLevel).toHaveBeenCalledWith([1]);
    expect(mockQueueSearchIndex).toHaveBeenCalledWith({
      ids: [1],
      action: SearchIndexUpdateQueueAction.Update,
    });
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

    expect(result).toEqual({ unblocked: 0, stillBlocked: 0, skipped: 0 });
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
    expect(result).toEqual({ unblocked: 2, stillBlocked: 0, skipped: 1 });
    expect(mockResetNsfwLevel).toHaveBeenCalledWith([1, 3]);
  });

  it('logs the rows it left blocked with an unreadable breadcrumb', async () => {
    images = [hidden(1, 'Scanned'), hidden(2, 'Scannned')];

    await unblockAccountDeletionImages(7);

    // Skipped silently, a row stays hidden on a live account with nothing pointing at it.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'account-deletion-image-restore', userId: 7, skipped: 1 })
    );
  });

  it('stops instead of spinning when a claimed row comes back unchanged', async () => {
    images = [hidden(1, 'Scanned', { stuck: true })];

    const result = await unblockAccountDeletionImages(7);

    expect(claimedPerPass).toHaveLength(MAX_RESTORE_BATCHES);
    expect(result.unblocked).toBe(0);
    expect(mockLogToAxiom).toHaveBeenCalledWith(expect.objectContaining({ drained: false }));
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

describe('disarmAccountDeletionImagePurge', () => {
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
