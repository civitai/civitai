import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  groupBlocksByStorageSlug,
  storageSlugConflictMessage,
} from '~/server/services/apps/storage-slug-claims';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../../test/source-scan';

const mockBlocks = dbMock.dbWrite.appBlock.findMany;
const mockPending = dbMock.dbWrite.appBlockPublishRequest.findMany;

type PendingWhere = { where: { status: string; slug: { not: string } } };

/** Publish-request rows filtered the way the real query would filter them. */
function publishRequests(rows: { slug: string; status: string }[]) {
  mockPending.mockImplementation(async ({ where }: PendingWhere) =>
    rows.filter((r) => r.status === where.status && r.slug !== where.slug.not)
  );
}

beforeEach(() => {
  mockBlocks.mockResolvedValue([]);
  publishRequests([]);
});

describe('groupBlocksByStorageSlug', () => {
  it('groups blockIds that differ only in the length of a hyphen run', () => {
    const blocks = [
      { blockId: 'my-app', id: 'a' },
      { blockId: 'chess-clock', id: 'b' },
      { blockId: 'my---app', id: 'c' },
    ];
    expect(groupBlocksByStorageSlug(blocks)).toEqual(
      new Map([
        ['my_app', [blocks[0], blocks[2]]],
        ['chess_clock', [blocks[1]]],
      ])
    );
  });

  it('keeps blockIds apart when the hyphen sits in a different place', () => {
    const grouped = groupBlocksByStorageSlug([{ blockId: 'my-app' }, { blockId: 'm-yapp' }]);
    expect([...grouped.keys()]).toEqual(['my_app', 'm_yapp']);
  });

  it('leaves out a blockId with no valid storage slug', () => {
    expect(groupBlocksByStorageSlug([{ blockId: 'x' }, { blockId: '9lives' }]).size).toBe(0);
  });
});

describe('storageSlugConflictMessage', () => {
  const withPending = { includePendingRequests: true };

  it('names the existing app a new blockId collides with', async () => {
    mockBlocks.mockResolvedValue([{ blockId: 'chess-clock' }, { blockId: 'my-app' }]);
    expect(await storageSlugConflictMessage('my--app', withPending)).toBe(
      'blockId "my--app" is too similar to the existing app "my-app": both would use the storage name "my_app", because a run of hyphens counts as a single separator. Choose a different blockId.'
    );
  });

  it('allows a blockId that already has its own app block', async () => {
    mockBlocks.mockResolvedValue([{ blockId: 'chess-clock' }, { blockId: 'my-app' }]);
    expect(await storageSlugConflictMessage('my-app', withPending)).toBeNull();
  });

  it('allows an existing app even when a colliding sibling already exists', async () => {
    mockBlocks.mockResolvedValue([{ blockId: 'my-app' }, { blockId: 'my--app' }]);
    expect(await storageSlugConflictMessage('my--app', withPending)).toBeNull();
  });

  it('allows an unrelated new blockId', async () => {
    mockBlocks.mockResolvedValue([{ blockId: 'chess-clock' }, { blockId: 'my-app' }]);
    expect(await storageSlugConflictMessage('paint-box', withPending)).toBeNull();
  });

  it('reports no conflict between two blockIds that have no storage slug at all', async () => {
    mockBlocks.mockResolvedValue([{ blockId: '7lives' }]);
    publishRequests([{ slug: '8lives', status: 'pending' }]);
    expect(await storageSlugConflictMessage('9lives', withPending)).toBeNull();
  });

  it('refuses a collision with a pending submission without naming its blockId', async () => {
    publishRequests([{ slug: 'paint-box', status: 'pending' }]);
    expect(await storageSlugConflictMessage('paint--box', withPending)).toBe(
      'blockId "paint--box" is too similar to the blockId of another app that is awaiting review: both would use the storage name "paint_box", because a run of hyphens counts as a single separator. Choose a different blockId.'
    );
  });

  it('ignores a pending collision when pending requests are not counted', async () => {
    publishRequests([{ slug: 'paint-box', status: 'pending' }]);
    expect(
      await storageSlugConflictMessage('paint--box', { includePendingRequests: false })
    ).toBeNull();
  });

  it("is not blocked by the blockId's own pending request", async () => {
    publishRequests([{ slug: 'paint--box', status: 'pending' }]);
    expect(await storageSlugConflictMessage('paint--box', withPending)).toBeNull();
  });

  it('is not blocked by a colliding request that was withdrawn, rejected or approved', async () => {
    publishRequests([
      { slug: 'paint-box', status: 'withdrawn' },
      { slug: 'paint-box', status: 'rejected' },
      { slug: 'paint-box', status: 'approved' },
    ]);
    expect(await storageSlugConflictMessage('paint--box', withPending)).toBeNull();
  });
});

/**
 * The check only holds while every path that can create an app block runs it. Fails when
 * a creator appears without the check, or when a ledgered one stops creating.
 */
describe('ledger: every app-block creator runs the storage-slug check', () => {
  const scan = scanSource(process.cwd(), {
    storageSlugConflictMessage: 'src/server/services/apps/storage-slug-claims.ts',
  });
  const CREATES_APP_BLOCK = /\bappBlock\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/;
  const creators = scan.files.filter((f) => CREATES_APP_BLOCK.test(scan.code.get(f)!)).sort();

  it('the creators are exactly the two known files', () => {
    expect(creators).toEqual([
      'src/pages/api/v1/developer/block-manifests.ts',
      'src/server/services/blocks/publish-request.service.ts',
    ]);
  });

  it('each creator calls the check', () => {
    expect(scan.callersOf('storageSlugConflictMessage')).toEqual(creators);
  });

  it('the check runs at submit AND at approve, and once at the manifest endpoint', () => {
    const calls = (file: string) =>
      scan.code.get(file)!.match(/\bstorageSlugConflictMessage\s*\(/g)?.length ?? 0;
    expect(creators.map(calls)).toEqual([1, 2]);
  });
});
