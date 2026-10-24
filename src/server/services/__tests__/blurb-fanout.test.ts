import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const adapter = { load: vi.fn(), save: vi.fn() };

// Both exports, not just the one these tests reach. `blurb-fanout.service` imports
// `getSupportedBlurbEntityTypes` too, and a hand-listed factory that omits it works only while
// nothing evaluates it — move that call to module scope and this file collects ZERO tests while
// still reporting green.
vi.mock('~/server/services/blurb-fanout.adapters', () => ({
  getBlurbFanoutAdapter: () => adapter,
  getSupportedBlurbEntityTypes: () => ['Article'],
}));

const { processBlurbEntity } = await import('~/server/services/blurb-fanout.service');

const row = {
  blurbId: 7,
  entityType: 'Article',
  entityId: 1,
  materializedHash: 'old',
  id: 7,
  content: 'NEW',
  contentHash: 'new',
  deletedAt: null as Date | null,
};

const BODY = '<div data-type="blurb" data-id="7">OLD</div>';

beforeEach(() => {
  vi.clearAllMocks();
  adapter.load.mockResolvedValue({ userId: 10, html: BODY });
  // `save` reports whether it actually wrote. A bare vi.fn() resolves undefined, which the
  // compare-and-set path reads as "someone else got there first".
  adapter.save.mockResolvedValue(true);
});

describe('processBlurbEntity', () => {
  it('rewrites the span through the adapter save', async () => {
    const result = await processBlurbEntity([row]);
    expect(result).toBe('rewritten');
    expect(adapter.save).toHaveBeenCalledWith({
      entityId: 1,
      userId: 10,
      html: '<div data-type="blurb" data-id="7">NEW</div>',
      expectedHtml: BODY,
    });
  });

  it('skips the write when the span already holds the right text', async () => {
    adapter.load.mockResolvedValue({
      userId: 10,
      html: '<div data-type="blurb" data-id="7">NEW</div>',
    });
    const result = await processBlurbEntity([row]);
    expect(result).toBe('skipped');
    expect(adapter.save).not.toHaveBeenCalled();
    // Still records, so the reference stops being selected.
    expect(dbMock.dbWrite.blurbReference.updateMany).toHaveBeenCalled();
  });

  it('drops the reference when the entity no longer exists', async () => {
    adapter.load.mockResolvedValue(null);
    const result = await processBlurbEntity([row]);
    expect(result).toBe('gone');
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalled();
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it('unwraps the span when the blurb is soft-deleted', async () => {
    const result = await processBlurbEntity([{ ...row, deletedAt: new Date() }]);
    expect(result).toBe('rewritten');
    expect(adapter.save).toHaveBeenCalledWith({
      entityId: 1,
      userId: 10,
      html: 'OLD',
      expectedHtml: BODY,
    });
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalled();
  });

  it('records the new hash after a rewrite', async () => {
    await processBlurbEntity([row]);
    const call = dbMock.dbWrite.blurbReference.updateMany.mock.calls[0][0];
    expect(call.data.materializedHash).toBe('new');
  });

  it('drops the reference when a soft-deleted blurb is already unwrapped', async () => {
    adapter.load.mockResolvedValue({ userId: 10, html: 'OLD' });
    const result = await processBlurbEntity([{ ...row, deletedAt: new Date() }]);
    expect(result).toBe('skipped');
    expect(adapter.save).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalled();
  });
});

describe('processBlurbEntity — two stale blurbs in one entity', () => {
  const rowA = { ...row, blurbId: 7, id: 7, content: 'A-NEW', contentHash: 'ha' };
  const rowB = { ...row, blurbId: 8, id: 8, content: 'B-NEW', contentHash: 'hb' };

  beforeEach(() => {
    adapter.load.mockResolvedValue({
      userId: 10,
      html:
        '<div data-type="blurb" data-id="7">A-OLD</div>' +
        '<div data-type="blurb" data-id="8">B-OLD</div>',
    });
  });

  it('🔴 applies both in a single save, so neither edit is discarded', async () => {
    // Per-reference processing loaded the same html twice and replaced only its own blurb, so
    // one save overwrote the other's and BOTH rows were still stamped current — a permanent,
    // silent loss on published content.
    const result = await processBlurbEntity([rowA, rowB]);

    expect(result).toBe('rewritten');
    expect(adapter.save).toHaveBeenCalledTimes(1);
    expect(adapter.save.mock.calls[0][0].html).toBe(
      '<div data-type="blurb" data-id="7">A-NEW</div>' +
        '<div data-type="blurb" data-id="8">B-NEW</div>'
    );
  });

  it('loads the entity once for the whole group', async () => {
    await processBlurbEntity([rowA, rowB]);
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });

  it('records both rows so neither is re-selected', async () => {
    await processBlurbEntity([rowA, rowB]);

    const recorded = dbMock.dbWrite.blurbReference.updateMany.mock.calls.map(([arg]) => ({
      blurbIds: arg.where.blurbId.in,
      hash: arg.data.materializedHash,
    }));
    expect(recorded).toEqual([
      { blurbIds: [7], hash: 'ha' },
      { blurbIds: [8], hash: 'hb' },
    ]);
  });

  it('🔴 collapses rows sharing a hash into ONE statement', async () => {
    // The loop this replaced issued one primary UPDATE per reference row, so a saturated pass
    // was up to BATCH_LIMIT sequential round trips. Revert it and this reports 2, not 1.
    await processBlurbEntity([rowA, { ...rowB, contentHash: 'ha' }]);

    expect(dbMock.dbWrite.blurbReference.updateMany).toHaveBeenCalledTimes(1);
    const [arg] = dbMock.dbWrite.blurbReference.updateMany.mock.calls[0];
    expect(arg.where).toMatchObject({ entityType: 'Article', entityId: 1 });
    expect(arg.where.blurbId.in).toEqual([7, 8]);
  });

  it('replaces a live blurb and unwraps a deleted one in the same pass', async () => {
    await processBlurbEntity([rowA, { ...rowB, deletedAt: new Date() }]);

    expect(adapter.save.mock.calls[0][0].html).toBe(
      '<div data-type="blurb" data-id="7">A-NEW</div>B-OLD'
    );
    // The deleted one's row goes; the live one's is recorded.
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: 1, blurbId: { in: [8] } },
    });
    expect(dbMock.dbWrite.blurbReference.updateMany).toHaveBeenCalledTimes(1);
  });
});

// The lost update. `processBlurbEntity` reads the body, splices, and writes it back with nothing
// held across the two — so a creator saving in that window had their edit replaced by a replay of
// the body as it was BEFORE they saved. Silent in both directions: their save had already returned
// success, and the fan-out recorded the references as current so nothing ever revisited the entity.
describe('processBlurbEntity — a concurrent save', () => {
  it('🔴 writes nothing and records nothing when the body moved under it', async () => {
    adapter.save.mockResolvedValue(false);

    const outcome = await processBlurbEntity([row]);

    expect(outcome).toBe('conflict');
    // Not recorded: the row must stay pending so the next pass re-reads the body the creator
    // actually saved and splices into THAT. Recording here is what made the loss permanent.
    expect(dbMock.dbWrite.blurbReference.updateMany).not.toHaveBeenCalled();
  });

  it('hands the adapter the body it read, so the write can compare against it', async () => {
    await processBlurbEntity([row]);

    const [args] = adapter.save.mock.calls[0];
    expect(args.expectedHtml).toBe(BODY);
    expect(args.html).not.toBe(BODY);
  });
});
