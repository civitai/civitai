import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageModeration from '$lib/server/image-moderation.service';

/**
 * Every image queue posts to the same `[slug]` route, and the page gate is decided per path. So the
 * action itself must refuse to clear the review flag from any queue but that flag's own.
 */

const { dismissReviewFlag } = vi.hoisted(() => ({ dismissReviewFlag: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Pulls in `$app/server`, which only resolves inside a SvelteKit build.
vi.mock('$lib/server/user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageModeration>()),
  dismissReviewFlag,
}));

const { actions } = await import('../[slug]/+page.server');

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const dismiss = (slug: string) =>
  actions.dismissFlag({
    request: request({ imageId: '52' }),
    locals: { user: { id: 7 } },
    params: { slug },
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  dismissReviewFlag.mockResolvedValue(true);
});

describe('dismissFlag', () => {
  it('refuses from any other queue', async () => {
    const result = await dismiss('minor');

    expect(result).toMatchObject({ status: 403 });
    expect(dismissReviewFlag).not.toHaveBeenCalled();
  });

  it('clears the flag from its own queue, as the acting moderator', async () => {
    const result = await dismiss('csam');

    expect(result).toEqual({ success: true, imageId: 52 });
    expect(dismissReviewFlag).toHaveBeenCalledWith({ imageId: 52, userId: 7 });
  });

  it('says so when there was nothing to clear', async () => {
    dismissReviewFlag.mockResolvedValue(false);

    const result = await dismiss('csam');

    expect(result).toMatchObject({ status: 409 });
  });
});
