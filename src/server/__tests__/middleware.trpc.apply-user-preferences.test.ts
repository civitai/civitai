import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `applyUserPreferences` decides which hidden images reach the query, and it runs
 * AHEAD of `cacheIt` — so it executes on cache hits too. The membership test it
 * performs is the part worth pinning: an implicitly-hidden image carries the tag
 * that caused it, and it is only excluded when the viewer still hides that tag.
 *
 * The failure this guards is a lookup built over the wrong values (tag objects
 * rather than tag ids), which never matches and silently un-hides every
 * tag-implied image while leaving the explicit ones correct.
 */

const { capturedHandlers, mockGetAllHiddenForUser } = vi.hoisted(() => ({
  capturedHandlers: [] as Array<(arg: unknown) => Promise<unknown>>,
  mockGetAllHiddenForUser: vi.fn(),
}));

vi.mock('~/server/trpc', () => ({
  middleware: (handler: (arg: unknown) => Promise<unknown>) => {
    capturedHandlers.push(handler);
    return handler;
  },
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: mockGetAllHiddenForUser,
}));

await import('~/server/middleware.trpc');

// applyUserPreferences is the first middleware() call in the module.
const applyUserPreferencesHandler = capturedHandlers[0];

const invoke = async (input: Record<string, unknown>, cookies: Record<string, string> = {}) => {
  const next = vi.fn(async () => ({ ok: true }));
  await applyUserPreferencesHandler({
    input,
    ctx: { user: { id: 7 }, req: { cookies } },
    next,
    path: 'tag.getAll',
  });
  return input as { excludedImageIds?: number[]; excludedTagIds?: number[] };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllHiddenForUser.mockResolvedValue({
    hiddenTags: [
      { id: 100, hidden: true },
      { id: 200, hidden: true },
      { id: 300, hidden: false },
    ],
    hiddenImages: [
      { id: 1 }, // explicit hide, no tag
      { id: 2, tagId: 100 }, // implied by a tag the viewer hides
      { id: 3, tagId: 300 }, // implied by a tag the viewer does NOT hide
      { id: 4, tagId: 999 }, // implied by a tag absent from the list entirely
    ],
    hiddenModels: [],
    hiddenUsers: [],
  });
});

describe('applyUserPreferences — which hidden images reach the query', () => {
  it('excludes an explicitly hidden image, which carries no tag', async () => {
    expect((await invoke({})).excludedImageIds).toContain(1);
  });

  it('excludes a tag-implied image while the viewer still hides that tag', async () => {
    expect((await invoke({})).excludedImageIds).toContain(2);
  });

  // The discriminating cases: a lookup over the wrong values matches nothing, so
  // these two start passing while the two above still hold.
  it('does NOT exclude an image implied by a tag the viewer no longer hides', async () => {
    expect((await invoke({})).excludedImageIds).not.toContain(3);
  });

  it('does NOT exclude an image whose tag is absent from the hidden list', async () => {
    expect((await invoke({})).excludedImageIds).not.toContain(4);
  });

  it('drops every tag-implied image when disableHidden is set, keeping explicit ones', async () => {
    const out = await invoke({}, { disableHidden: 'true' });
    expect(out.excludedTagIds).toEqual([]);
    expect(out.excludedImageIds).toEqual([1]);
  });

  it('appends to caller-supplied ids rather than replacing them', async () => {
    const out = await invoke({ excludedImageIds: [42] });
    expect(out.excludedImageIds?.[0]).toBe(42);
  });
});
