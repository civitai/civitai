import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

const { env } = vi.hoisted(() => ({
  env: {
    NOW_PAYMENTS_API_URL: 'https://nowpayments.test',
    NOW_PAYMENTS_API_KEY: 'api-key',
    NOW_PAYMENTS_IPN_KEY: 'ipn-secret',
    TIPALTI_WEBTOKEN_SECRET: 'tipalti-secret',
  },
}));
vi.mock('~/env/server', () => ({ env }));

const nowPayments = (await import('~/server/http/nowpayments/nowpayments.caller')).default;
const { TipaltiCaller } = await import('~/server/http/tipalti/tipalti.caller');
const tipalti = Object.create(TipaltiCaller.prototype) as InstanceType<typeof TipaltiCaller>;

describe('NOWPayments validateWebhookEvent', () => {
  const body = { payment_id: 1, payment_status: 'finished' };
  const signed = createHmac('sha512', env.NOW_PAYMENTS_IPN_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

  it('accepts the right value and answers only whether it is valid', () => {
    expect(nowPayments.validateWebhookEvent(signed, body)).toEqual({ isValid: true });
  });

  it('refuses a wrong or short value, and answers only whether it is valid', () => {
    expect(nowPayments.validateWebhookEvent('0'.repeat(128), body)).toEqual({ isValid: false });
    expect(nowPayments.validateWebhookEvent('abc', body)).toEqual({ isValid: false });
  });
});

describe('Tipalti validateWebhookEvent', () => {
  const t = Math.floor(Date.now() / 1000);
  const payload = '{"id":"evt-1"}';
  const signed = createHmac('sha256', env.TIPALTI_WEBTOKEN_SECRET)
    .update(`${t}-${payload}`)
    .digest('hex');

  it('accepts the right value and answers only whether it is valid', () => {
    expect(tipalti.validateWebhookEvent(`t=${t},v=${signed}`, payload)).toEqual({ isValid: true });
  });

  it('refuses a wrong or short value, and answers only whether it is valid', () => {
    expect(tipalti.validateWebhookEvent(`t=${t},v=${'0'.repeat(64)}`, payload)).toEqual({
      isValid: false,
    });
    expect(tipalti.validateWebhookEvent(`t=${t},v=abc`, payload)).toEqual({ isValid: false });
  });
});
