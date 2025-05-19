import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { QS } from '~/utils/qs';

// DOCUMENTATION
// https://documentation.tipalti.com/reference/quick-start

type NOWPaymentsAccessToken = {
  accessToken: string;
  expiresIn: number;
  createdAt: number;
};

class NOWPaymentsCaller extends HttpCaller {
  private static instance: NOWPaymentsCaller;
  private static acessToken: NOWPaymentsAccessToken;

  protected constructor(baseUrl?: string) {
    baseUrl ??= env.NOW_PAYMENTS_API_URL;
    const apiKey = env.NOW_PAYMENTS_API_KEY;
    if (!baseUrl) throw new Error('Missing NOW_PAYMENTS_API_URL env');
    if (!apiKey) throw new Error('Missing NOW_PAYMENTS_API_KEY env');

    super(baseUrl, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    });
  }

  static async getInstance(): Promise<NOWPaymentsCaller> {
    return new NOWPaymentsCaller(undefined);
  }

  async isAPIHealthy() {
    const response = await this.getRaw(`/status`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get API status', response.statusText);
      return false;
    }

    const { message } = (await response.json()) as {
      message: string;
    };

    return message === 'OK' ? true : false;
  }

  async getCurrencies() {
    const response = await this.getRaw(`/currencies?fixed_rate=true`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get currencies', response.statusText);
      return null;
    }

    const { currencies } = (await response.json()) as {
      currencies: string[];
    };

    return currencies;
  }

  async getPriceEstimate(input: NOWPayments.EstimatePriceInput) {
    const response = await this.getRaw(`/v1/estimate`, {
      queryParams: input,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get price estimate', response.statusText);
      return null;
    }

    const data = (await response.json()) as {
      currency_from: string;
      currency_to: string;
      amount_from: number;
      estimated_amount: number;
    };

    return data;
  }

  async createPaymentInvoice(input: NOWPayments.CreatePaymentInvoiceInput) {
    const response = await this.postRaw(`/v1/invoice`, {
      body: JSON.stringify(input),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to create payment invoice', response.statusText);
      return null;
    }

    const data = (await response.json()) as NOWPayments.CreatePaymentInvoiceResponse;
    return data;
  }

  async createPayment(input: NOWPayments.CreatePaymentInput) {
    const response = await this.postRaw(`/v1/payment`, {
      body: JSON.stringify(input),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to create payment', response.statusText);
      return null;
    }

    const data = (await response.json()) as NOWPayments.CreatePaymentResponse;
    return data;
  }
}

export default NOWPaymentsCaller.getInstance;
