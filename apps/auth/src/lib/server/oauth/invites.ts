import { db } from '$lib/server/db/db';
import { SYSTEM_USER_ID } from '$lib/server/oauth/constants';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';

export const INVITED_BY_MAX = 100;
export const INVITE_MESSAGE_MAX = 200;

/** Any confidential system app that isn't disabled. Re-checked when a link is used, so disabling the app also stops invites already in inboxes. */
export async function inviteSender(
  clientId: string
): Promise<{ id: string; name: string; allowedOrigins: string[] } | null> {
  const client = await db
    .selectFrom('OauthClient')
    .select(['id', 'name', 'allowedOrigins'])
    .where('id', '=', clientId)
    .where('userId', '=', SYSTEM_USER_ID)
    .where('isConfidential', '=', true)
    .where('accessMode', '!=', 'disabled')
    .executeTakeFirst();
  return client ?? null;
}

/**
 * True if `returnUrl` is an absolute URL on one of the client's registered origins that the post-login
 * redirect will also follow; otherwise the user would be signed in and dropped on the hub's home page.
 */
export async function isInviteReturnUrl(
  returnUrl: string,
  allowedOrigins: string[]
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(returnUrl);
  } catch {
    return false;
  }
  if (!allowedOrigins.includes(url.origin)) return false;
  return (await buildPostLoginOriginCheck())(url.origin);
}

/** Optional plain-text field: whitespace collapsed (invitedBy reaches the email subject), or an error if not a string or too long. */
export function parseInviteText(
  value: unknown,
  max: number
): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'must be a string' };
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) return { error: `must be at most ${max} characters` };
  return { value: text || null };
}
