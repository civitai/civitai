import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { Coinbase } from '~/server/http/Coinbase/Coinbase.schema';

// DOCUMENTATION
// https://documenter.getpostman.com/view/7907941/2s93JusNJt#api-documentation
type CoinbaseAccessToken = {
  accessToken: string;
  expiresIn: number;
  createdAt: number;
};

class CoinbaseCaller extends HttpCaller {
  private static instance: CoinbaseCaller;
  private static acessToken: CoinbaseAccessToken;

  protected constructor(baseUrl?: string) {
    baseUrl ??= env.COINBASE_API_URL;
    const apiKey = env.COINBASE_API_KEY;
    if (!baseUrl) throw new Error('Missing COINBASE_API_URL env');
    if (!apiKey) throw new Error('Missing COINBASE_API_KEY env');

    super(baseUrl, {
      headers: { 'X-CC-Api-Key': apiKey, 'Content-Type': 'application/json' },
    });
  }

  static getInstance(): CoinbaseCaller {
    if (!this.instance) {
      this.instance = new CoinbaseCaller();
    }

    return this.instance;
  }

  async isAPIHealthy(): Promise<boolean | null> {
    const response = await this.getRaw(`/checkouts`);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.error('Failed to get API status', response.statusText);
      return false;
    }

    return response.status === 200 ? true : false;
  }

  async createCharge(input: Coinbase.CreateChargeInputSchema) {
    const response = await this.postRaw(`/charges`, {
      body: JSON.stringify(input),
    });

    if (!response.ok || response.status !== 201) {
      throw new Error(`Failed to create charge: ${response.statusText}`);
    }

    const data = await response.json();

    return data as Coinbase.CreateChargeResponseSchema;
  }

  async getCharge(chargeOrOrderId: string | number) {
    const response = await this.getRaw(`/charges/${chargeOrOrderId}`);

    if (!response.ok) {
      throw new Error(`Failed to get charge: ${response.statusText}`);
    }

    const data = await response.json();

    return data as Coinbase.CreateChargeResponseSchema;
  }
}

export default CoinbaseCaller.getInstance();
