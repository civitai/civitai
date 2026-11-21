import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getLicensingRoots } from '~/server/services/model-version.service';

// A restricted root's fee is owed only for the versions its licence covers, so the editor's picker must
// not offer it to creators; a moderator, who links the covered versions, still sees it.
describe('getLicensingRoots — restricted roots', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
  });
  const query = () => JSON.stringify(dbMock.dbRead.$queryRaw.mock.calls[0]);

  it('leaves them out of the picker by default', async () => {
    await getLicensingRoots({ baseModel: 'Upscaler' });
    expect(query()).toContain('lr.restricted = false');
  });

  it('includes them when asked (a moderator)', async () => {
    await getLicensingRoots({ baseModel: 'Upscaler', includeRestricted: true });
    expect(query()).not.toContain('restricted');
  });
});
