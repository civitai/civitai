import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { parsePlainEmailAddress } from '@civitai/auth/plain-email';
import { addressparser } from '@civitai/email';
import type { Actions, PageServerLoad } from './$types';
import { consumeInviteToken, findInvite } from '$lib/server/auth/invite-tokens';
import { buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { getClientIp } from '$lib/server/auth/request';
import { NO_FRAMING } from '$lib/server/auth/same-origin';
import { establishSession } from '$lib/server/auth/session';
import { newAccountRefusal } from '$lib/server/auth/signup-rules';
import {
  findOrCreateUserByEmail,
  SystemAccountSignInError,
  userExistsByEmail,
} from '$lib/server/auth/users';
import { loginsTotal } from '$lib/server/metrics';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';
import { inviteSender, isInviteReturnUrl } from '$lib/server/oauth/invites';

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  setHeaders(NO_FRAMING);
  const token = url.searchParams.get('token') ?? '';
  const invite = token ? await findInvite(token) : null;
  const sender = invite ? await inviteSender(invite.clientId) : null;
  if (!invite || !sender) return { invite: null };
  return { invite: { token, email: invite.email, appName: sender.name } };
};

export const actions: Actions = {
  default: async ({ request, cookies, url }) => {
    const token = String((await request.formData()).get('token') ?? '');
    const invite = token ? await findInvite(token) : null;
    if (!invite) return fail(410, { error: 'expired' as const });

    // Re-checked at use: the app may have been disabled or lost the origin since the invite was sent.
    const sender = await inviteSender(invite.clientId);
    if (!sender || !(await isInviteReturnUrl(invite.returnUrl, sender.allowedOrigins))) {
      return fail(410, { error: 'expired' as const });
    }

    const { email, returnUrl } = invite;
    const accountExists = await userExistsByEmail(email);
    if (
      !accountExists &&
      (await newAccountRefusal(email, parsePlainEmailAddress(email, addressparser)))
    ) {
      return fail(403, { error: 'refused' as const });
    }

    // Spent only after the checks above pass, so failing one leaves the link usable; the atomic delete lets
    // only one of two concurrent accepts through.
    if (!(await consumeInviteToken(token))) return fail(410, { error: 'expired' as const });

    let user: Awaited<ReturnType<typeof findOrCreateUserByEmail>>;
    try {
      user = await findOrCreateUserByEmail(email, { allowCreate: true });
    } catch (e) {
      if (e instanceof SystemAccountSignInError) return fail(403, { error: 'refused' as const });
      throw e;
    }
    await establishSession(cookies, user, { returnUrl });
    loginsTotal.inc({ provider: 'invite' });

    logOAuthEvent({
      type: 'invite.used',
      userId: user.id,
      clientId: sender.id,
      ip: getClientIp(request) ?? undefined,
      metadata: { email, returnUrl, userCreated: !accountExists },
    });

    const isAllowedOrigin = await buildPostLoginOriginCheck();
    redirect(303, buildPostLoginRedirect(returnUrl, null, url.origin, dev, isAllowedOrigin));
  },
};
