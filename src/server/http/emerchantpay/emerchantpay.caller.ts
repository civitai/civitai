import { createHash } from 'crypto';
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
   * For WPF notifications: SHA-512 Hash Hex of <wpf_unique_id><Your API password>
   * @param notification The parsed notification data containing wpf_unique_id and signature
   * @param apiPassword The API password used for verification
   * @returns boolean indicating if signature is valid
   */
  static verifyWebhookSignature(
    notification: {
      unique_id: string;
      signature: string;
      notification_type?: string;
    },
    apiPassword: string
  ): boolean {
    try {
      const { unique_id, signature, notification_type } = notification;

      let computedSig: string;

      if (notification_type === 'wpf' && unique_id) {
        // For WPF notifications: SHA-512 Hash Hex of <unique_id><Your API password>
        computedSig = createHash('sha512')
          .update(unique_id + apiPassword)
          .digest('hex');
        console.log('Using WPF signature verification (SHA-512):', {
          unique_id,
          received_signature: signature,
          computed_signature: computedSig,
        });
      } else {
        // Fallback to original method for other notification types
        computedSig = createHash('sha1')
          .update(unique_id + apiPassword)
          .digest('hex');
        console.log('Using fallback signature verification (SHA-1):', {
          unique_id,
          received_signature: signature,
          computed_signature: computedSig,
        });
      }

      // Compare signatures (case-insensitive)
      return signature.toLowerCase() === computedSig.toLowerCase();
    } catch (error) {
      console.error('Error verifying EmerchantPay webhook signature:', error);
      return false;
    }
  }

  /**
   * Parse webhook notification form data
   */
  static parseWebhookNotification(formData: string): EmerchantPay.WebhookNotificationSchema {
    // Parse URL-encoded form data
    const params = new URLSearchParams(formData);

    // Extract the form fields
    const notification = {
      unique_id: params.get('wpf_unique_id') || '',
      signature: params.get('signature') || '',
      notification_type: params.get('notification_type') || 'wpf',
      wpf_unique_id: params.get('wpf_unique_id') || undefined,
      payment_transaction: {
        transaction_type: params.get('payment_transaction_transaction_type') || 'sale',
        status: params.get('wpf_status') || 'unknown',
        unique_id: params.get('payment_transaction_unique_id') || '',
        transaction_id: params.get('wpf_transaction_id') || '',
        amount: Number(params.get('payment_transaction_amount')) / 100, // Convert from minor currency units
        currency: 'USD', // Assuming USD, could be made configurable
        authorization_code: params.get('authorization_code') || undefined,
        response_code: undefined, // Not present in form data
        technical_message: undefined, // Not present in form data
        message: undefined, // Not present in form data
        timestamp: new Date().toISOString(), // Generate timestamp since not provided
        mode: (params.get('mode') as 'test' | 'live') || 'test', // Default to test if not specified
      },
    };

    // Validate required fields
    if (!notification.unique_id) {
      throw new Error('Missing wpf_unique_id in webhook notification');
    }
    if (!notification.signature) {
      throw new Error('Missing signature in webhook notification');
    }
    if (!notification.payment_transaction.transaction_id) {
      throw new Error('Missing wpf_transaction_id in webhook notification');
    }

    return notification;
  }
}

export default EmerchantPayCaller.getInstance();

export { EmerchantPayCaller };
