import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const adapter = { load: vi.fn(), save: vi.fn() };

vi.mock('~/server/services/blurb-fanout.adapters', () => ({
  getBlurbFanoutAdapter: () => adapter,
}));

const { processBlurbReference } = await import('~/server/services/blurb-fanout.service');

const ref = { blurbId: 7, entityType: 'Article', entityId: 1, materializedHash: 'old' };
const blurb = { id: 7, content: 'NEW', contentHash: 'new', deletedAt: null as Date | null };

beforeEach(() => {
  vi.clearAllMocks();
  adapter.load.mockResolvedValue({
    userId: 10,
    html: '<span data-type="blurb" data-id="7">OLD</span>',
  });
});

describe('processBlurbReference', () => {
  it('rewrites the span through the adapter save', async () => {
    const result = await processBlurbReference(ref, blurb);
    expect(result).toBe('rewritten');
    expect(adapter.save).toHaveBeenCalledWith({
      entityId: 1,
      userId: 10,
      html: '<span data-type="blurb" data-id="7">NEW</span>',
    });
  });

  it('skips the write when the span already holds the right text', async () => {
    adapter.load.mockResolvedValue({
      userId: 10,
      html: '<span data-type="blurb" data-id="7">NEW</span>',
    });
    const result = await processBlurbReference(ref, blurb);
    expect(result).toBe('skipped');
    expect(adapter.save).not.toHaveBeenCalled();
    // Still records, so the reference stops being selected.
    expect(dbMock.dbWrite.blurbReference.update).toHaveBeenCalled();
  });

  it('drops the reference when the entity no longer exists', async () => {
    adapter.load.mockResolvedValue(null);
    const result = await processBlurbReference(ref, blurb);
    expect(result).toBe('gone');
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalled();
    expect(adapter.save).not.toHaveBeenCalled();
  });

  it('unwraps the span when the blurb is soft-deleted', async () => {
    const result = await processBlurbReference(ref, { ...blurb, deletedAt: new Date() });
    expect(result).toBe('rewritten');
    expect(adapter.save).toHaveBeenCalledWith({
      entityId: 1,
      userId: 10,
      html: 'OLD',
    });
    expect(dbMock.dbWrite.blurbReference.deleteMany).toHaveBeenCalled();
  });

  it('records the new hash after a rewrite', async () => {
    await processBlurbReference(ref, blurb);
    const call = dbMock.dbWrite.blurbReference.update.mock.calls[0][0];
    expect(call.data.materializedHash).toBe('new');
  });
});
