import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { SYNC_PARAM } from '@civitai/auth';
import { isEmailConfigured } from '@civitai/email';
import type { Actions, PageServerLoad } from './$types';
import { listEnabledProviders } from '$lib/server/auth/providers';
import { readReturnUrl, readSync, buildPostLoginRedirect } from '$lib/server/auth/redirect';
import { buildPostLoginOriginCheck } from '$lib/server/oauth/first-party';
import { createVerificationToken } from '$lib/server/auth/email-tokens';
import { sendVerificationEmail } from '$lib/server/email/verification.email';
import { captchaSiteKey, captchaManagedSiteKey, verifyCaptchaToken } from '$lib/server/auth/captcha';
import { getBlockedEmailDomains } from '$lib/server/auth/blocklist';
import { checkRateLimit } from '$lib/server/auth/rate-limit';
import { getClientIp } from '$lib/server/auth/request';
import { trackLoginRedirect } from '$lib/server/tracking';
import { userExistsByEmail } from '$lib/server/auth/users';
import { emailLoginFailuresTotal } from '$lib/server/metrics';
import { logAxiomError } from '$lib/server/axiom';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const load: PageServerLoad = async ({ url, locals, request }) => {
  const returnUrl = readReturnUrl(url);
  const sync = readSync(url);
  const reason = url.searchParams.get('reason');
  const error = url.searchParams.get('error');
  // Forwarded to each provider link so e.g. the add-account flow (prompt=select_account) reaches the provider.
  const prompt = url.searchParams.get('prompt');

  // The add/switch-account intent — either signal sets it (the main app sends both; OAuth standard is
  // `prompt=select_account`). When set, a signed-in user is NOT bounced to their destination and the page
  // shows the login form (so they can sign in as a *different* identity) instead of the signed-in card.
  const addAccount = reason === 'switch-accounts' || prompt === 'select_account';

  // Already signed in → bounce straight back to the real destination (with the sync marker
  // re-attached), unless the user wants to add/switch accounts. If there's no real returnUrl
  // (they came to the hub directly), STAY and show the signed-in state — redirecting to '/'
  // would just loop back here via the root redirect.
  if (locals.user && !addAccount) {
    const isAllowedOrigin = await buildPostLoginOriginCheck();
    const target = buildPostLoginRedirect(returnUrl, sync, url.origin, dev, isAllowedOrigin);
    if (target && target !== '/') redirect(302, target);
  }

  // Track the login reason as a LoginRedirect event (mirrors the old LoginContent). Only fires for a user shown
  // the form — the signed-in case bounced above. Fire-and-forget.
  if (reason) {
    void trackLoginRedirect(reason, {
      userId: locals.user?.id,
      ip: getClientIp(request) ?? undefined,
      userAgent: request.headers.get('user-agent'),
    });
  }

  return {
    providers: listEnabledProviders(),
    emailEnabled: isEmailConfigured(),
    returnUrl,
    sync,
    error,
    prompt,
    addAccount,
    // Public Turnstile site keys (delivered via SSR data, not PUBLIC_ env vars). The invisible widget is the
    // ~99% path; the managed key is rendered by the client ONLY as a fallback when the invisible one fails —
    // null when unprovisioned, so the fallback never appears (behavior == pre-fallback).
    turnstileSiteKey: captchaSiteKey() ?? null,
    turnstileManagedSiteKey: captchaManagedSiteKey() ?? null,
    user: locals.user ? { username: locals.user.username, id: locals.user.id } : null,
  };
};

export const actions: Actions = {
  // Magic-link request: validate the email, issue a token, and send the sign-in link. returnUrl
  // + sync ride along in the link so post-verify honors them (validated at verify time).
  // Abuse controls mirror the main app's isAllowedToSignIn: rate limit by IP, Turnstile captcha,
  // and the blocked-email-domain list.
  email: async ({ request, url }) => {
    const data = await request.formData();
    const email = String(data.get('email') ?? '')
      .trim()
      .toLowerCase();
    const returnUrl = String(data.get('returnUrl') ?? '/');
    const sync = data.get(SYNC_PARAM) ? String(data.get(SYNC_PARAM)) : null;

    if (!EMAIL_RE.test(email)) return fail(400, { email, invalid: true });

    // Resolve the real client IP from proxy headers (not the shared ingress socket peer) so the per-IP
    // limit is genuinely per-client; null behind a misconfigured proxy → checkRateLimit skips the limit.
    const ip = getClientIp(request);

    // 1. Rate limit (per IP) — cheap gate before any captcha/DB work.
    if (!(await checkRateLimit('email-login', ip, 5, 600))) {
      return fail(429, { email, rateLimited: true });
    }

    // 2. Turnstile. The invisible widget auto-injects `cf-turnstile-response`; the interactive fallback rides
    //    `managed-turnstile-response` + `captchaMode=managed`, verified against the managed secret. On a
    //    tokenless submit the client tags WHY (widget-error / timeout / fallback-error) so the no_token reject
    //    can be split. Passes through when captcha is disabled (dev / no secret).
    const mode = data.get('captchaMode')?.toString() === 'managed' ? 'managed' : 'invisible';
    const captchaToken = (
      mode === 'managed' ? data.get('managed-turnstile-response') : data.get('cf-turnstile-response')
    )?.toString();
    const failReason = data.get('captchaFailReason')?.toString() || undefined;
    if (!(await verifyCaptchaToken(captchaToken, ip ?? undefined, { mode, failReason }))) {
      return fail(400, { email, captcha: true });
    }

    // 3. Blocked email domains.
    const domain = email.split('@')[1];
    if (domain && (await getBlockedEmailDomains()).includes(domain)) {
      return fail(400, { email, blockedDomain: true });
    }

    // 4. Plus-address anti-abuse: block NEW signups whose address contains '+', but let EXISTING users with a
    //    '+' address still sign in (ports the legacy isAllowedToSignIn plus-address gate; skipped in dev).
    if (!dev && email.includes('+') && !(await userExistsByEmail(email))) {
      return fail(400, { email, plusBlocked: true });
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
      void logAxiomError(e, { event: 'email login action failed' });
      emailLoginFailuresTotal.inc();
      return fail(500, { email, serverError: true });
    }
  },
};
