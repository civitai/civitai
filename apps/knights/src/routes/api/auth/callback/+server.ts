import { spokeCallback } from '@civitai/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, getClientAddress }) =>
  spokeCallback(request, { clientIp: clientAddress(getClientAddress) });

function clientAddress(get: () => string): string | undefined {
  try {
    return get() || undefined;
  } catch {
    return undefined;
  }
}
