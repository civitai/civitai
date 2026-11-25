import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { sendEmail } from '~/server/email/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn(), isEmailConfigured: () => true }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { systemEmailNotificationTypes } = await import('~/server/notifications/utils.notifications');
const { clearNotificationEmailEnabledCache, getEmailUnsubscribeUrl, sendNotificationEmails } =
  await import('~/server/services/notification-email.service');
const unsubscribe = (await import('~/pages/api/notifications/email-unsubscribe'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const { verifyEmailClick } = await import('~/server/email/link-tracking');
const { decode: decodeHtml } = await import('he');

/** Where a tracked link leads: the site path its signed click redirect sends the reader to. */
const leadsTo = (href: string) => {
  const url = new URL(decodeHtml(href));
  expect(url.pathname).toBe('/api/email/click');
  return verifyEmailClick(Object.fromEntries(url.searchParams))?.to;
};
/** Every tracked link's destination, in order. */
const linksIn = (html: string) =>
  [...html.matchAll(/href="([^"]+\/api\/email\/click\?[^"]+)"/g)].map(([, href]) => leadsTo(href!));
/** The button's destination and label. */
const buttonIn = (html: string) => {
  const m = html.match(/<a class="em-btn" href="([^"]+)"[^>]*>([^<]*)<\/a>/);
  return m ? { to: leadsTo(m[1]!), label: m[2] } : null;
};

/** The app-review outcomes an app developer is emailed about the moment they happen. */
const APP_REVIEW_TYPES = [
  'app-block-approved',
  'app-block-rejected',
  'app-listing-rejected',
  'app-listing-reset-to-pending',
  'app-access-request-approved',
  'app-access-request-declined',
];

// Who gets mailed is decided in SQL (the opt-out NOT EXISTS), so the opt-out case runs against an
// in-process Postgres carrying the real migration rather than a mocked client.
const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "email" text, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
  `);
  await db.pg.exec(
    readFileSync(
      path.join(MIGRATIONS, '20261203120000_user_email_notification_opt_out', 'migration.sql'),
      'utf8'
    )
  );
  const raw = pgliteRaw(db.pg);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  vi.mocked(sendEmail).mockReset();
  clearNotificationEmailEnabledCache();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ key: 'k', value: true } as never);
  // The send caps count on the cache cluster (SET NX EX + INCR in one MULTI): every cap reads 1.
  redisMock.redis.multi.mockImplementation((() => {
    const chain = { set: () => chain, incr: () => chain, exec: async () => ['OK', 1] };
    return chain;
  }) as never);
  await db.pg.exec(`
    TRUNCATE "UserEmailNotificationOptOut";
    DELETE FROM "User";
    INSERT INTO "User" VALUES (1, 'one@example.com', NULL, NULL), (2, 'two@example.com', NULL, NULL);
  `);
});

const mailedTo = () =>
  vi
    .mocked(sendEmail)
    .mock.calls.map(([mail]) => mail.to)
    .sort();

async function post(query: Record<string, string>) {
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader: () => res,
    send: () => res,
  } as unknown as NextApiResponse;
  await unsubscribe(
    { method: 'POST', query, body: {}, headers: {} } as unknown as NextApiRequest,
    res
  );
  return statusCode;
}

describe('app-review notifications send email', () => {
  it('each one has an email control in settings, though it has no on-site toggle', () => {
    expect(systemEmailNotificationTypes.map((t) => t.type).sort()).toEqual(
      [...APP_REVIEW_TYPES].sort()
    );
  });

  it.each([
    ['app-block-rejected', 'Your app "Pixel Pal" was not approved: Spends Buzz without asking'],
    ['app-listing-rejected', '"Pixel Pal" was not approved: Spends Buzz without asking'],
    [
      'app-listing-reset-to-pending',
      '"Pixel Pal" was sent back for another review by a moderator: Spends Buzz without asking',
    ],
  ])('a %s email carries the reason and an absolute link', async (type, sentence) => {
    const outcome = await sendNotificationEmails({
      type,
      details: { slug: 'pixel-pal', name: 'Pixel Pal', reason: 'Spends Buzz without asking' },
      userIds: [1],
    });
    expect(outcome.sent).toBe(1);
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.to).toBe('one@example.com');
    expect(mail.text).toContain(sentence);
    expect(mail.text).toContain('View on Civitai: http://localhost:3000/apps/build?view=apps');
    expect(mail.html).toContain('Spends Buzz without asking');
    expect(linksIn(mail.html)).toContain('/apps/build?view=apps');
  });

  it('the approved email says the app was approved and opens its run page', async () => {
    const outcome = await sendNotificationEmails({
      type: 'app-block-approved',
      details: {
        slug: 'pixel-pal',
        name: 'Pixel Pal',
        version: '1.0.0',
        hasPage: true,
        canOpenRunPage: true,
      },
      userIds: [1],
    });
    expect(outcome.sent).toBe(1);
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.subject).toBe('App approved');
    const sentence = 'Your app "Pixel Pal" was approved and will be live in a few minutes.';
    expect(mail.text).toContain(sentence);
    expect(mail.text).toContain('Open your app: http://localhost:3000/apps/run/pixel-pal');
    expect(mail.html).toContain(sentence.replace(/"/g, '&quot;'));
    expect(buttonIn(mail.html)).toEqual({ to: '/apps/run/pixel-pal', label: 'Open your app' });
    expect(mail.html).not.toContain('View on Civitai');
    expect(mail.html).toContain('<h1 class="em-h1"');
    // One-click unsubscribe is unchanged.
    expect(mail.headers).toEqual({
      'List-Unsubscribe': `<${getEmailUnsubscribeUrl(1, 'app-block-approved')}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('🔴 a submitter outside the run-page rollout gets "View on Civitai" to the submissions view', async () => {
    const outcome = await sendNotificationEmails({
      type: 'app-block-approved',
      details: {
        slug: 'pixel-pal',
        name: 'Pixel Pal',
        version: '1.0.0',
        hasPage: true,
        canOpenRunPage: false,
      },
      userIds: [1],
    });
    expect(outcome.sent).toBe(1);
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.text).toContain('View on Civitai: http://localhost:3000/apps/build?view=apps');
    expect(buttonIn(mail.html)).toEqual({ to: '/apps/build?view=apps', label: 'View on Civitai' });
    expect(linksIn(mail.html).filter((to) => to?.startsWith('/apps/run/'))).toEqual([]);
    expect(mail.html).not.toContain('/apps/run/');
    expect(mail.html).not.toContain('Open your app');
  });

  it('a user who used the one-click unsubscribe gets no more of that email', async () => {
    const link = new URL(getEmailUnsubscribeUrl(1, 'app-block-rejected'));
    expect(await post(Object.fromEntries(link.searchParams))).toBe(200);

    await sendNotificationEmails({
      type: 'app-block-rejected',
      details: { slug: 'pixel-pal', reason: 'Broken build' },
      userIds: [1, 2],
    });
    expect(mailedTo()).toEqual(['two@example.com']);

    // The opt-out is per type: the same user still gets the approval.
    vi.mocked(sendEmail).mockReset();
    await sendNotificationEmails({
      type: 'app-block-approved',
      details: { slug: 'pixel-pal' },
      userIds: [1],
    });
    expect(mailedTo()).toEqual(['one@example.com']);
  });
});
