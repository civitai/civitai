import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The bulk form of `dismissFlag`: same per-queue refusal, and the service decides the rest. */

const { dismissUserFromCsamQueue } = vi.hoisted(() => ({ dismissUserFromCsamQueue: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
// Pulls in `$app/server`, which only resolves inside a SvelteKit build.
vi.mock('$lib/server/user-actions.service', () => ({ setImageFlag: vi.fn() }));
vi.mock('$lib/server/image-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/image-moderation.service')>()),
  dismissUserFromCsamQueue,
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

const post = (
  slug: string,
  fields: Record<string, string> = { userId: '40', expectedCount: '3', version: 'v1' }
) =>
  actions.dismissUserFlags({
    request: request(fields),
    locals: { user: { id: 7 } },
    params: { slug },
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  dismissUserFromCsamQueue.mockResolvedValue({ ok: true, dismissed: 3, remaining: 0 });
});

describe('dismissUserFlags', () => {
  it('refuses from any other queue', async () => {
    expect(await post('minor')).toMatchObject({ status: 403 });
    expect(dismissUserFromCsamQueue).not.toHaveBeenCalled();
  });

  it('refuses without the count the moderator confirmed', async () => {
    expect(await post('csam', { userId: '40', version: 'v1' })).toMatchObject({ status: 400 });
    expect(dismissUserFromCsamQueue).not.toHaveBeenCalled();
  });

  it('refuses without the version the moderator was shown', async () => {
    expect(await post('csam', { userId: '40', expectedCount: '3' })).toMatchObject({ status: 400 });
    expect(dismissUserFromCsamQueue).not.toHaveBeenCalled();
  });

  it('dismisses as the acting moderator, for the count and version shown', async () => {
    expect(await post('csam')).toMatchObject({ success: true });
    expect(dismissUserFromCsamQueue).toHaveBeenCalledWith({
      userId: 40,
      expectedCount: 3,
      version: 'v1',
      moderatorId: 7,
    });
  });

  it('reports a missing table as unavailable, not as a changed queue', async () => {
    dismissUserFromCsamQueue.mockResolvedValue({ ok: false, reason: 'unavailable' });
    expect(await post('csam')).toMatchObject({ status: 503 });
  });

  it('reports a changed queue as a conflict', async () => {
    dismissUserFromCsamQueue.mockResolvedValue({ ok: false, reason: 'changed' });
    expect(await post('csam')).toMatchObject({ status: 409 });
  });
});
