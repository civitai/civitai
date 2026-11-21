import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getLicensingRoots } from '~/server/services/model-version.service';

// Restricted roots stay in the list: the editor reads it to tell that the version it is editing IS a
// root (and so must not be given a parent). The picker hides them; a restricted root is never the
// pre-selected default, which would stamp it onto every new version of its base model.
describe('getLicensingRoots — restricted roots', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
  });

  it('returns them, flagged, so the editor still recognises a root', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 1, isDefault: false, restricted: true }]);
    const { roots } = await getLicensingRoots({ baseModel: 'Upscaler' });
    expect(roots).toEqual([expect.objectContaining({ id: 1, restricted: true })]);
    expect(JSON.stringify(dbMock.dbRead.$queryRaw.mock.calls[0])).not.toContain(
      'restricted = false'
    );
  });

  it('never makes one the default', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 1, isDefault: true, restricted: true }]);
    expect((await getLicensingRoots({ baseModel: 'Upscaler' })).defaultVersionId).toBeNull();
  });

  it('still defaults to an unrestricted default root (control)', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 2, isDefault: true, restricted: false }]);
    expect((await getLicensingRoots({ baseModel: 'Upscaler' })).defaultVersionId).toBe(2);
  });
});
