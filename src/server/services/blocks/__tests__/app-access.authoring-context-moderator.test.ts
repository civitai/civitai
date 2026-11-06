import { beforeEach, describe, expect, it } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getAppListingAuthoringContext } from '~/server/services/blocks/app-access.service';

const OWNER = 10;
const MOD = 7;
const STRANGER = 99;

const listing = {
  id: 'apl_1',
  slug: 'my-app',
  name: 'My App',
  status: 'approved',
  kind: 'offsite',
  appBlockId: null,
  connectClientId: null,
  revisionOfId: null,
  userId: OWNER,
  appBlock: null,
  revisionOf: null,
};

beforeEach(() => {
  dbMock.dbRead.appListing.findUnique.mockResolvedValue(listing);
  dbMock.dbRead.appCollaborator.findFirst.mockResolvedValue(null);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
});

describe('getAppListingAuthoringContext admits a moderator who holds no seat', () => {
  it('a moderator opens the editor of a listing they do not own, as role moderator', async () => {
    const ctx = await getAppListingAuthoringContext({
      appListingId: 'apl_1',
      userId: MOD,
      isModerator: true,
    });
    expect(ctx.role).toBe('moderator');
  });

  it('a stranger who is not a moderator is refused', async () => {
    await expect(
      getAppListingAuthoringContext({ appListingId: 'apl_1', userId: STRANGER, isModerator: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a moderator who owns the listing is still the owner', async () => {
    const ctx = await getAppListingAuthoringContext({
      appListingId: 'apl_1',
      userId: OWNER,
      isModerator: true,
    });
    expect(ctx.role).toBe('owner');
  });
});
