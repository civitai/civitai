import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';

// Device-flow verification page (RFC 8628 user-interaction step). The user enters the `user_code`
// shown on their device, reviews what the app will access, and approves. Both steps reuse the §D
// session-gated endpoints via internal fetch (cookies + locals.user are forwarded). Ported from the
// main app's React src/pages/login/oauth/device.tsx.

export const load: PageServerLoad = ({ url, locals }) => {
  // Must be signed in — the approval is bound to locals.user at the device-approve endpoint.
  if (!locals.user) {
    redirect(303, `/login?returnUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }
  // verification_uri_complete prefills ?code=XXXX-XXXX.
  return { prefillCode: url.searchParams.get('code') ?? '' };
};

export const actions: Actions = {
  // Step 1 — look up the code and return the app + scopes for review.
  lookup: async ({ request, fetch }) => {
    const data = await request.formData();
    const userCode = String(data.get('user_code') ?? '').trim();
    if (!userCode) return fail(400, { step: 'enter' as const, error: 'Enter the code shown on your device.', userCode });

    const res = await fetch('/api/auth/oauth/device-info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: userCode }),
    });
    if (!res.ok) {
      return fail(400, { step: 'enter' as const, error: 'That code is invalid or has expired.', userCode });
    }
    const info = (await res.json()) as {
      client: { name: string; description: string | null; logoUrl: string | null; isVerified: boolean };
      scopes: string[];
    };
    return { step: 'review' as const, userCode, client: info.client, scopes: info.scopes };
  },

  // Step 2 — approve the device.
  approve: async ({ request, fetch }) => {
    const data = await request.formData();
    const userCode = String(data.get('user_code') ?? '').trim();

    const res = await fetch('/api/auth/oauth/device-approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: userCode }),
    });
    if (!res.ok) {
      return fail(400, { step: 'enter' as const, error: 'Could not approve that code — it may have expired. Try again.', userCode });
    }
    return { step: 'done' as const };
  },
};
