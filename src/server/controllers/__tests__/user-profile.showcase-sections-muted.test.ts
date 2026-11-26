import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserProfileService from '~/server/services/user-profile.service';

const { setShowcaseSections, addToShowcaseSection } = vi.hoisted(() => ({
  setShowcaseSections: vi.fn(async () => []),
  addToShowcaseSection: vi.fn(async () => ({ added: true, sections: [] })),
}));

vi.mock('~/server/services/user-profile.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileService>()),
  setShowcaseSections,
  addToShowcaseSection,
}));

const { setShowcaseSectionsHandler, addToShowcaseSectionHandler } = await import(
  '~/server/controllers/user-profile.controller'
);

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

describe('addToShowcaseSectionHandler', () => {
  const input = { sectionId: 's1', entityType: 'Image' as const, entityId: 3 };
  const add = (user: { id: number; muted?: boolean }) =>
    addToShowcaseSectionHandler({ input, ctx: { user } as never } as never);

  beforeEach(() => addToShowcaseSection.mockClear());

  it('refuses a muted user and adds nothing', async () => {
    await expect(add({ id: 7, muted: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(addToShowcaseSection).not.toHaveBeenCalled();
  });

  it('adds to the caller’s own profile', async () => {
    await add({ id: 7, muted: false });
    expect(addToShowcaseSection).toHaveBeenCalledWith({ ...input, userId: 7 });
  });
});
