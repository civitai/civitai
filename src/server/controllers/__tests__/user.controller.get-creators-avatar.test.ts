import { describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import { NsfwLevel } from '~/server/common/enums';

const { getCreators } = vi.hoisted(() => ({ getCreators: vi.fn() }));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getCreators,
}));

import { getCreatorsHandler } from '~/server/controllers/user.controller';

async function pictureAt(nsfwLevel: number) {
  getCreators.mockResolvedValue({
    items: [{ username: 'a', profilePicture: { url: 'avatar.png', type: 'image', nsfwLevel } }],
    count: 1,
  });
  const { items } = await getCreatorsHandler({ input: {} });
  return items[0].profilePicture;
}

describe('user.getCreators avatar', () => {
  it('drops a profile picture above PG', async () => {
    expect(await pictureAt(NsfwLevel.R)).toBeNull();
  });

  it('keeps a PG profile picture (control)', async () => {
    expect(await pictureAt(NsfwLevel.PG)).toMatchObject({ url: 'avatar.png' });
  });
});
