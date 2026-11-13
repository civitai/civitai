import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvModule from '../env';

vi.mock('../lib/server/clients/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(() => undefined),
}));

vi.mock('../env', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  mainAppUrl: 'http://main.test',
  mainAppWebhookToken: 'tok&n',
}));

import { dispatchEmail } from './email';

const realFetch = global.fetch;
let calls: { url: string; body: any }[] = [];
let fetchImpl: () => Promise<Response>;

beforeEach(() => {
  calls = [];
  fetchImpl = async () => new Response('{}', { status: 200 });
  global.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return fetchImpl();
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('dispatchEmail', () => {
  it('hands a deal notification and its new recipients to the main app', async () => {
    await dispatchEmail('service-deal-requested', { dealId: 7 }, [10, 20]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'http://main.test/api/internal/notifications/send-email?token=tok%26n'
    );
    expect(calls[0]!.body).toEqual({
      type: 'service-deal-requested',
      details: { dealId: 7 },
      userIds: [10, 20],
    });
  });

  it('makes no call for a type that does not email', async () => {
    await dispatchEmail('new-mention', {}, [10]);
    expect(calls).toHaveLength(0);
  });

  it('makes no call when the notification reached nobody new (a repeated key)', async () => {
    await dispatchEmail('service-deal-requested', { dealId: 7 }, []);
    expect(calls).toHaveLength(0);
  });

  it('splits a large fan-out into requests the endpoint accepts', async () => {
    const users = Array.from({ length: 2500 }, (_, i) => i + 1);
    await dispatchEmail('service-deal-requested', {}, users);
    expect(calls.map((c) => c.body.userIds.length)).toEqual([1000, 1000, 500]);
    expect(calls.flatMap((c) => c.body.userIds)).toEqual(users);
  });

  it('never throws into the fan-out loop', async () => {
    fetchImpl = async () => {
      throw new Error('main app down');
    };
    await expect(dispatchEmail('service-deal-requested', {}, [10])).resolves.toBeUndefined();
  });
});
