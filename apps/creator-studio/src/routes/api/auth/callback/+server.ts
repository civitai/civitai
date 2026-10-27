import { spokeCallback } from '@civitai/auth';
import { getLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url, getClientAddress }) =>
  spokeCallback(request, {
    clientIp: clientAddress(getClientAddress),
    onEvent: (outcome, detail) =>
      void getLogger().logToAxiom({ name: 'auth-flow', step: 'callback', outcome, host: url.host, ...detail }).catch(() => {}),
  });

// getClientAddress throws when the adapter has no address to give; the exchange then goes without one.
function clientAddress(get: () => string): string | undefined {
  try {
    return get() || undefined;
  } catch {
    return undefined;
  }
}
