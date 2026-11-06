import { createHash } from 'crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** eMerchantPay is retired: its webhook credits nothing, whatever it is sent. */

const { processBuzzOrder } = vi.hoisted(() => ({ processBuzzOrder: vi.fn() }));

vi.mock('~/env/server', () => ({
  env: {
    EMERCHANTPAY_PASSWORD: 'emp-password',
    EMERCHANTPAY_USERNAME: 'user',
    EMERCHANTPAY_WPF_URL: 'https://emerchantpay.test',
  },
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/services/emerchantpay.service', () => ({ processBuzzOrder }));

const handler = (await import('~/pages/api/webhooks/emerchantpay')).default;

const approvedNotification = () => {
  const uniqueId = 'wpf-1';
  return new URLSearchParams({
    wpf_unique_id: uniqueId,
    signature: createHash('sha512')
      .update(uniqueId + 'emp-password')
      .digest('hex'),
    notification_type: 'wpf',
    wpf_status: 'approved',
    wpf_transaction_id: '42-100000',
    payment_transaction_unique_id: 'tx-1',
    payment_transaction_amount: '1000',
  }).toString();
};

async function deliver(method: string, body: string) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    send: () => res,
    json: () => res,
    end: () => res,
    setHeader: () => res,
    _status: () => statusCode,
  };
  await handler(req as never, res as never);
  return res;
}

beforeEach(() => {
  processBuzzOrder.mockReset();
});

describe('emerchantpay webhook', () => {
  it.each(['POST', 'GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])(
    'answers 410 to an approved notification sent with %s and credits nothing',
    async (method) => {
      const res = await deliver(method, approvedNotification());

      expect(res._status()).toBe(410);
      expect(processBuzzOrder).not.toHaveBeenCalled();
    }
  );
});
