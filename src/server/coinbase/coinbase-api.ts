import { getAuthHeaders } from '@coinbase/cdp-sdk/auth';
import { env } from '~/env/server';

const BASE_URL = 'api.developer.coinbase.com';

export async function fetchCoinbase({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body?: object;
}) {
  const headers = await getAuthHeaders({
    apiKeyId: env.CDP_API_KEY_ID!,
    apiKeySecret: env.CDP_API_KEY_SECRET!,
    requestMethod: method,
    requestHost: BASE_URL,
    requestPath: path,
  });

  const response = await fetch(`https://${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Coinbase API: ${response.statusText}`);
  }

  return response.json();
}
