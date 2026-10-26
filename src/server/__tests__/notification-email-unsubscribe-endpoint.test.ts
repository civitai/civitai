import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as EmailService from '~/server/services/notification-email.service';

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  PublicEndpoint: (handler: unknown) => handler,
}));

const { optOut } = vi.hoisted(() => ({ optOut: vi.fn(async () => undefined) }));
vi.mock('~/server/services/notification-email.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailService>()),
  optOutOfNotificationEmail: optOut,
}));

const { getEmailUnsubscribeUrl } = await import('~/server/services/notification-email.service');
const handler = (await import('~/pages/api/notifications/email-unsubscribe'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

const DEAL = 'service-deal-requested';

async function call(method: string, query: Record<string, string>) {
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader: () => res,
    send: () => res,
  } as unknown as NextApiResponse;
  await handler({ method, query, body: {}, headers: {} } as unknown as NextApiRequest, res);
  return statusCode;
}

const validQuery = (userId = 5, type = DEAL) =>
  Object.fromEntries(new URL(getEmailUnsubscribeUrl(userId, type)).searchParams);

beforeEach(() => optOut.mockClear());

describe('email unsubscribe endpoint', () => {
  it('a one-click POST with a valid link opts the user out of that type', async () => {
    expect(await call('POST', validQuery())).toBe(200);
    expect(optOut).toHaveBeenCalledWith(5, DEAL);
  });

  it('a GET (a link scanner, a prefetch) never opts anyone out', async () => {
    expect(await call('GET', validQuery())).toBe(200);
    expect(optOut).not.toHaveBeenCalled();
  });

  it('a link signed for one user cannot opt out another', async () => {
    expect(await call('POST', { ...validQuery(5), u: '6' })).toBe(400);
    expect(optOut).not.toHaveBeenCalled();
  });

  it('a validly signed type that does not email is refused', async () => {
    expect(await call('POST', validQuery(5, 'new-mention'))).toBe(400);
    expect(optOut).not.toHaveBeenCalled();
  });
});
