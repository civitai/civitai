import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { isEmailConfigured } from '@civitai/email';
import type { Actions, PageServerLoad } from './$types';
import { listEnabledProviders } from '$lib/server/auth/providers';
import { readReturnUrl, readSync, buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { createVerificationToken } from '$lib/server/auth/email-tokens';
import { sendVerificationEmail } from '$lib/server/email/verification.email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = ({ url, locals }) => {
  const returnUrl = readReturnUrl(url);
  const sync = readSync(url);
  const reason = url.searchParams.get('reason');
  const error = url.searchParams.get('error');

  // Already signed in → bounce straight back to the real destination (with the sync marker
  // re-attached), unless the user wants to add/switch accounts. If there's no real returnUrl
  // (they came to the hub directly), STAY and show the signed-in state — redirecting to '/'
  // would just loop back here via the root redirect.
  if (locals.user && reason !== 'switch-accounts') {
    const target = buildPostLoginRedirect(returnUrl, sync, url.origin, dev);
    if (target && target !== '/') redirect(302, target);
  }

  return {
    providers: listEnabledProviders(),
    emailEnabled: isEmailConfigured(),
    returnUrl,
    sync,
    error,
    user: locals.user ? { username: locals.user.username, id: locals.user.id } : null,
  };
};

export const actions: Actions = {
  // Magic-link request: validate the email, issue a token, and send the sign-in link. returnUrl
  // + sync ride along in the link so post-verify honors them (validated at verify time).
  email: async ({ request, url }) => {
    const data = await request.formData();
    const email = String(data.get('email') ?? '')
      .trim()
      .toLowerCase();
    const returnUrl = String(data.get('returnUrl') ?? '/');
    const sync = data.get('sync') ? String(data.get('sync')) : null;

    if (!EMAIL_RE.test(email)) return fail(400, { email, invalid: true });
    // TODO: blocked-email-domain check (main app's getBlockedEmailDomains) + Turnstile captcha.

    try {
      const token = await createVerificationToken(email);
      const verifyUrl = new URL('/login/email/verify', url.origin);
      verifyUrl.searchParams.set('token', token);
      verifyUrl.searchParams.set('email', email);
      if (returnUrl) verifyUrl.searchParams.set('returnUrl', returnUrl);
      if (sync) verifyUrl.searchParams.set('sync', sync);

      await sendVerificationEmail(email, verifyUrl.toString());
      return { sent: true, email };
    } catch (e) {
      // Don't let a token/email failure bubble up to SvelteKit's full-page 500.
      // Return it as form state so the page can show an inline error instead.
      console.error('email login action failed', e);
      return fail(500, { email, serverError: true });
    }
  },
};
