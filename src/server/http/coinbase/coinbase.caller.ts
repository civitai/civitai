import { createHmac } from 'crypto';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import type { Coinbase } from '~/server/http/coinbase/coinbase.schema';

class CoinbaseCaller extends HttpCaller {
  private static instance: CoinbaseCaller;

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

    const json = await response.json();

    return json.data as Coinbase.CreateChargeResponseSchema;
  }

  async getCharge(chargeOrOrderId: string | number) {
    const response = await this.getRaw(`/charges/${chargeOrOrderId}`);

    if (!response.ok) {
      throw new Error(`Failed to get charge: ${response.statusText}`);
    }

    const json = await response.json();

    return json.data as Coinbase.CreateChargeResponseSchema;
  }

  /**
   * Verifies a Coinbase webhook signature.
   * @param signature The value of the X-CC-Webhook-Signature header
   * @param payload The raw request body as a Buffer
   * @param secret The webhook shared secret
   * @returns boolean
   */
  static verifyWebhookSignature(
    signature: string,
    payload: Buffer | string,
    secret: string
  ): boolean {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    // Node expects Buffer, but type may be Buffer<ArrayBufferLike> in some TS setups
    // Fix for Buffer<ArrayBufferLike> type issue: convert to Buffer using Uint8Array
    const nodeBuffer = Buffer.from(Uint8Array.prototype.slice.call(data));
    const computedSig = createHmac('sha256', secret).update(nodeBuffer.toString()).digest('hex');
    return signature === computedSig;
  }
}

export default CoinbaseCaller.getInstance();

export { CoinbaseCaller };
