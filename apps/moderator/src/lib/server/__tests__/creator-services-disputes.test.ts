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

const { listDisputes, listDealFiles, resolveDispute } = await import(
  '../creator-services-disputes.service'
);

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  respond = () => json({});
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

describe('resolveDispute', () => {
  it('posts the deal as the moderator, never with the webhook token', async () => {
    respond = () => json({ status: 'resolved', resolution: 'Refund' });
    await resolveDispute({ dealId: 41, resolution: 'Refund', note: 'no delivery' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/creator-services/resolve-dispute');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(calls[0].url).not.toContain('token=');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      dealId: 41,
      resolution: 'Refund',
      note: 'no delivery',
    });
  });

  it('omits an empty note instead of sending it', async () => {
    respond = () => json({ status: 'resolved', resolution: 'Release' });
    await resolveDispute({ dealId: 41, resolution: 'Release' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ dealId: 41, resolution: 'Release' });
  });

  it('returns the server refusal as refused, keeping its text', async () => {
    respond = () =>
      json({
        status: 'refused',
        reason: 'finals_not_passed',
        message: 'Refund, or clear the file first.',
      });
    expect(await resolveDispute({ dealId: 41, resolution: 'Release' })).toEqual({
      ok: false,
      refused: true,
      message: 'Refund, or clear the file first.',
    });
  });

  it('reads already-resolved as ok and returns the existing resolution, not the one sent', async () => {
    respond = () => json({ status: 'already-resolved', resolution: 'Release' });
    expect(await resolveDispute({ dealId: 41, resolution: 'Refund' })).toEqual({
      ok: true,
      status: 'already-resolved',
      resolution: 'Release',
    });
  });

  it('does not read an unrecognised body as a resolution', async () => {
    respond = () => json({ status: 'resolved' });
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(result.ok).toBe(false);
  });

  it('carries the endpoint refusal text for a missing grant', async () => {
    respond = () =>
      json({ message: 'Needs the "creatorServices.resolveDispute" permission.' }, 403);
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(!result.ok && !result.refused && result.error).toContain(
      'creatorServices.resolveDispute'
    );
  });
});

describe('resolveDispute, lost responses', () => {
  const lostMessage = 'may have gone through';

  it('says the ruling may have gone through on a gateway timeout', async () => {
    respond = () => json({}, 504);
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(!result.ok && !result.refused && result.error).toContain(lostMessage);
  });

  it('says it when the connection dies after the request left', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(!result.ok && !result.refused && result.error).toContain(lostMessage);
  });

  it('does not say it for a refusal that proves nothing happened', async () => {
    respond = () => json({ message: 'Deal is not disputed.' }, 409);
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(!result.ok && !result.refused && result.error).not.toContain(lostMessage);
  });

  it('does not say it when the request never left', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      )
    );
    const result = await resolveDispute({ dealId: 41, resolution: 'Refund' });
    expect(!result.ok && !result.refused && result.error).not.toContain(lostMessage);
  });
});

describe('listDisputes', () => {
  it('GETs with the cursor and limit in the query string and no body', async () => {
    respond = () => json({ items: [], nextCursor: 90 });
    const result = await listDisputes(77, 25);

    expect(calls[0].url).toBe(
      'https://civitai.com/api/mod/creator-services/disputes?cursor=77&limit=25'
    );
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
    expect(result).toEqual({ ok: true, page: { items: [], nextCursor: 90 } });
  });

  it('drops an undefined cursor rather than sending the string "undefined"', async () => {
    respond = () => json({ items: [] });
    await listDisputes(undefined, 25);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/creator-services/disputes?limit=25');
  });

  it('fails on a body without an items array', async () => {
    respond = () => json({ nope: true });
    expect((await listDisputes()).ok).toBe(false);
  });
});

describe('listDealFiles', () => {
  it('GETs the deal id', async () => {
    respond = () => json({ items: [{ id: 5 }] });
    const result = await listDealFiles(41);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/creator-services/deal-files?dealId=41');
    expect(result.ok && result.files).toHaveLength(1);
  });
});
