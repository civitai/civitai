import { createHmac } from 'crypto';
import * as xml2js from 'xml2js';
import { env } from '~/env/server';
import { HttpCaller } from '~/server/http/httpCaller';
import type { EmerchantPay } from '~/server/http/emerchantpay/emerchantpay.schema';

class EmerchantPayCaller extends HttpCaller {
  private static instance: EmerchantPayCaller;
  private username: string;
  private password: string;

  protected constructor(baseUrl?: string) {
    baseUrl ??= env.EMERCHANTPAY_WPF_URL;
    const username = env.EMERCHANTPAY_USERNAME;
    const password = env.EMERCHANTPAY_PASSWORD;

    if (!baseUrl) throw new Error('Missing EMERCHANTPAY_WPF_URL env');
    if (!username) throw new Error('Missing EMERCHANTPAY_USERNAME env');
    if (!password) throw new Error('Missing EMERCHANTPAY_PASSWORD env');

    super(baseUrl, {
      headers: {
        'Content-Type': 'text/xml',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
    });

    this.username = username;
    this.password = password;
  }

  static getInstance(): EmerchantPayCaller {
    if (!this.instance) {
      this.instance = new EmerchantPayCaller();
    }

    return this.instance;
  }

  /**
   * Build XML from object
   */
  private buildXML(obj: Record<string, unknown>): string {
    const builder = new xml2js.Builder({
      rootName: 'wpf_payment',
      xmldec: { version: '1.0', encoding: 'UTF-8' },
      renderOpts: { pretty: false },
    });
    return builder.buildObject(obj);
  }

  /**
   * Parse XML to object
   */
  private async parseXML(xml: string): Promise<Record<string, unknown>> {
    const parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
    });
    return new Promise((resolve, reject) => {
      parser.parseString(xml, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }

  /**
   * Check if WPF API is healthy by making a test request
   */
  async isAPIHealthy(): Promise<boolean | null> {
    try {
      // Create a minimal test request to check API connectivity
      const testData = {
        wpf_payment: {
          transaction_type: 'wpf_create',
          transaction_id: 'health_check_' + Date.now(),
          amount: 100,
          currency: 'USD',
          return_success_url: 'https://example.com/success',
          return_failure_url: 'https://example.com/failure',
          customer_email: 'test@example.com',
          billing_address: {
            first_name: 'Test',
            last_name: 'User',
            address1: '123 Test St',
            zip_code: '12345',
            city: 'Test City',
            country: 'US',
          },
          transaction_types: {
            transaction_type: {
              name: 'sale',
            },
          },
        },
      };

      const testXml = this.buildXML(testData);

      const response = await this.postRaw('/wpf', {
        body: testXml,
      });

      // A 400 or validation error is expected for health check, but 500+ indicates API issues
      return response.status < 500;
    } catch (error) {
      console.error('EmerchantPay API health check failed:', error);
      return false;
    }
  }

  /**
   * Create a WPF payment
   */
  async createWPFPayment(
    input: EmerchantPay.WPFCreatePaymentInputSchema
  ): Promise<EmerchantPay.WPFCreatePaymentResponseSchema> {
    // Convert amount to minor currency units (cents)

    // Build XML request
    const wpfPaymentData = {
      transaction_type: 'wpf_create',
      transaction_id: input.transaction_id,
      usage: input.usage,
      description: input.description,
      notification_url: input.notification_url,
      return_success_url: input.return_success_url,
      return_failure_url: input.return_failure_url,
      return_cancel_url: input.return_cancel_url,
      amount: input.amount,
      currency: input.currency,
      customer_email: input.customer_email,
      customer_phone: input.customer_phone,
      lifetime: input.lifetime,
      billing_address: input.billing_address,
      transaction_types: {
        transaction_type: input.transaction_types.map((type) => ({
          $: { name: type.name },
        })),
      },
    };

    const xmlBody = this.buildXML(wpfPaymentData);
    console.log(xmlBody);

    const response = await this.postRaw('/wpf', {
      body: xmlBody,
    });

    if (!response.ok) {
      console.log(this);
      const errorText = await response.text();
      console.error('EmerchantPay WPF creation failed:', errorText);
      throw new Error(`Failed to create WPF payment: ${response.statusText}`);
    }

    const xmlText = await response.text();
    const parsedResponse = await this.parseXML(xmlText);

    // Extract the payment response data
    const paymentResponse = parsedResponse.wpf_payment || parsedResponse.payment_response;

    if (!paymentResponse) {
      throw new Error('Invalid response format from EmerchantPay');
    }

    // Convert amount back from minor currency units
    if (paymentResponse && typeof paymentResponse === 'object' && 'amount' in paymentResponse) {
      const typedResponse = paymentResponse as Record<string, unknown>;
      typedResponse.amount = Number(typedResponse.amount) / 100;
    }

    return paymentResponse as EmerchantPay.WPFCreatePaymentResponseSchema;
  }

  /**
   * Reconcile a WPF payment by unique ID
   */
  async reconcileWPFPayment(uniqueId: string): Promise<EmerchantPay.WPFReconcileResponseSchema> {
    const reconcileData = {
      wpf_reconcile: {
        unique_id: uniqueId,
      },
    };

    const xmlBody = this.buildXML(reconcileData);

    const response = await this.postRaw('/wpf/reconcile', {
      body: xmlBody,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('EmerchantPay WPF reconcile failed:', errorText);
      throw new Error(`Failed to reconcile WPF payment: ${response.statusText}`);
    }

    const xmlText = await response.text();
    const parsedResponse = await this.parseXML(xmlText);

    // Extract the reconcile response data
    const reconcileResponse = parsedResponse.wpf_reconcile || parsedResponse.payment_response;

    if (!reconcileResponse) {
      throw new Error('Invalid reconcile response format from EmerchantPay');
    }

    // Convert amount back from minor currency units if present
    if (
      reconcileResponse &&
      typeof reconcileResponse === 'object' &&
      'amount' in reconcileResponse
    ) {
      const typedResponse = reconcileResponse as Record<string, unknown>;
      typedResponse.amount = Number(typedResponse.amount) / 100;
    }

    return reconcileResponse as EmerchantPay.WPFReconcileResponseSchema;
  }

  /**
   * Verify an EmerchantPay webhook signature
   * @param signature The signature from the webhook
   * @param payload The raw webhook payload
   * @param secret The webhook secret (usually the password)
   * @returns boolean indicating if signature is valid
   */
  static verifyWebhookSignature(
    signature: string,
    payload: Buffer | string,
    secret: string
  ): boolean {
    try {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
      const computedSig = createHmac('sha1', secret).update(data.toString()).digest('hex');

      // EmerchantPay typically uses SHA-1 for webhook signatures
      return signature.toLowerCase() === computedSig.toLowerCase();
    } catch (error) {
      console.error('Error verifying EmerchantPay webhook signature:', error);
      return false;
    }
  }

  /**
   * Parse webhook notification XML
   */
  static async parseWebhookNotification(
    xmlPayload: string
  ): Promise<EmerchantPay.WebhookNotificationSchema> {
    const parser = new xml2js.Parser({
      explicitArray: false,
      ignoreAttrs: false,
    });

    const parsed = await new Promise<Record<string, unknown>>((resolve, reject) => {
      parser.parseString(xmlPayload, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    const notification = parsed.wpf_notification || parsed.notification;

    if (!notification) {
      throw new Error('Invalid webhook notification format');
    }

    // Convert amount back from minor currency units if present
    const typedNotification = notification as Record<string, unknown>;
    if (
      typedNotification.payment_transaction &&
      typeof typedNotification.payment_transaction === 'object' &&
      'amount' in (typedNotification.payment_transaction as object)
    ) {
      const transaction = typedNotification.payment_transaction as Record<string, unknown>;
      transaction.amount = Number(transaction.amount) / 100;
    }

    return notification as EmerchantPay.WebhookNotificationSchema;
  }
}

export default EmerchantPayCaller.getInstance();

export { EmerchantPayCaller };
