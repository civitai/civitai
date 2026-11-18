import { describe, expect, it } from 'vitest';
import { shouldSendQueryAsPost } from '~/utils/trpc';

describe('a query carrying a private upload URL', () => {
  it('leaves as POST, so the URL is not in the request line', () => {
    const op = { type: 'query', path: 'imageSearchUpload.search', input: { uploadUrl: 'x' } };
    expect(shouldSendQueryAsPost(op)).toBe(true);
    // Control: an ordinary small query still leaves as GET.
    expect(shouldSendQueryAsPost({ ...op, path: 'image.getInfinite' })).toBe(false);
  });
});
