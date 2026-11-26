import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { decidePayoutReview } = await import('../user-actions.service');

let calls: { url: string; init: RequestInit }[];
let respond: () => Response;

const INPUT = {
  id: 7,
  userId: 990100034,
  period: '2026-10',
  action: 'clear' as const,
  version: 3,
  note: 'Verified with the creator',
};

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  respond = () => new Response(JSON.stringify({ id: 7, status: 'cleared', version: 4 }));
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

describe('decidePayoutReview', () => {
  it('posts to the existing admin decision route as the moderator, with the read version', async () => {
    const result = await decidePayoutReview(INPUT);

    expect(result).toEqual({ ok: true, body: { id: 7, status: 'cleared', version: 4 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/admin/creator-program-payout-review');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual(INPUT);
  });

  it('carries a 409 back as a status the page can tell apart', async () => {
    respond = () =>
      new Response(JSON.stringify({ error: 'Review 7 changed since version 3; read it again' }), {
        status: 409,
      });

    const result = await decidePayoutReview(INPUT);

    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});
