import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('~/env/server', () => ({ env }));

const FULL_ENV = {
  NOW_PAYMENTS_API_URL: 'https://nowpayments.test',
  NOW_PAYMENTS_API_KEY: 'api-key',
  NOW_PAYMENTS_IPN_KEY: 'ipn-secret',
  COINBASE_API_URL: 'https://coinbase.test',
  COINBASE_API_KEY: 'api-key',
  EMERCHANTPAY_WPF_URL: 'https://emerchantpay.test',
  EMERCHANTPAY_USERNAME: 'user',
  EMERCHANTPAY_PASSWORD: 'emp-password',
};

const callers = [
  {
    name: 'NOWPayments',
    load: () => import('~/server/http/nowpayments/nowpayments.caller'),
    method: 'validateWebhookEvent',
    missing: 'Missing NOW_PAYMENTS_API_URL env',
  },
  {
    name: 'Coinbase',
    load: () => import('~/server/http/coinbase/coinbase.caller'),
    method: 'createCharge',
    missing: 'Missing COINBASE_API_URL env',
  },
  {
    name: 'EmerchantPay',
    load: () => import('~/server/http/emerchantpay/emerchantpay.caller'),
    method: 'createWPFPayment',
    missing: 'Missing EMERCHANTPAY_WPF_URL env',
  },
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(env)) delete env[key];
});

describe.each(callers)('$name caller is built on first use', ({ load, method, missing }) => {
  it('imports without its env, then fails on first use with the same error as before', async () => {
    const caller = (await load()).default as unknown as Record<string, unknown>;
    expect(() => caller[method]).toThrow(missing);
  });

  it('works as the instance once its env is set', async () => {
    Object.assign(env, FULL_ENV);
    const caller = (await load()).default as unknown as Record<string, unknown>;
    expect(typeof caller[method]).toBe('function');
  });
});

it('a method called on the lazy caller reaches the instance through `this`', async () => {
  Object.assign(env, FULL_ENV);
  const nowPayments = (await import('~/server/http/nowpayments/nowpayments.caller')).default;
  const body = { payment_id: 1, payment_status: 'finished' };
  const signed = createHmac('sha512', FULL_ENV.NOW_PAYMENTS_IPN_KEY)
    .update(JSON.stringify(body))
    .digest('hex');
  expect(nowPayments.validateWebhookEvent(signed, body)).toEqual({ isValid: true });
});
