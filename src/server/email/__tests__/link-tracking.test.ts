import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as ClickhouseClient from '~/server/clickhouse/client';

const INTERNAL_TOKEN = 'internal-token-for-tests-0123456789';
const h = vi.hoisted(() => {
  process.env.AUTH_INTERNAL_TOKEN = 'internal-token-for-tests-0123456789';
  return { insert: vi.fn<(arg: unknown) => Promise<void>>(async () => undefined) };
});

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { insert: h.insert },
}));
vi.mock('@civitai/next-axiom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withAxiom: (handler: unknown) => handler,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instrumentApiResponse: () => undefined,
}));

// A production-shaped origin; getBaseUrl reads NEXTAUTH_URL when called.
setEnv({ NEXTAUTH_URL: 'https://civitai.com' });

const { getEmailClickUrl, trackEmailLinks, verifyEmailClick } = await import(
  '~/server/email/link-tracking'
);
const { signEmailLink } = await import('~/server/email/link-signing');
const { handleEmailClick } = await import('~/pages/api/email/click');
const emailEventsRoute = (await import('~/pages/api/internal/email-events')).default;

const SEND_ID = '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b';
const ctx = {
  sendId: SEND_ID,
  template: 'trainingComplete',
  mailClass: 'transactional' as const,
  campaign: 'camp',
  variant: 'b',
  userId: 42,
};
const click = { ...ctx, position: 2, to: '/models/7?tab=x#y' };
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);
const inserted = () =>
  h.insert.mock.calls.flatMap(([arg]) => (arg as { values: Record<string, unknown>[] }).values);

beforeEach(() => h.insert.mockClear());

describe('trackEmailLinks', () => {
  const hrefs = (html: string) =>
    [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));

  it('rewrites each same-site link, numbered in order, and leaves every other link as it was', () => {
    const html = [
      '<a href="https://civitai.com/models/1?a=1&amp;b=2">one</a>',
      '<a href="mailto:hello@civitai.com">mail</a>',
      '<a href="https://discord.gg/civitai">discord</a>',
      '<a class="em-btn" href="/images/2">two</a>',
      '<a href="https://civitai.com/api/notifications/email-unsubscribe?u=1&amp;t=x&amp;s=y">unsub</a>',
      '<a href="https://civitai.com/api/notifications/digest-click?u=1">digest</a>',
      '<a href="https://civitai.com.evil.example/x">lookalike</a>',
    ].join('');
    const out = hrefs(trackEmailLinks(html, ctx));
    const clicks = out
      .filter((h) => h.startsWith('https://civitai.com/api/email/click?'))
      .map((h) => verifyEmailClick(queryOf(h)));
    expect(clicks).toEqual([
      { ...ctx, position: 1, to: '/models/1?a=1&b=2' },
      { ...ctx, position: 2, to: '/images/2' },
    ]);
    expect(out.slice(1, 3)).toEqual(['mailto:hello@civitai.com', 'https://discord.gg/civitai']);
    expect(out.slice(4)).toEqual([
      'https://civitai.com/api/notifications/email-unsubscribe?u=1&t=x&s=y',
      'https://civitai.com/api/notifications/digest-click?u=1',
      'https://civitai.com.evil.example/x',
    ]);
  });

  it('reads an href as a browser does: `&amp;not` is `&not`, never the ¬ sign', () => {
    const out = hrefs(trackEmailLinks('<a href="/a?x=1&amp;notify=2&amp;region=3">x</a>', ctx));
    expect(verifyEmailClick(queryOf(out[0]!))?.to).toBe('/a?x=1&notify=2&region=3');
  });

  it('leaves every link as it is when the send tags would not verify (an overlong campaign)', () => {
    const html = '<a href="/a">x</a>';
    expect(trackEmailLinks(html, { ...ctx, campaign: 'c'.repeat(201) })).toBe(html);
    expect(trackEmailLinks(html, { ...ctx, userId: -1 })).toBe(html);
    expect(trackEmailLinks(html, { ...ctx, sendId: 'not-a-uuid' })).toBe(html);
    // Positive control: the same link with valid tags is rewritten.
    expect(trackEmailLinks(html, ctx)).not.toBe(html);
  });

  it('counts from the position a template reserves', () => {
    const out = hrefs(trackEmailLinks('<a href="/a">x</a><a href="/b">y</a>', ctx, 101));
    expect(out.map((h) => verifyEmailClick(queryOf(h))?.position)).toEqual([101, 102]);
  });

  it('escapes the rewritten href, so the attribute stays one attribute', () => {
    const out = trackEmailLinks('<a href="/a">x</a>', ctx);
    expect(out).toMatch(/^<a href="https:\/\/civitai\.com\/api\/email\/click\?e=[^"]*&amp;k=/);
    expect(out).toMatch(/">x<\/a>$/);
  });
});

describe('verifyEmailClick', () => {
  it('reads back exactly the click it signed', () => {
    expect(verifyEmailClick(queryOf(getEmailClickUrl(click)))).toEqual(click);
  });

  it.each([
    ['another send', { e: '1b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b' }],
    ['another template', { k: 'trainingFail' }],
    ['another class', { m: 'lifecycle' }],
    ['another campaign', { c: 'other' }],
    ['another variant', { v: 'a' }],
    ['another user', { u: '43' }],
    ['another position', { p: '3' }],
    ['another destination', { to: '/models/8' }],
    ['a forged signature', { s: '0'.repeat(32) }],
    ['no signature', { s: '' }],
    ['a malformed send id', { e: 'not-a-uuid' }],
    ['an uppercased send id', { e: SEND_ID.toUpperCase() }],
    ['position 0', { p: '0' }],
    ['an unknown class', { m: 'marketing' }],
  ])('a link edited to name %s is refused', (_, edit) => {
    expect(verifyEmailClick({ ...queryOf(getEmailClickUrl(click)), ...edit })).toBeNull();
  });

  it('a repeated parameter (an array) is refused', () => {
    const q = queryOf(getEmailClickUrl(click));
    expect(verifyEmailClick({ ...q, to: [q.to, '/x'] })).toBeNull();
  });

  it('refuses to sign a link off the site', () => {
    expect(() => getEmailClickUrl({ ...click, to: 'https://evil.example/' })).toThrow();
  });
});

type Result = { status: number; location?: string; insertsAtRedirect: number };
async function clickVia(query: Record<string, unknown>, method = 'GET'): Promise<Result> {
  const result: Result = { status: 0, insertsAtRedirect: -1 };
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
      return res;
    },
    redirect(code: number, to: string) {
      result.status = code;
      result.location = to;
      result.insertsAtRedirect = h.insert.mock.calls.length;
      return res;
    },
  } as unknown as NextApiResponse;
  await handleEmailClick(
    // No session or cookie: everything comes from the link.
    { method, query, headers: { 'user-agent': 'TestMail/1.0' } } as unknown as NextApiRequest,
    res
  );
  expect(headers['Cache-Control']).toBe('no-store');
  return result;
}

describe('the email click route', () => {
  it('records the click the link names, then redirects to its path', async () => {
    const result = await clickVia(queryOf(getEmailClickUrl(click)));
    expect(result).toEqual({ status: 302, location: '/models/7?tab=x#y', insertsAtRedirect: 1 });
    expect(h.insert.mock.calls[0]![0]).toMatchObject({
      table: 'emailEvents',
      format: 'JSONEachRow',
      clickhouse_settings: { input_format_skip_unknown_fields: 1 },
    });
    expect(inserted()).toEqual([
      {
        time: expect.any(String),
        event: 'click',
        sendId: SEND_ID,
        template: 'trainingComplete',
        mailClass: 'transactional',
        campaign: 'camp',
        variant: 'b',
        userId: 42,
        position: 2,
        userAgent: 'TestMail/1.0',
      },
    ]);
  });

  it('a HEAD (a link checker) redirects but records nothing', async () => {
    const result = await clickVia(queryOf(getEmailClickUrl(click)), 'HEAD');
    expect(result.location).toBe('/models/7?tab=x#y');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['another user', { u: '43' }],
    ['another destination', { to: '/models/8' }],
    ['a forged signature', { s: 'f'.repeat(32) }],
  ])('a link edited to name %s records nothing and lands on the home page', async (_, edit) => {
    const result = await clickVia({ ...queryOf(getEmailClickUrl(click)), ...edit });
    expect(result).toMatchObject({ status: 302, location: '/' });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('a link with nothing in it, or an overlong path, lands on the home page', async () => {
    expect(await clickVia({})).toMatchObject({ status: 302, location: '/' });
    const long = { ...queryOf(getEmailClickUrl(click)), to: `/${'a'.repeat(2048)}` };
    expect(await clickVia(long)).toMatchObject({ status: 302, location: '/' });
    expect(h.insert).not.toHaveBeenCalled();
  });

  // Signed with the real key, so only the destination check stands between the link and an
  // off-site redirect.
  it.each([
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example',
    '/.//evil.example/x',
    '/a/..//evil.example',
    '/\t/evil.example',
    'javascript:alert(1)',
    'evil.example',
  ])('never redirects off the site, even for a validly signed %j', async (to) => {
    const fields = [SEND_ID, 'trainingComplete', 'transactional', 'camp', 'b', 42, 2, to];
    const s = signEmailLink(`email-click:${JSON.stringify(fields)}`);
    const result = await clickVia({
      e: SEND_ID,
      k: 'trainingComplete',
      m: 'transactional',
      c: 'camp',
      v: 'b',
      u: '42',
      p: '2',
      to,
      s,
    });
    expect(result).toMatchObject({ status: 302, location: '/' });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('positive control for the case above: the same hand-signed shape with a site path redirects', async () => {
    const to = '/models/7';
    const fields = [SEND_ID, 'trainingComplete', 'transactional', 'camp', 'b', 42, 2, to];
    const s = signEmailLink(`email-click:${JSON.stringify(fields)}`);
    const q = { e: SEND_ID, k: 'trainingComplete', m: 'transactional', c: 'camp', v: 'b' };
    const result = await clickVia({ ...q, u: '42', p: '2', to, s });
    expect(result).toMatchObject({ status: 302, location: '/models/7' });
  });

  it('a failed insert still redirects to the link', async () => {
    h.insert.mockRejectedValueOnce(new Error('table missing'));
    const result = await clickVia(queryOf(getEmailClickUrl(click)));
    expect(result).toMatchObject({ status: 302, location: '/models/7?tab=x#y' });
  });
});

describe('the internal send-row route', () => {
  const row = {
    sendId: SEND_ID,
    sentAt: new Date().toISOString(),
    template: 'verification',
    mailClass: 'transactional',
    campaign: '',
    variant: '',
    userId: 0,
  };
  async function post(body: unknown, auth?: string, method = 'POST') {
    let status = 0;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json: () => res,
      end: () => res,
    } as unknown as NextApiResponse;
    const req = {
      method,
      url: '/api/internal/email-events',
      query: {},
      body,
      headers: auth === undefined ? {} : { authorization: `Bearer ${auth}` },
    };
    await emailEventsRoute(req as unknown as NextApiRequest, res);
    return status;
  }

  it('refuses a call with no credential, or the wrong one, and writes nothing', async () => {
    expect(await post({ sends: [row] })).toBe(401);
    expect(await post({ sends: [row] }, 'wrong')).toBe(401);
    expect(await post({ sends: [row] }, `${INTERNAL_TOKEN}x`)).toBe(401);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('writes each send row the service credential presents, as a send row', async () => {
    expect(await post({ sends: [row] }, INTERNAL_TOKEN)).toBe(204);
    expect(inserted()).toEqual([
      {
        time: expect.any(String),
        event: 'send',
        sendId: SEND_ID,
        template: 'verification',
        mailClass: 'transactional',
        campaign: '',
        variant: '',
        userId: 0,
      },
    ]);
  });

  it.each([
    ['no rows', { sends: [] }],
    ['a field beyond the tags (an address)', { sends: [{ ...row, to: 'a@b.test' }] }],
    ['a malformed send id', { sends: [{ ...row, sendId: 'x' }] }],
    ['an uppercased send id', { sends: [{ ...row, sendId: SEND_ID.toUpperCase() }] }],
    ['a bad class', { sends: [{ ...row, mailClass: 'marketing' }] }],
    ['too many rows', { sends: Array.from({ length: 51 }, () => row) }],
    ['no body', undefined],
  ])('refuses %s', async (_, body) => {
    expect(await post(body, INTERNAL_TOKEN)).toBe(400);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('only takes POST', async () => {
    expect(await post({ sends: [row] }, INTERNAL_TOKEN, 'GET')).toBe(405);
  });

  it('a send time far from now is recorded as now', async () => {
    await post({ sends: [{ ...row, sentAt: '2001-01-01T00:00:00.000Z' }] }, INTERNAL_TOKEN);
    expect(String(inserted()[0]!.time).slice(0, 4)).toBe(String(new Date().getUTCFullYear()));
  });
});
