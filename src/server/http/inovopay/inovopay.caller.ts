import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';

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

  private prepareSearchParams(data?: MixedObject) {
    data ??= {};
    if (!env.INOVOPAY_USERNAME) throw new Error('Missing INOVOPAY_USERNAME env');
    if (!env.INOVOPAY_PASSWORD) throw new Error('Missing INOVOPAY_PASSWORD env');
    if (!env.INOVOPAY_SITE_ID) throw new Error('Missing INOVOPAY_SITE_ID env');

    const params = new URLSearchParams({
      req_username: env.INOVOPAY_USERNAME,
      req_password: env.INOVOPAY_PASSWORD,
      site_id: env.INOVOPAY_SITE_ID,
      request_response_format: 'JSON',
      request_api_version: '4.7',
    });

    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }
    return params;
  }

  public async checkServiceAvailability() {
    const response = await this.postRaw('/check_service_availability', {
      body: this.prepareSearchParams({
        request_action: 'TESTGW',
      }),
    });

    const data = await response.json();

    return data;
  }
}

export default InovoPayCaller.getInstance();
