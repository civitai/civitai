import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, mockResetNsfwLevel, mockQueueSearchIndex, mockBustCachesForPosts } =
  vi.hoisted(() => ({
    mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
    mockResetNsfwLevel: vi.fn(async () => undefined),
    mockQueueSearchIndex: vi.fn(async () => undefined),
    mockBustCachesForPosts: vi.fn(async () => undefined),
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  resetBlockedNsfwLevel: mockResetNsfwLevel,
  queueImageSearchIndexUpdate: mockQueueSearchIndex,
}));
vi.mock('~/server/services/post.service', () => ({ bustCachesForPosts: mockBustCachesForPosts }));

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  disarmAccountDeletionImagePurge,
  unblockAccountDeletionImages,
} from '~/server/services/account-deletion-images';
import { PRIOR_BLOCKED_FOR_KEY, PRIOR_INGESTION_KEY } from '~/server/utils/image-removal-mode';

/**
 * A tiny in-memory Postgres for the reversal. The statements are interpreted rather than
 * pattern-matched: the scope predicate and every `SET` expression are read out of the SQL and
 * evaluated against the fixture, so a reversal that keys off `blockedFor` (which a moderator
 * block also writes) or that flattens the restored state hands back the wrong rows here.
 */
type ImageRow = {
  id: number;
  userId: number;
  postId: number | null;
  ingestion: string;
  blockedFor: string | null;
  metadata: Record<string, string>;
};

type QueueRow = { entityId: number; entityType: string; type: string };

let images: ImageRow[] = [];
let queue: QueueRow[] = [];

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

function applyRestoreUpdate(sql: string, values: unknown[]) {
  const params = [...values];
  const assignments = splitTopLevel(sql.slice(sql.indexOf('SET ') + 4, sql.indexOf('WHERE'))).map(
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

  const where = sql.slice(sql.indexOf('WHERE') + 5, sql.indexOf('RETURNING'));
  if (!SCOPED_ON_BREADCRUMB.test(where))
    throw new Error(`the reversal must scope on the block's own breadcrumb: ${where}`);

  // Every predicate is applied, and one this does not recognise is rejected rather than assumed,
  // so a reversal that widens its scope cannot pass by relying on the harness to narrow it back.
  const predicates = where.split(/\s+AND\s+/).map((clause) => {
    const args = params.splice(0, (clause.match(/\?/g) ?? []).length);
    if (/^\s*"userId" = \?/.test(clause)) return (row: ImageRow) => row.userId === args[0];
    if (/^\s*ingestion = 'Blocked'/.test(clause))
      return (row: ImageRow) => row.ingestion === 'Blocked';
    if (/^\s*"metadata"->>\?::text IS NOT NULL/.test(clause))
      return (row: ImageRow) => row.metadata[args[0] as string] != null;
    throw new Error(`unrecognized reversal predicate: ${clause.trim()}`);
  });
  const targets = images.filter((row) => predicates.every((holds) => holds(row)));
  for (const row of targets) {
    const next: Partial<ImageRow> = {};
    for (const { column, expr, keys } of assignments) {
      if (METADATA_LOOKUP.test(expr)) next[column as 'ingestion'] = row.metadata[keys[0]] ?? null!;
      else if (METADATA_MINUS.test(expr)) {
        const metadata = { ...row.metadata };
        for (const key of keys) delete metadata[key];
        next.metadata = metadata;
      } else throw new Error(`unhandled assignment: ${expr}`);
    }
    Object.assign(row, next);
  }

  return targets.map(({ id, postId, ingestion }) => ({ id, postId, ingestion }));
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

  mockDbWrite.$queryRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (!sql.includes('UPDATE "Image"')) throw new Error(`unexpected read: ${sql}`);
      return Promise.resolve(applyRestoreUpdate(sql, values));
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

    expect(result).toEqual({ unblocked: 0, stillBlocked: 0 });
    expect(mockResetNsfwLevel).not.toHaveBeenCalled();
    expect(mockBustCachesForPosts).not.toHaveBeenCalled();
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
