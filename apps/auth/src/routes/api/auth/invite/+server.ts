import { json, type RequestHandler } from '@sveltejs/kit';
import { parsePlainEmailAddress } from '@civitai/auth/plain-email';
import { addressparser, isEmailConfigured } from '@civitai/email';
import { normalizeEmailAddress } from '$lib/server/auth/blocklist';
import { issueInvite } from '$lib/server/auth/invite-tokens';
import { checkRateLimit, isRateLimited } from '$lib/server/auth/rate-limit';
import { getClientIp } from '$lib/server/auth/request';
import { newAccountRefusal } from '$lib/server/auth/signup-rules';
import { userExistsByEmail } from '$lib/server/auth/users';
import { logAxiomError } from '$lib/server/axiom';
import { inviteEmail } from '$lib/server/email/invite.email';
import { blockedEmailDomainSignupsTotal } from '$lib/server/metrics';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { authenticatedConfidentialClient } from '$lib/server/oauth/client-auth';
import {
  INVITED_BY_MAX,
  INVITE_MESSAGE_MAX,
  inviteSender,
  isInviteReturnUrl,
  parseInviteText,
} from '$lib/server/oauth/invites';

// The link goes only to the recipient's inbox and the caller never sees it, so this can't be used to sign in
// as an address the caller doesn't control.

const CLIENT_LIMIT = { count: 500, windowSeconds: 3600 };
const RECIPIENT_LIMIT = { count: 5, windowSeconds: 86400 };

const refuse = (status: number, error: string) => json({ error }, { status });

export const POST: RequestHandler = async ({ request, url }) => {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, 'Send a JSON object body.');
  }

  const authed = await authenticatedConfidentialClient(request, body);
  if (!authed) return refuse(401, 'Invalid client credentials.');
  const client = await inviteSender(authed.id);
  if (!client) return refuse(403, 'This client may not send invites.');

  const email = normalizeEmailAddress(typeof body.email === 'string' ? body.email : '');
  const plain = parsePlainEmailAddress(email, addressparser);
  if (!plain) return refuse(400, 'email must be a plain email address.');

  const returnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : '';
  if (!(await isInviteReturnUrl(returnUrl, client.allowedOrigins))) {
    return refuse(
      400,
      "returnUrl must be an absolute URL on one of this client's allowed origins, on a trusted Civitai domain."
    );
  }

  const invitedBy = parseInviteText(body.invitedBy, INVITED_BY_MAX);
  if ('error' in invitedBy) return refuse(400, `invitedBy ${invitedBy.error}.`);
  const message = parseInviteText(body.message, INVITE_MESSAGE_MAX);
  if ('error' in message) return refuse(400, `message ${message.error}.`);

  // Lowercased so case variants of one address share a limit. Checked here, counted only once an email is
  // sent, so a refused or failed attempt never uses up a recipient's allowance.
  const recipientKey = email.toLowerCase();
  if (
    (await isRateLimited('invite-client', client.id, CLIENT_LIMIT.count)) ||
    (await isRateLimited('invite-recipient', recipientKey, RECIPIENT_LIMIT.count))
  ) {
    return refuse(429, 'Too many invites. Try again later.');
  }

  const accountExists = await userExistsByEmail(email);
  const refusal = accountExists ? null : await newAccountRefusal(email, plain);
  if (refusal) {
    if (refusal === 'blockedDomain') blockedEmailDomainSignupsTotal.inc({ path: 'invite' });
    return refuse(403, 'This email address cannot be used to create an account.');
  }

  // sendEmail silently does nothing without SMTP settings; answer honestly instead of a 202 for an unsent invite.
  if (!isEmailConfigured()) return refuse(503, 'Email is not configured on this hub.');

  try {
    const { expiresAt } = await issueInvite(
      { clientId: client.id, email, returnUrl },
      async (token) => {
        const link = new URL('/invite', url.origin);
        link.searchParams.set('token', token);
        await inviteEmail.send({
          to: email,
          url: link.toString(),
          appName: client.name,
          invitedBy: invitedBy.value,
          message: message.value,
        });
      }
    );
    await checkRateLimit(
      'invite-client',
      client.id,
      CLIENT_LIMIT.count,
      CLIENT_LIMIT.windowSeconds
    );
    await checkRateLimit(
      'invite-recipient',
      recipientKey,
      RECIPIENT_LIMIT.count,
      RECIPIENT_LIMIT.windowSeconds
    );
    logOAuthEvent({
      type: 'invite.sent',
      clientId: client.id,
      ip: getClientIp(request) ?? undefined,
      metadata: { email, returnUrl, accountExists },
    });
    return json({ expiresAt: expiresAt.toISOString() }, { status: 202 });
  } catch (e) {
    void logAxiomError(e, { event: 'invite send failed', clientId: client.id });
    return refuse(500, 'Could not send the invite.');
  }
};
