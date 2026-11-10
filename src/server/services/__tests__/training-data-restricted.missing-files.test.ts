import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

import {
  trainingDataListing,
  trainingDataPublicView,
} from '~/server/services/training-data-restricted.service';

/**
 * model-version getById selects `files` only with `withFiles: true`, so most calls resolve a
 * version with no `files` key. Everyone else's view (`trainingDataPublicView`, run by the router's
 * owner-only-file-urls strip) must pass such a version through, not throw
 * "Cannot read properties of undefined (reading 'some')" — the error v5.1.464 returned on most
 * modelVersion.getById calls.
 */
const db = () => ({ $queryRaw: vi.fn().mockResolvedValue([]) });

describe('training-data views with no files selected', () => {
  it('trainingDataListing checks nothing for a version without files', async () => {
    const q = db();
    const listed = await trainingDataListing(q as never, [{ id: 41 }], { redCapable: false });
    expect(q.$queryRaw).not.toHaveBeenCalled();
    expect(listed({ id: 3, type: 'Model', visibility: 'Public' })).toBe(true);
  });

  it('trainingDataPublicView passes an absent files through unchanged', async () => {
    const view = await trainingDataPublicView(db() as never, [{ id: 41 }], { redCapable: false });
    expect(view(undefined)).toBeUndefined();
    expect(view(null)).toBeNull();
  });

  it('still hides a non-public Training Data file when files are selected', async () => {
    const files = [
      { id: 3, type: 'Model', visibility: 'Public', metadata: { format: 'SafeTensor' } },
      { id: 4, type: 'Training Data', visibility: 'Private', metadata: { nsfwLevel: 1 } },
    ];
    const q = db();
    const view = await trainingDataPublicView(q as never, [{ id: 41, files }], {
      redCapable: false,
    });
    expect(q.$queryRaw).toHaveBeenCalledTimes(1);
    expect(view(files)).toEqual([files[0]]);
  });
});
