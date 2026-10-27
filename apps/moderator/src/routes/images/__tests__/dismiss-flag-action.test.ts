import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageModeration from '$lib/server/image-moderation.service';

/**
 * Every image queue posts to the same `[slug]` route, and the page gate is decided per path. So the
 * action itself must refuse to dismiss from any queue but the CSAM one.
 */

const { dismissFromCsamQueue } = vi.hoisted(() => ({ dismissFromCsamQueue: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Pulls in `$app/server`, which only resolves inside a SvelteKit build.
vi.mock('$lib/server/user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageModeration>()),
  dismissFromCsamQueue,
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
  dismissFromCsamQueue.mockResolvedValue(true);
});

describe('dismissFlag', () => {
  it('refuses from any other queue', async () => {
    const result = await dismiss('minor');

    expect(result).toMatchObject({ status: 403 });
    expect(dismissFromCsamQueue).not.toHaveBeenCalled();
  });

  it('dismisses from its own queue, as the acting moderator', async () => {
    const result = await dismiss('csam');

    expect(result).toEqual({ success: true, imageId: 52 });
    expect(dismissFromCsamQueue).toHaveBeenCalledWith({ imageId: 52, userId: 7 });
  });

  it('says so when there was nothing to dismiss', async () => {
    dismissFromCsamQueue.mockResolvedValue(false);

    const result = await dismiss('csam');

    expect(result).toMatchObject({ status: 409 });
  });
});
