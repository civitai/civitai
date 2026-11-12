import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserProfileService from '~/server/services/user-profile.service';

const { setShowcaseSections } = vi.hoisted(() => ({
  setShowcaseSections: vi.fn(async () => []),
}));

vi.mock('~/server/services/user-profile.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileService>()),
  setShowcaseSections,
}));

const { setShowcaseSectionsHandler } = await import('~/server/controllers/user-profile.controller');

const call = (user: { id: number; muted?: boolean }) =>
  setShowcaseSectionsHandler({
    input: { sections: [] },
    ctx: { user } as never,
  } as never);

describe('setShowcaseSectionsHandler', () => {
  beforeEach(() => setShowcaseSections.mockClear());

  it('refuses a muted user and saves nothing', async () => {
    await expect(call({ id: 7, muted: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(setShowcaseSections).not.toHaveBeenCalled();
  });

  it("saves an unmuted user's sections under their own id", async () => {
    await call({ id: 7, muted: false });
    expect(setShowcaseSections).toHaveBeenCalledWith({ sections: [], userId: 7 });
  });
});
