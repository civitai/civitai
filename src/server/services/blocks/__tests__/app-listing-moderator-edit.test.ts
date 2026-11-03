import { beforeEach, describe, expect, it } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { recordModeratorListingEdit } from '~/server/services/blocks/app-listing-moderator-edit';

const findListing = dbMock.dbWrite.appListing.findUnique;
const createEvent = dbMock.dbWrite.appListingModerationEvent.create;

beforeEach(() => createEvent.mockClear());

describe('recordModeratorListingEdit', () => {
  it('records an edit of a shadow revision on its parent, under the public slug', async () => {
    findListing.mockResolvedValue({
      id: 'apl_shadow',
      slug: 'rev-01',
      revisionOf: { id: 'apl_parent', slug: 'cool-app' },
    });
    await recordModeratorListingEdit({
      appListingId: 'apl_shadow',
      actorUserId: 7,
      surface: 'details',
    });
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appListingId: 'apl_parent',
        slug: 'cool-app',
        action: 'moderator-edit',
        actorUserId: 7,
        detail: 'details',
        reason: "A moderator edited this listing's details.",
      }),
    });
  });

  it('records a top-level listing on itself', async () => {
    findListing.mockResolvedValue({ id: 'apl_1', slug: 'app', revisionOf: null });
    await recordModeratorListingEdit({ appListingId: 'apl_1', actorUserId: 7, surface: 'media' });
    expect(createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ appListingId: 'apl_1', slug: 'app', detail: 'media' }),
    });
  });

  it('refuses, writing nothing, when the listing is gone', async () => {
    findListing.mockResolvedValue(null);
    await expect(
      recordModeratorListingEdit({ appListingId: 'apl_x', actorUserId: 7, surface: 'details' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(createEvent).not.toHaveBeenCalled();
  });
});
