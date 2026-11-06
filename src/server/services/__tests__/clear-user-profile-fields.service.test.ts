import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { clearUserProfileFields } from '~/server/services/user.service';

const db = dbMock.dbWrite;

beforeEach(() => {
  vi.clearAllMocks();
  db.userProfile.updateMany.mockResolvedValue({ count: 1 } as never);
});

// Showcase titles and button links are profile text a moderator must be able to clear.
describe('clearUserProfileFields', () => {
  it('clears custom showcase sections by default', async () => {
    await clearUserProfileFields({ userId: 5 });
    expect(db.userProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: 5 },
      data: expect.objectContaining({ showcaseSections: [], bio: null, message: null }),
    });
  });

  it('leaves them when only other fields are named', async () => {
    await clearUserProfileFields({ userId: 5, fields: ['bio'] });
    const { data } = db.userProfile.updateMany.mock.calls[0][0] as { data: object };
    expect(data).not.toHaveProperty('showcaseSections');
  });
});
