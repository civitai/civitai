import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint } = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/version-showcase.service', () => ({ listFeaturedImages: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ callModEndpoint }));

const { actions } = await import('../+page.server');

type ActionEvent = Parameters<(typeof actions)['remove']>[0];
type Refusal = { status: number; data: { error: string } };
const remove = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const event = {
    request: new Request('http://x/models/version-showcases', { method: 'POST', body }),
  };
  return actions.remove(event as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { removed: true } });
});

describe('removing a featured image from a model showcase', () => {
  it('sends the version and image to the main app', async () => {
    expect(await remove({ modelVersionId: '10', imageId: '77' })).toEqual({ success: true });
    expect(callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'version-showcase/remove',
      { modelVersionId: 10, imageId: 77 },
      'Remove from showcase'
    );
  });

  it('refuses a request without an image, before calling the main app', async () => {
    const refused = (await remove({ modelVersionId: '10' })) as unknown as Refusal;
    expect(refused.status).toBe(400);
    expect(callModEndpoint).not.toHaveBeenCalled();
  });

  it('shows the main app refusing', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'Remove from showcase returned 403.' });
    const refused = (await remove({ modelVersionId: '10', imageId: '77' })) as unknown as Refusal;
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe('Remove from showcase returned 403.');
  });
});
