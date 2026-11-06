import { createHash, createHmac } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { env } = vi.hoisted(() => ({
  env: {
    NOW_PAYMENTS_API_URL: 'https://nowpayments.test',
    NOW_PAYMENTS_API_KEY: 'api-key',
    NOW_PAYMENTS_IPN_KEY: 'ipn-secret',
    TIPALTI_WEBTOKEN_SECRET: 'tipalti-secret',
    COINBASE_API_URL: 'https://coinbase.test',
    COINBASE_API_KEY: 'api-key',
    EMERCHANTPAY_WPF_URL: 'https://emerchantpay.test',
    EMERCHANTPAY_USERNAME: 'user',
    EMERCHANTPAY_PASSWORD: 'emp-password',
  },
}));
vi.mock('~/env/server', () => ({ env }));

const nowPayments = (await import('~/server/http/nowpayments/nowpayments.caller')).default;
const { TipaltiCaller } = await import('~/server/http/tipalti/tipalti.caller');
const tipalti = Object.create(TipaltiCaller.prototype) as InstanceType<typeof TipaltiCaller>;
const { CoinbaseCaller } = await import('~/server/http/coinbase/coinbase.caller');
const { EmerchantPayCaller } = await import('~/server/http/emerchantpay/emerchantpay.caller');

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

describe('Coinbase verifyWebhookSignature', () => {
  const secret = 'coinbase-secret';
  const payload = '{"id":"evt-1"}';
  const signed = createHmac('sha256', secret).update(payload).digest('hex');

  it('accepts the right value', () => {
    expect(CoinbaseCaller.verifyWebhookSignature(signed, payload, secret)).toBe(true);
  });

  it('refuses a wrong or short value', () => {
    expect(CoinbaseCaller.verifyWebhookSignature('0'.repeat(64), payload, secret)).toBe(false);
    expect(CoinbaseCaller.verifyWebhookSignature('abc', payload, secret)).toBe(false);
  });
});

describe('EmerchantPay verifyWebhookSignature', () => {
  const unique_id = 'wpf-1';
  const signed = createHash('sha512')
    .update(unique_id + env.EMERCHANTPAY_PASSWORD)
    .digest('hex');
  const consoleText = (spies: ReturnType<typeof vi.spyOn>[]) =>
    JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the right value in either case', () => {
    const verify = (signature: string) =>
      EmerchantPayCaller.verifyWebhookSignature(
        { unique_id, signature, notification_type: 'wpf' },
        env.EMERCHANTPAY_PASSWORD
      );
    expect(verify(signed)).toBe(true);
    expect(verify(signed.toUpperCase())).toBe(true);
  });

  it('refuses a wrong or short value', () => {
    for (const signature of ['0'.repeat(128), 'abc']) {
      expect(
        EmerchantPayCaller.verifyWebhookSignature(
          { unique_id, signature, notification_type: 'wpf' },
          env.EMERCHANTPAY_PASSWORD
        )
      ).toBe(false);
    }
  });

  it('writes no signature to the console', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const sha1 = createHash('sha1')
      .update(unique_id + env.EMERCHANTPAY_PASSWORD)
      .digest('hex');

    EmerchantPayCaller.verifyWebhookSignature(
      { unique_id, signature: 'abc', notification_type: 'wpf' },
      env.EMERCHANTPAY_PASSWORD
    );
    EmerchantPayCaller.verifyWebhookSignature(
      { unique_id, signature: 'abc' },
      env.EMERCHANTPAY_PASSWORD
    );

    expect(consoleText(spies)).not.toContain(signed);
    expect(consoleText(spies)).not.toContain(sha1);
  });
});

describe('NOWPayments getPaymentStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([404, 401, 500])(
    'answers null and logs the status when NOWPayments answers %i',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));

      expect(await nowPayments.getPaymentStatus(12345)).toBeNull();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'payment-status-failed', paymentId: 12345, status })
      );
    }
  );
});
