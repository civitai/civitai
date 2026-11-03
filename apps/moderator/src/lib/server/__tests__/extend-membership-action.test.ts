import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `extendMembership` / `previewMembershipExtension` — the spoke half of the membership extension.
 *
 * It relays the moderator's session (the main app records WHO extended), waits long enough for the
 * Stripe calls behind the endpoint, and never reports a lost answer as a clean failure: the extension
 * may have landed, and the operator's next move is to preview again, not to retry.
 */

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const {
  extendMembership,
  previewMembershipExtension,
  EXTEND_OUTCOME_UNKNOWN,
  setMembershipCancel,
  previewMembershipCancel,
  CANCEL_OUTCOME_UNKNOWN,
  resyncMembership,
  RESYNC_OUTCOME_UNKNOWN,
} = await import('../user-actions.service');

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response | Promise<Response>;

const INPUT = {
  userId: 8675309,
  days: 3,
  reason: 'Ticket 123: three days instead of a refund',
  expectedCurrentPeriodEnd: 1795314120,
};
const RESULT = {
  ok: true,
  days: 3,
  trialEnd: '2026-11-25T02:22:00.000Z',
  mode: 'renewing',
  before: { id: 'sub_x' },
  after: { id: 'sub_x' },
  newInvoiceId: 'in_zero',
  problems: [],
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  calls = [];
  respond = () => new Response(JSON.stringify(RESULT), { status: 200 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  });
});

describe('extendMembership', () => {
  it('posts to /api/mod/user/membership-extend as the moderator, with exactly the endpoint fields', async () => {
    await extendMembership(INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/membership-extend');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(calls[0].url).not.toContain('token=');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(INPUT);
  });

  it('waits 120 s for the endpoint: four Stripe calls can sit behind it', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await extendMembership(INPUT);
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it('hands back a post-check failure (200, ok: false) as the result, not as an error', async () => {
    respond = () =>
      new Response(JSON.stringify({ ...RESULT, ok: false, problems: ['charged'] }), {
        status: 200,
      });
    expect(await extendMembership(INPUT)).toEqual({
      ok: true,
      result: { ...RESULT, ok: false, problems: ['charged'] },
    });
  });

  it.each([
    ['a timeout', () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))],
    ['a 502', () => new Response('bad gateway', { status: 502 })],
    ['a 524 (the proxy gave up)', () => new Response('', { status: 524 })],
    ['a 200 that is not a result', () => new Response('{}', { status: 200 })],
  ])('%s reads as outcome unknown, never as not extended', async (_label, reply) => {
    respond = reply as () => Response;
    expect(await extendMembership(INPUT)).toEqual({ ok: false, error: EXTEND_OUTCOME_UNKNOWN });
  });

  it("a refusal (409 stale preview) shows the endpoint's own words", async () => {
    respond = () =>
      new Response(
        // The main app's 4xx envelope: `error` carries the message (restErrorBody).
        JSON.stringify({
          error: 'The membership changed since the preview',
          message: 'The membership changed since the preview',
        }),
        { status: 409 }
      );
    const r = await extendMembership(INPUT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/changed since the preview/);
    expect(!r.ok && r.error).not.toBe(EXTEND_OUTCOME_UNKNOWN);
  });
});

describe('previewMembershipExtension', () => {
  it('reads with a GET as the moderator, the inputs in the query string', async () => {
    respond = () => new Response(JSON.stringify({ problems: [] }), { status: 200 });
    await previewMembershipExtension({ userId: 8675309, days: 3 });
    expect(calls[0].url).toBe(
      'https://civitai.com/api/mod/user/membership-extend-preview?userId=8675309&days=3'
    );
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
  });
});

describe('setMembershipCancel / previewMembershipCancel', () => {
  const CANCEL = { userId: 8675309, cancelAtPeriodEnd: false, reason: 'Ticket 123: keep it' };

  it('posts to /api/mod/user/membership-cancel as the moderator, with exactly the endpoint fields', async () => {
    respond = () =>
      new Response(JSON.stringify({ ok: true, changed: true, problems: [] }), { status: 200 });
    await setMembershipCancel(CANCEL);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/membership-cancel');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual(CANCEL);
  });

  it('a 502 reads as outcome unknown', async () => {
    respond = () => new Response('bad gateway', { status: 502 });
    expect(await setMembershipCancel(CANCEL)).toEqual({ ok: false, error: CANCEL_OUTCOME_UNKNOWN });
  });

  it('the preview sends the choice in the query string', async () => {
    respond = () => new Response(JSON.stringify({ problems: [] }), { status: 200 });
    await previewMembershipCancel({ userId: 8675309, cancelAtPeriodEnd: true });
    expect(calls[0].url).toBe(
      'https://civitai.com/api/mod/user/membership-cancel-preview?userId=8675309&cancelAtPeriodEnd=true'
    );
    expect(calls[0].init.method).toBe('GET');
  });
});

describe('resyncMembership', () => {
  const RESYNC = {
    userId: 8675309,
    reason: 'Ticket 123: webhook missed',
    confirmEndBuzzMembership: true,
  };

  it('posts the confirm through to /api/mod/user/membership-resync', async () => {
    respond = () => new Response(JSON.stringify({ ok: true, changes: [] }), { status: 200 });
    expect((await resyncMembership(RESYNC)).ok).toBe(true);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/membership-resync');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(RESYNC);
  });

  it('a 200 that is not a result reads as outcome unknown', async () => {
    respond = () => new Response('{}', { status: 200 });
    expect(await resyncMembership(RESYNC)).toEqual({ ok: false, error: RESYNC_OUTCOME_UNKNOWN });
  });
});
