import { matchWebhookToken } from '~/server/utils/webhook-token';
import { getBaseUrl } from '~/server/utils/url-helpers';

/** The request's API/bearer token: the Authorization header, or `?token=` other than the webhook token. */
export function readRequestBearerToken(req: {
  headers: { authorization?: string };
  url?: string;
}): string | undefined {
  if (req.headers.authorization) return req.headers.authorization.split(' ')[1];
  if (req.url) {
    const url = new URL(req.url, getBaseUrl());
    if (!matchWebhookToken(url.searchParams.get('token')))
      return url.searchParams.get('token') || undefined;
  }
  return undefined;
}
