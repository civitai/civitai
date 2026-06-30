import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const API_VERSION = '2025-01';

const log = (data: MixedObject) =>
  logToAxiom({ name: 'shopify-merch', type: 'error', ...data }).catch(() => null);

// The merch store is a Shopify dev-dashboard custom app using the
// client_credentials grant: we mint a short-lived (~24h) admin token from a
// client id + secret. Cached in-process per pod; re-minted on expiry. A static
// SHOPIFY_ADMIN_TOKEN (store custom-app path) takes precedence if provided.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function mintAdminToken(): Promise<string | null> {
  const domain = env.SHOPIFY_SHOP_DOMAIN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    log({ message: 'Failed to mint Shopify admin token', status: res.status });
    return null;
  }
  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
  } | null;
  if (!data?.access_token) return null;

  const ttlMs = Math.max(((data.expires_in ?? 86400) - 300) * 1000, 60_000); // 5-min safety margin
  cachedToken = { value: data.access_token, expiresAt: Date.now() + ttlMs };
  return data.access_token;
}

async function getAdminToken(): Promise<string | null> {
  if (env.SHOPIFY_ADMIN_TOKEN) return env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  return mintAdminToken();
}

/**
 * Stamp the Civitai user id onto the Shopify customer as a `civitai.user_id`
 * metafield (GraphQL metafieldsSet — upserts by owner+namespace+key). The
 * order-status page reads this to hide the "Claim Buzz" prompt once a customer
 * is linked (they auto-redeem from then on).
 *
 * Best-effort: never throws. A failure here must not block the Buzz grant — the
 * link already exists in our DB, so auto-redeem still works; only the Shopify-side
 * UI hint is missed (the claim page still shows "already claimed" if revisited).
 */
export async function setCustomerCivitaiUserId(shopifyCustomerId: string, userId: number) {
  const domain = env.SHOPIFY_SHOP_DOMAIN;
  if (!domain) return;
  const token = await getAdminToken();
  if (!token) return;

  try {
    const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({
        query: `mutation SetCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/Customer/${shopifyCustomerId}`,
              namespace: 'civitai',
              key: 'user_id',
              type: 'number_integer',
              value: String(userId),
            },
          ],
        },
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      data?: { metafieldsSet?: { userErrors?: { field: string[]; message: string }[] } };
    } | null;
    const userErrors = data?.data?.metafieldsSet?.userErrors;
    if (!res.ok || (userErrors && userErrors.length > 0)) {
      log({ message: 'Failed to set customer metafield', status: res.status, userErrors });
    }
  } catch (error) {
    log({ message: 'Shopify metafield request threw', error: (error as Error)?.message });
  }
}
