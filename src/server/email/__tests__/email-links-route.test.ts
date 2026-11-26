import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';

const INTERNAL_TOKEN = 'internal-token-for-tests-0123456789';
const h = vi.hoisted(() => ({
  token: 'internal-token-for-tests-0123456789' as string | undefined,
}));

// The route reads AUTH_INTERNAL_TOKEN per request; the real loader memoizes, so it is stubbed here.
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAuthEnv: () => ({ AUTH_INTERNAL_TOKEN: h.token }),
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

const emailLinksRoute = (await import('~/pages/api/internal/email-links')).default;
const { verifyEmailClick } = await import('~/server/email/link-tracking');

const SEND_ID = '0b6f3d4e-8f7a-4c1e-9d2b-5a6c7e8f9a0b';
const send = {
  sendId: SEND_ID,
  template: 'appealResolution',
  mailClass: 'transactional',
  campaign: 'camp',
  variant: 'b',
  userId: 42,
};

async function post(body: unknown, auth?: string, method = 'POST') {
  let status = 0;
  let json: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      json = value;
      return res;
    },
    end: () => res,
    setHeader: () => res,
  } as unknown as NextApiResponse;
  const req = {
    method,
    url: '/api/internal/email-links',
    query: {},
    body,
    headers: auth === undefined ? {} : { authorization: `Bearer ${auth}` },
  };
  await emailLinksRoute(req as unknown as NextApiRequest, res);
  return { status, links: (json as { links?: string[] } | undefined)?.links };
}

const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

beforeEach(() => {
  h.token = INTERNAL_TOKEN;
});

describe('the internal email-links route', () => {
  it('refuses a call with no credential, or the wrong one', async () => {
    const body = { ...send, links: ['https://civitai.com/images/1'] };
    expect((await post(body)).status).toBe(401);
    expect((await post(body, 'wrong')).status).toBe(401);
    expect((await post(body, `${INTERNAL_TOKEN}x`)).status).toBe(401);
  });

  it('refuses every call while AUTH_INTERNAL_TOKEN is unset or blank here', async () => {
    const body = { ...send, links: ['https://civitai.com/images/1'] };
    h.token = undefined;
    expect((await post(body, INTERNAL_TOKEN)).status).toBe(503);
    h.token = '  ';
    expect((await post(body, '  ')).status).toBe(503);
  });

  it('only takes POST', async () => {
    expect((await post({ ...send, links: ['/x'] }, INTERNAL_TOKEN, 'GET')).status).toBe(405);
  });

  it('signs each same-site link, numbered in order, and returns every other link as given', async () => {
    const links = [
      'https://civitai.com/images/1?a=1&amp;b=2',
      'https://red.example/images/2',
      'https://civitai.com/api/notifications/email-unsubscribe?u=1',
      'https://civitai.com/content/tos',
    ];
    const { status, links: out } = await post({ ...send, links }, INTERNAL_TOKEN);
    expect(status).toBe(200);
    expect(out).toHaveLength(4);
    expect(out![1]).toBe(links[1]);
    expect(out![2]).toBe(links[2]);
    // Each signed link verifies at the click route, naming this send and its own destination.
    expect(verifyEmailClick(queryOf(out![0]!))).toEqual({
      ...send,
      position: 1,
      to: '/images/1?a=1&b=2',
    });
    expect(verifyEmailClick(queryOf(out![3]!))).toEqual({
      ...send,
      position: 2,
      to: '/content/tos',
    });
    expect(out![0]!.startsWith('https://civitai.com/api/email/click?')).toBe(true);
  });

  it.each([
    ['another host', 'https://evil.example/x'],
    ['a look-alike host', 'https://civitai.com.evil.example/x'],
    ['a protocol-relative link', '//evil.example/x'],
    ['a backslash path', '/\\evil.example/x'],
    ['credentials before the host', 'https://civitai.com@evil.example/x'],
    ['plain http to our host', 'http://civitai.com/x'],
  ])('returns %s unsigned (no open redirect)', async (_, link) => {
    const { status, links } = await post({ ...send, links: [link] }, INTERNAL_TOKEN);
    expect(status).toBe(200);
    expect(links).toEqual([link]);
  });

  const ok = { ...send, links: ['https://civitai.com/images/1'] };
  it.each([
    ['a field beyond the send (an address)', { ...ok, to: 'a@b.test' }],
    ['a mailto: link (an address)', { ...ok, links: ['mailto:a@b.test'] }],
    ['a javascript: link', { ...ok, links: ['javascript:alert(1)'] }],
    ['no links', { ...ok, links: [] }],
    ['too many links', { ...ok, links: Array.from({ length: 51 }, () => '/x') }],
    ['an overlong link', { ...ok, links: [`/${'a'.repeat(2048)}`] }],
    ['a malformed send id', { ...ok, sendId: 'x' }],
    ['an uppercased send id', { ...ok, sendId: SEND_ID.toUpperCase() }],
    ['no mail class', { ...ok, mailClass: '' }],
    ['a bad mail class', { ...ok, mailClass: 'marketing' }],
    ['a negative user id', { ...ok, userId: -1 }],
    ['a missing tag', { ...ok, campaign: undefined }],
    ['no body', undefined],
  ])('refuses %s', async (_, body) => {
    expect(await post(body, INTERNAL_TOKEN)).toEqual({ status: 400, links: undefined });
  });
});
