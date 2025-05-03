import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import { QS } from '~/utils/qs';

// DOCUMENTATION
// https://documentation.tipalti.com/reference/quick-start

type TipaltiAccessToken = {
  accessToken: string;
  expiresIn: number;
  createdAt: number;
};

class TipaltiCaller extends HttpCaller {
  private static instance: TipaltiCaller;
  private static acessToken: TipaltiAccessToken;

  protected constructor(baseUrl?: string, token?: TipaltiAccessToken) {
    baseUrl ??= env.TIPALTI_API_URL;

    if (!baseUrl) throw new Error('Missing TIPALTI_API_KEY env');
    if (!token) throw new Error('Missing Tipalti access token');

    super(baseUrl, {
      headers: { Authorization: `Bearer ${token?.accessToken}` },
    });
  }

  private static async getAccessToken() {
    if (!env.TIPALTI_API_CLIENT_ID) throw new Error('Missing TIPALTI_API_CLIENT_ID env');
    if (!env.TIPALTI_API_SECRET) throw new Error('Missing TIPALTI_API_SECRET env');
    if (!env.TIPALTI_API_REFRESH_TOKEN) throw new Error('Missing TIPALTI_API_REFRESH_TOKEN env');
    if (!env.TIPALTI_API_CODE_VERIFIER) throw new Error('Missing TIPALTI_API_CODE_VERIFIER env');
    if (!env.TIPALTI_API_TOKEN_URL) throw new Error('Missing TIPALTI_API_TOKEN_URL env');

    if (
      TipaltiCaller.acessToken &&
      Date.now() - TipaltiCaller.acessToken.createdAt < TipaltiCaller.acessToken.expiresIn
    ) {
      return TipaltiCaller.acessToken;
    }

    const response = await fetch(env.TIPALTI_API_TOKEN_URL, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: env.TIPALTI_API_CLIENT_ID,
        client_secret: env.TIPALTI_API_SECRET,
        grant_type: 'refresh_token',
        refresh_token: env.TIPALTI_API_REFRESH_TOKEN,
        code_verifier: env.TIPALTI_API_CODE_VERIFIER,
      }),
      method: 'POST',
    });

    const data = await response.json();

    if (!data.access_token) throw new Error('Failed to get Tipalti access token');

    TipaltiCaller.acessToken = {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      createdAt: Date.now(),
    };

    return TipaltiCaller.acessToken;
  }

  static async getInstance(): Promise<TipaltiCaller> {
    const token = await TipaltiCaller.getAccessToken();
    return new TipaltiCaller(undefined, token);
  }

  async getPayeeByRefCode(refCode: string) {
    const response = await this.getRaw(`/payees`, {
      queryParams: { filter: `refCode=="${refCode}"` },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get payee by refCode', response.statusText);
      return null;
    }

    const data = (await response.json()) as {
      items: Tipalti.Payee[];
      totalCount: number;
    };

    if (!data.items.length) return null;
    return data.items[0];
  }

  async createPayee(payee: Tipalti.CreatePayeeInput) {
    try {
      // First, check if it exists:
      const existingPayee = await this.getPayeeByRefCode(payee.refCode);

      // console.log('I happened', existingPayee);

      if (existingPayee) {
        return existingPayee;
      }

      const response = await this.postRaw('/payees', {
        body: JSON.stringify(payee),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });

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

    const res = Tipalti.createPayeeInvitationResponseSchema.safeParse(data);

    if (!res.success) {
      console.log(data);
      const { errors } = data as { errors: { code: string }[] };
      if (errors.find((e) => ['PYEEIN-100001', 'PYEEIN-100002'].includes(e.code))) {
        // Payee already has an invitation. This will error in the request but its fine.
        return;
      }

      throw new Error('Failed to create payee invitation');
    }

    return res.data;
  }

  async getPaymentDashboardUrl(
    refCode: string,
    type: 'setup' | 'invoiceHistory' | 'paymentHistory'
  ) {
    if (!env.TIPALTI_PAYEE_DASHBOARD_URL)
      throw new Error('Missing TIPALTI_PAYEE_DASHBOARD_URL env');
    if (!env.TIPALTI_IFRAME_KEY) throw new Error('Missing TIPALTI_IFRAME_KEY env');
    if (!env.TIPALTI_PAYER_NAME) throw new Error('Missing TIPALTI_PAYER_NAME env');

    const baseUrl = env.TIPALTI_PAYEE_DASHBOARD_URL;
    const dashboard =
      type === 'setup' ? '/home' : type === 'invoiceHistory' ? '/invoices' : '/paymentshistory';

    const params = {
      payer: env.TIPALTI_PAYER_NAME,
      idap: refCode,
      ts: Date.now() / 1000,
    };

    const qs = QS.stringify(params);
    const hashkey = createHmac('sha256', env.TIPALTI_IFRAME_KEY).update(qs).digest('hex');
    const url = `${baseUrl}${dashboard}?${qs}&hashkey=${hashkey}`;
    return url;
  }

  validateWebhookEvent(signature: string, payload: string | Buffer) {
    if (!env.TIPALTI_WEBTOKEN_SECRET) throw new Error('Missing TIPALTI_WEBTOKEN_SECRET env');

    const [t, v] = signature.split(',');
    const tValue = t.split('=')[1];
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const isTooOld = new Date(Number.parseInt(tValue) * 1000).getTime() < fiveMinAgo;

    if (isTooOld) throw new Error('Signature is too old');

    const stringToSign = `${tValue}-${payload}`;
    const hash = createHmac('sha256', env.TIPALTI_WEBTOKEN_SECRET)
      .update(stringToSign)
      .digest('hex');

    const vValue = v.split('=')[1];

    return {
      isValid: hash.toString().toLowerCase() === vValue,
      hash: hash.toString().toLowerCase(),
      vValue,
      stringToSign,
      signature,
    };
  }

  async createPaymentBatch(payments: Tipalti.PaymentInput[]) {
    const response = await this.postRaw('/payment-batches', {
      body: JSON.stringify({ paymentInstructions: payments }),
      headers: { 'Content-Type': 'application/json' },
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Failed to create payment batch: ${response.statusText}`);
    }

    return Tipalti.createPaymentBatchResponseSchema.parse(data);
  }

  async getPaymentByRefCode(refCode: string) {
    const response = await this.getRaw(`/payments`, {
      queryParams: { filter: `refCode=="${refCode}"` },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get payment by refCode', response.statusText);
      return null;
    }

    const data = (await response.json()) as {
      items: Tipalti.Payment[];
      totalCount: number;
    };

    if (!data.items.length) return null;
    return data.items[0];
  }
}

export default TipaltiCaller.getInstance;
