import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';

// DOCUMENTATION
// https://documenter.getpostman.com/view/7907941/2s93JusNJt#api-documentation
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

  private sortObject = (obj: MixedObject): MixedObject => {
    return Object.keys(obj)
      .sort()
      .reduce((result, key) => {
        result[key] =
          obj[key] && typeof obj[key] === 'object' ? this.sortObject(obj[key]) : obj[key];
        return result;
      }, {} as MixedObject);
  };

  validateWebhookEvent(signature: string, payload: MixedObject) {
    if (!env.NOW_PAYMENTS_IPN_KEY) throw new Error('Missing NOW_PAYMENTS_IPN_KEY env');

    const sortedPayload = this.sortObject(payload);

    const hash = createHmac('sha512', env.NOW_PAYMENTS_IPN_KEY)
      .update(JSON.stringify(sortedPayload))
      .digest('hex');
    return {
      isValid: hash.toString().toLowerCase() === signature,
      hash: hash.toString().toLowerCase(),
      signature,
    };
  }

  static getInstance(): NOWPaymentsCaller {
    if (!this.instance) {
      this.instance = new NOWPaymentsCaller();
    }

    return this.instance;
  }
  async isAPIHealthy(): Promise<boolean | null> {
    const response = await this.getRaw(`/status`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get API status', response.statusText);
      return false;
    }
    const { message } = (await response.json()) as { message: string };
    return message === 'OK' ? true : false;
  }

  async getCurrencies(): Promise<NOWPayments.CurrenciesResponse | null> {
    const response = await this.getRaw(`/currencies?fixed_rate=true`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get currencies', response.statusText);
      return null;
    }
    const data = await response.json();

    // console.log('Currencies', data);
    return NOWPayments.currenciesResponseSchema.parse(data);
  }

  async getMinimumPaymentAmount(
    input: NOWPayments.MinAmountInput
  ): Promise<NOWPayments.MinAmountResponse | null> {
    const response = await this.getRaw(`/min-amount`, { queryParams: input });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get minimum payment amount', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.minAmountResponseSchema.parse(data);
  }

  async getPriceEstimate(
    input: NOWPayments.EstimatePriceInput
  ): Promise<NOWPayments.EstimatePriceResponse | null> {
    console.log('Estimate Price Input', input);
    const response = await this.getRaw(`/estimate`, { queryParams: input });

    console.log(response);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get price estimate', response.statusText);
      return null;
    }
    const data = await response.json();

    return NOWPayments.estimatePriceResponseSchema.parse(data);
  }

  async getExchangeRate(
    input: NOWPayments.ExchangeRateInput
  ): Promise<NOWPayments.ExchangeRateResponse | null> {
    const response = await this.getRaw(`/exchange-rate`, { queryParams: input });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get exchange rate', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.exchangeRateResponseSchema.parse(data);
  }

  async createPaymentInvoice(
    input: NOWPayments.CreatePaymentInvoiceInput
  ): Promise<NOWPayments.CreatePaymentInvoiceResponse | null> {
    const response = await this.postRaw(`/invoice`, { body: JSON.stringify(input) });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to create payment invoice', response.statusText);
      return null;
    }
    const data = await response.json();

    return NOWPayments.createPaymentInvoiceResponseSchema.parse(data);
  }

  async createPayment(
    input: NOWPayments.CreatePaymentInput
  ): Promise<NOWPayments.CreatePaymentResponse | null> {
    const response = await this.postRaw(`/payment`, { body: JSON.stringify(input) });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to create payment', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.createPaymentResponseSchema.parse(data);
  }

  async getPaymentStatus(
    payment_id: string | number
  ): Promise<NOWPayments.CreatePaymentResponse | null> {
    const response = await this.getRaw(`/payment/${payment_id}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get payment status', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.createPaymentResponseSchema.parse(data);
  }

  async getBalance(): Promise<NOWPayments.BalanceResponse | null> {
    const response = await this.getRaw(`/balance`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get balance', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.balanceResponseSchema.parse(data);
  }

  async getPayoutCurrencies(): Promise<NOWPayments.PayoutCurrenciesResponse | null> {
    const response = await this.getRaw(`/payout-currencies`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get payout currencies', response.statusText);
      return null;
    }
    const data = await response.json();
    return NOWPayments.payoutCurrenciesResponseSchema.parse(data);
  }
}

export default NOWPaymentsCaller.getInstance();
