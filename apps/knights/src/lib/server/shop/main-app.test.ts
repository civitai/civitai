import { describe, expect, it, vi } from 'vitest';
import { MainAppRejectedError, mainAppPort } from './main-app';

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
const port = (fetcher: typeof fetch) =>
  mainAppPort({ baseUrl: 'https://main.example/', token: 'secret' }, fetcher);
const grant = { userId: 7, tier: 'silver', days: 7, key: 'knights-shop:abc' };

describe('the main app port', () => {
  it('posts the membership grant with the webhook token and reads the outcome', async () => {
    const fetcher = answer(200, { outcome: 'already' });

    expect(await port(fetcher as never).grantMembership(grant)).toEqual({ outcome: 'already' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://main.example/api/mod/knights/shop/membership');
    expect((init.headers as Record<string, string>)['x-webhook-token']).toBe('secret');
    expect(JSON.parse(String(init.body))).toEqual(grant);
  });

  it('treats a 409 as a refusal for good, carrying the reason and the wording', async () => {
    const error = await port(answer(409, { error: 'queue is full', reason: 'queue-full' }) as never)
      .grantMembership(grant)
      .catch((e) => e);

    expect(error).toBeInstanceOf(MainAppRejectedError);
    expect([error.status, error.reason, error.detail]).toEqual([
      409,
      'queue-full',
      'queue is full',
    ]);
  });

  it.each([400, 422])('treats a %s as a refusal for good', async (status) => {
    const error = await port(answer(status, {}) as never)
      .grantMembership(grant)
      .catch((e) => e);

    expect(error).toBeInstanceOf(MainAppRejectedError);
    expect(error.status).toBe(status);
  });

  it.each([401, 403, 404, 408, 429, 500, 502])(
    'treats a %s as unknown, to retry',
    async (status) => {
      const error = await port(answer(status, {}) as never)
        .grantMembership(grant)
        .catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MainAppRejectedError);
    }
  );

  it('refuses an outcome it does not know instead of calling the grant done', async () => {
    await expect(
      port(answer(200, { outcome: 'maybe' }) as never).grantMembership(grant)
    ).rejects.toThrow(/does not know/);
  });

  it('sends cosmetic actions to the cosmetics endpoint', async () => {
    const fetcher = answer(200, { ok: true });
    const main = port(fetcher as never);
    await main.refreshCosmetics(7);
    await main.equipCosmetic(7, 5);
    await main.unequipCosmetic(7, 5);

    const bodies = fetcher.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body))
    );
    expect(bodies).toEqual([
      { action: 'refresh', userId: 7 },
      { action: 'equip', userId: 7, cosmeticId: 5 },
      { action: 'unequip', userId: 7, cosmeticId: 5 },
    ]);
  });
});
