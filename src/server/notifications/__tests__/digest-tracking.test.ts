import { readFileSync } from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

const h = vi.hoisted(() => ({ insert: vi.fn<(arg: unknown) => Promise<void>>(async () => undefined) }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { insert: h.insert },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));

const { DIGEST_EVENTS_TABLE, digestEventRow, digestTargetPath, getDigestClickUrl, safeSitePath } =
  await import('~/server/notifications/digest-tracking');
const { signEmailLink } = await import('~/server/services/notification-email.service');
const handler = (await import('~/pages/api/notifications/digest-click')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const CYCLE = new Date('2026-11-16T12:00:00.000Z');
const click = {
  userId: 42,
  cycleStartedAt: CYCLE,
  position: 3,
  notificationType: 'new-comment',
  to: '/images/7?tab=comments#c9',
};
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

async function call(query: Record<string, string>, method = 'GET') {
  let location: string | undefined;
  let status = 0;
  let insertsAtRedirect = -1;
  const res = {
    setHeader: () => res,
    redirect(code: number, to: string) {
      status = code;
      location = to;
      insertsAtRedirect = h.insert.mock.calls.length;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler(
    // No session or cookie: the user comes from the link.
    { method, query, headers: { 'user-agent': 'TestMail/1.0' } } as unknown as NextApiRequest,
    res
  );
  return { status, location, insertsAtRedirect };
}

const insertedRows = () =>
  h.insert.mock.calls.flatMap(([arg]) => (arg as { values: Record<string, unknown>[] }).values);

beforeEach(() => h.insert.mockClear());

describe('the digest click endpoint', () => {
  it('records the click for the user and pass in the link, then redirects to the item', async () => {
    const result = await call(queryOf(getDigestClickUrl(click)));
    expect(result).toEqual({
      status: 302,
      location: '/images/7?tab=comments#c9',
      insertsAtRedirect: 1,
    });
    expect(h.insert.mock.calls[0]![0]).toMatchObject({ table: DIGEST_EVENTS_TABLE });
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        event: 'click',
        userId: 42,
        cycleStartedAt: '2026-11-16 12:00:00.000',
        position: 3,
        notificationType: 'new-comment',
        userAgent: 'TestMail/1.0',
        itemCount: 0,
      }),
    ]);
  });

  it('a HEAD (a link checker) redirects but records nothing', async () => {
    const result = await call(queryOf(getDigestClickUrl(click)), 'HEAD');
    expect(result.location).toBe('/images/7?tab=comments#c9');
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['another user', { u: '43' }],
    ['another pass', { c: String(CYCLE.getTime() + 1) }],
    ['another position', { p: '1' }],
    ['another type', { n: 'new-mention' }],
    ['another destination', { to: '/images/8' }],
    ['a forged signature', { s: '0'.repeat(32) }],
    ['no signature', { s: '' }],
  ])(
    'a link edited to name %s records nothing and lands on the notifications page',
    async (_, edit) => {
      const result = await call({ ...queryOf(getDigestClickUrl(click)), ...edit });
      expect(result).toMatchObject({ status: 302, location: '/user/notifications' });
      expect(h.insert).not.toHaveBeenCalled();
    }
  );

  it('a link with nothing in it lands on the notifications page', async () => {
    expect(await call({})).toMatchObject({ status: 302, location: '/user/notifications' });
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
    const fields = [42, CYCLE.getTime(), 3, 'new-comment', to];
    const s = signEmailLink(`notification-digest-click:${JSON.stringify(fields)}`);
    const result = await call({
      u: '42',
      c: String(CYCLE.getTime()),
      p: '3',
      n: 'new-comment',
      to,
      s,
    });
    expect(result).toMatchObject({ status: 302, location: '/user/notifications' });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('a failed insert still redirects to the item', async () => {
    h.insert.mockRejectedValueOnce(new Error('table missing'));
    const result = await call(queryOf(getDigestClickUrl(click)));
    expect(result).toMatchObject({ status: 302, location: '/images/7?tab=comments#c9' });
  });
});

describe('which digest links are tracked', () => {
  it('a site path or a url on this site is tracked; anything off the site is not', () => {
    expect(digestTargetPath('/models/1')).toBe('/models/1');
    expect(digestTargetPath('http://localhost:3000/models/1?v=2')).toBe('/models/1?v=2');
    expect(digestTargetPath('https://elsewhere.example/models/1')).toBeNull();
    expect(digestTargetPath('//elsewhere.example/models/1')).toBeNull();
    expect(digestTargetPath(undefined)).toBeNull();
  });

  it('a link is never minted for a destination off the site', () => {
    expect(safeSitePath('/ok')).toBe('/ok');
    expect(safeSitePath(`/${'a'.repeat(3000)}`)).toBeNull();
    expect(() => getDigestClickUrl({ ...click, to: '//evil.example' })).toThrow();
  });
});

// A row key the table lacks fails the whole insert inside a swallowed catch, so the two are pinned.
describe('notificationDigestEvents row and DDL', () => {
  it('writes exactly the columns the table declares, for every event', () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../clickhouse/migrations/2026-11-24-notification-digest-events.sql'
      ),
      'utf8'
    );
    const open = `${DIGEST_EVENTS_TABLE}\n(`;
    const columns = sql
      .slice(sql.indexOf(open) + open.length, sql.indexOf('\n)\nENGINE'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns.length).toBeGreaterThan(5);
    const at = new Date(CYCLE.getTime() + 1000);
    for (const row of [
      digestEventRow(
        { event: 'send', userId: 1, cycleStartedAt: CYCLE, sentAt: CYCLE, itemCount: 4 },
        at
      ),
      digestEventRow({ ...click, event: 'click', userAgent: 'x' }, at),
      digestEventRow({ event: 'unsubscribe', userId: 1, cycleStartedAt: null }, at),
    ])
      expect(new Set(Object.keys(row))).toEqual(new Set(columns));
  });
});
