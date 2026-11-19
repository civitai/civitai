import { afterEach, describe, expect, it } from 'vitest';
import { setTrpcBatchingEnabled, shouldBatch, shouldSendQueryAsPost } from '~/utils/trpc';

const op = { type: 'query', path: 'imageSearchUpload.search', input: { uploadUrl: 'x' } };

describe('a query carrying a private upload URL', () => {
  afterEach(() => {
    setTrpcBatchingEnabled(false);
    delete (globalThis as { window?: unknown }).window;
  });

  it('leaves as POST, so the URL is not in the request line', () => {
    expect(shouldSendQueryAsPost(op)).toBe(true);
    // Control: an ordinary small query still leaves as GET.
    expect(shouldSendQueryAsPost({ ...op, path: 'image.getInfinite' })).toBe(false);
  });

  it('is never batched, since the batch link sends GET', () => {
    // The batch cohort: flag on and an authenticated browser.
    setTrpcBatchingEnabled(true);
    (globalThis as { window?: unknown }).window = { isAuthed: true };
    expect(shouldBatch({ ...op, context: {} })).toBe(false);
    // Control: an ordinary query in the same cohort is batched.
    expect(shouldBatch({ ...op, path: 'model.getById', input: { id: 1 }, context: {} })).toBe(true);
  });
});
