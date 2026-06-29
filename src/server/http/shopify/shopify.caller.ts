import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const API_VERSION = '2024-10';

const log = (data: MixedObject) =>
  logToAxiom({ name: 'shopify-merch', type: 'error', ...data }).catch(() => null);

/**
 * Stamp the Civitai user id onto the Shopify customer as a `civitai.user_id`
 * metafield. The order-status page reads this to hide the "Claim Buzz" prompt
 * once a customer is linked (they auto-redeem from then on).
 *
 * Best-effort: never throws. A failure here must not block the Buzz grant — the
 * link already exists in our DB, so auto-redeem still works; only the Shopify-side
 * UI hint is missed (the claim page still shows "already claimed" if revisited).
 */
export async function setCustomerCivitaiUserId(shopifyCustomerId: string, userId: number) {
  const domain = env.SHOPIFY_SHOP_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) return;

  try {
    const res = await fetch(
      `https://${domain}/admin/api/${API_VERSION}/customers/${shopifyCustomerId}.json`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          customer: {
            id: Number(shopifyCustomerId),
            metafields: [
              {
                namespace: 'civitai',
                key: 'user_id',
                type: 'number_integer',
                value: String(userId),
              },
            ],
          },
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log({
        message: 'Failed to set customer metafield',
        status: res.status,
        body: body.slice(0, 500),
      });
    }
  } catch (error) {
    log({ message: 'Shopify metafield request threw', error: (error as Error)?.message });
  }
}
