import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { SYNC_PARAM } from '@civitai/auth';
import { isEmailConfigured } from '@civitai/email';
import type { Actions, PageServerLoad } from './$types';
import { listEnabledProviders } from '$lib/server/auth/providers';
import { readReturnUrl, readSync, buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { createVerificationToken } from '$lib/server/auth/email-tokens';
import { sendVerificationEmail } from '$lib/server/email/verification.email';
import { captchaSiteKey, verifyCaptchaToken } from '$lib/server/auth/captcha';
import { getBlockedEmailDomains } from '$lib/server/auth/blocklist';
import { checkRateLimit } from '$lib/server/auth/rate-limit';

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
    // Public Turnstile site key (delivered via SSR data, not a PUBLIC_ env var). The page renders
    // the widget only when it's set; the email action verifies the token server-side.
    turnstileSiteKey: captchaSiteKey() ?? null,
    user: locals.user ? { username: locals.user.username, id: locals.user.id } : null,
  };
};

export const actions: Actions = {
  // Magic-link request: validate the email, issue a token, and send the sign-in link. returnUrl
  // + sync ride along in the link so post-verify honors them (validated at verify time).
  // Abuse controls mirror the main app's isAllowedToSignIn: rate limit by IP, Turnstile captcha,
  // and the blocked-email-domain list.
  email: async ({ request, url, getClientAddress }) => {
    const data = await request.formData();
    const email = String(data.get('email') ?? '')
      .trim()
      .toLowerCase();
    const returnUrl = String(data.get('returnUrl') ?? '/');
    const sync = data.get(SYNC_PARAM) ? String(data.get(SYNC_PARAM)) : null;

    if (!EMAIL_RE.test(email)) return fail(400, { email, invalid: true });

    const ip = getClientAddress();

    // 1. Rate limit (per IP) — cheap gate before any captcha/DB work.
    if (!(await checkRateLimit('email-login', ip, 5, 600))) {
      return fail(429, { email, rateLimited: true });
    }

    // 2. Turnstile — the widget injects `cf-turnstile-response` into the form. Passes through when
    //    captcha is disabled (dev / no secret).
    const captchaToken = data.get('cf-turnstile-response')?.toString();
    if (!(await verifyCaptchaToken(captchaToken, ip))) {
      return fail(400, { email, captcha: true });
    }

    // 3. Blocked email domains.
    const domain = email.split('@')[1];
    if (domain && (await getBlockedEmailDomains()).includes(domain)) {
      return fail(400, { email, blockedDomain: true });
    }

    try {
      const token = await createVerificationToken(email);
      const verifyUrl = new URL('/login/email/verify', url.origin);
      verifyUrl.searchParams.set('token', token);
      verifyUrl.searchParams.set('email', email);
      if (returnUrl) verifyUrl.searchParams.set('returnUrl', returnUrl);
      if (sync) verifyUrl.searchParams.set(SYNC_PARAM, sync);

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
