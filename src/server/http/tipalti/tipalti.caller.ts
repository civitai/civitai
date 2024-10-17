import { env } from '~/env/server.mjs';
import { HttpCaller } from '~/server/http/httpCaller';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import { QS } from '~/utils/qs';
import { createHmac } from 'crypto';

// DOCUMENTATION
// https://documentation.tipalti.com/reference/quick-start

class TipaltiCaller extends HttpCaller {
  private static instance: TipaltiCaller;

  protected constructor(baseUrl?: string, token?: string) {
    baseUrl ??= env.TIPALTI_API_URL;
    token ??= env.TIPALTI_API_KEY;

    if (!baseUrl) throw new Error('Missing TIPALTI_API_KEY env');
    if (!token) throw new Error('Missing TIPALTI_API_URL env');

    console.log('TipaltiCaller baseUrl:', baseUrl, 'token:', token);

    super(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  static getInstance(): TipaltiCaller {
    if (!TipaltiCaller.instance) {
      TipaltiCaller.instance = new TipaltiCaller();
    }

    return TipaltiCaller.instance;
  }

  async createPayee(payee: Tipalti.CreatePayeeInput) {
    try {
      const response = await this.postRaw('/payees', {
        body: JSON.stringify(payee),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });

      console.log(payee);

      if (!response.ok) {
        throw new Error(`Failed to create payee: ${response.statusText}`);
      }

      const data = await response.json();
      return Tipalti.createPayeeResponseSchema.parse(data);
    } catch (error) {
      console.error('Error creating payee', error);
      throw error;
    }
  }

  async createPayeeInvitation(payeeId: string) {
    const response = await this.postRaw(`/payees/${payeeId}/invitation`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const data = await response.json();

    return Tipalti.createPayeeInvitationResponseSchema.parse(data);
  }

  async getPaymentDashboardUrl(
    payeeId: string,
    type: 'setup' | 'invoiceHistory' | 'paymentHistory'
  ) {
    if (!env.TIPALTI_PAYEE_DASHBOARD_URL)
      throw new Error('Missing TIPALTI_PAYEE_DASHBOARD_URL env');
    if (!env.TIPALTI_API_KEY) throw new Error('Missing TIPALTI_API_KEY env');

    const baseUrl = env.TIPALTI_PAYEE_DASHBOARD_URL;
    const dashboard =
      type === 'setup' ? '/home' : type === 'invoiceHistory' ? '/invoices' : '/paymentshistory';

    const params = {
      payer: 'civitai',
      idap: payeeId,
      ts: Date.now(),
    };

    const qs = QS.stringify(params);
    const hashkey = createHmac('sha256', Buffer.from(env.TIPALTI_API_KEY, 'utf-8'))
      .update(qs)
      .digest('hex');
    const url = `${baseUrl}${dashboard}?${qs}&hashkey=${hashkey}`;
    return url;
  }

  async validateWebhookEvent(signature: string, payload: string) {
    if (!env.TIPALTI_WEBTOKEN_SECRET) throw new Error('Missing TIPALTI_WEBTOKEN_SECRET env');

    const [t, v] = signature.split(':');
    const tValue = t.split('=')[1];
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const isTooOld = new Date(Number.parseInt(tValue)).getTime() < fiveMinAgo;

    if (isTooOld) throw new Error('Signature is too old');

    const stringToSign = `${t}:${payload}`;
    const hash = createHmac('sha256', Buffer.from(env.TIPALTI_WEBTOKEN_SECRET, 'utf-8'))
      .update(Buffer.from(stringToSign, 'utf-8'))
      .digest('hex');

    return hash.toLowerCase() === v;
  }

  async createPaymentBatch(payments: Tipalti.PaymentInput[]) {
    const response = await this.postRaw('/payment-batches', {
      body: JSON.stringify({ paymentInstructions: payments }),
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    return Tipalti.createPaymentBatchResponseSchema.parse(data);
  }
}

export default TipaltiCaller.getInstance();
