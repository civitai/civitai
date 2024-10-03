import { env } from '~/env/server.mjs';
import { HttpCaller } from '~/server/http/httpCaller';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';

// DOCUMENTATION
// https://documentation.tipalti.com/reference/quick-start

class TipaltiCaller extends HttpCaller {
  private static instance: TipaltiCaller;

  protected constructor(baseUrl?: string, token?: string) {
    baseUrl ??= env.TIPALTI_URL;
    token ??= env.TIPALTI_TOKEN;

    if (!baseUrl) throw new Error('Missing TIPALTI_TOKEN env');
    if (!token) throw new Error('Missing TIPALTI_URL env');

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
    const response = await this.postRaw('/payees', {
      body: JSON.stringify(payee),
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    return Tipalti.createPayeeResponseSchema.parse(data);
  }
}

export default TipaltiCaller.getInstance();
