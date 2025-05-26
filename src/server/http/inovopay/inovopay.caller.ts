import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import { InovoPay } from '~/server/http/inovopay/inovopay.schema';
import { logToAxiom } from '~/server/logging/client';

const log = async (data: MixedObject) => {
  const useAxiom = false;
  if (useAxiom) {
    await logToAxiom({
      name: 'inovoPay-caller',
      type: 'error',
      ...data,
    }).catch();
  } else {
    console.error('InovoPayCaller error:', data);
  }
};

class InovoPayCaller extends HttpCaller {
  protected constructor(baseUrl?: string) {
    baseUrl ??= env.INOVOPAY_API_URL;

    if (!baseUrl) throw new Error('Missing INOVOPAY_API_URL env');

    super(baseUrl, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  static getInstance() {
    return new InovoPayCaller();
  }

  private prepareSearchParams(data: Pick<InovoPay.BasicAuth, 'REQUEST_ACTION'> & MixedObject) {
    if (!env.INOVOPAY_USERNAME) throw new Error('Missing INOVOPAY_USERNAME env');
    if (!env.INOVOPAY_PASSWORD) throw new Error('Missing INOVOPAY_PASSWORD env');
    if (!env.INOVOPAY_SITE_ID) throw new Error('Missing INOVOPAY_SITE_ID env');

    const params = new URLSearchParams({
      REQ_USERNAME: env.INOVOPAY_USERNAME,
      REQ_PASSWORD: env.INOVOPAY_PASSWORD,
      SITE_ID: env.INOVOPAY_SITE_ID,
      REQUEST_RESPONSE_FORMAT: 'JSON',
      REQUEST_API_VERSIOn: '4.7',
    });

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    return params;
  }

  public async isServiceAvailable() {
    const response = await this.postRaw('/check_service_availability', {
      body: this.prepareSearchParams({
        REQUEST_ACTION: 'TESTGW',
      }),
    });

    const parsed = InovoPay.checkServiceAvailabilityResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      console.error('InovoPay checkServiceAvailability error:', parsed.error);
      return false;
    }

    if (Number(parsed.data.SERVICE_RESPONSE) !== 101) {
      return false;
    }

    return true;
  }

  public async createCreditCardTransaction(
    data: InovoPay.CreditCardTransactionInput
  ): Promise<InovoPay.CreditCardTransactionResponse> {
    const response = await this.postRaw('/credit_card_transaction', {
      body: this.prepareSearchParams({
        REQUEST_ACTION: 'CCAUTHCAP', // Both authorize and capture
        ...data,
      }),
    });

    const parsed = InovoPay.creditCardTransactionResponseSchema.safeParse(await response.json());

    if (!parsed.success) {
      await log({ message: 'Failed to create credit card transaction', data, error: parsed.error });
      throw new Error('Failed to create credit card transaction');
    }

    return parsed.data;
  }
}

export default InovoPayCaller.getInstance();
