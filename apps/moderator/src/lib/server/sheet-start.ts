import type { RequestHandler } from '@sveltejs/kit';
import type { ReviewTier } from '@civitai/shared/review-batch';
import { canAccess } from './access';
import {
  type BatchBinding,
  issueCode,
  parseStartParams,
  type StartParams,
  webSessionClaims,
} from './held-sheet';
import { getReviewBatch, reviewBatchesEnabled, TIER_PAGE } from './review-batch';

// The page and its redirect must not be framed, cached or sent on as a referrer.
// `form-action` names the callback's origin too: the confirmed form ends in a redirect to it.
const headers = (callback?: string) => ({
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  // Not no-referrer: under it the form POST carries `Origin: null`, which the origin check refuses.
  'referrer-policy': 'same-origin',
  'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${
    callback ? ` ${new URL(callback).origin}` : ''
  }; frame-ancestors 'none'; base-uri 'none'`,
});

const status = (code: number) => new Response(null, { status: code, headers: headers() });

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

function page(heading: string, username: string, params: StartParams, batch: string | null) {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:32px 16px;background:#1a1b1e;color:#e9ecef}
main{max-width:420px;margin:0 auto}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:#228be6;color:#fff;width:100%}</style>
</head><body><main>
<h1>${escapeHtml(heading)}</h1>
<p>Signed in as <strong>${escapeHtml(username)}</strong>.</p>
<form method="post">
${hidden('code_challenge', params.challenge)}
${hidden('code_challenge_method', 'S256')}
${hidden('state', params.state)}
${hidden('redirect_uri', params.redirect)}
${batch ? hidden('batch', batch) : ''}
<button type="submit">Continue</button>
</form>
</main></body></html>`;
}

type Binding = { ok: true; batch: BatchBinding | undefined } | { ok: false; status: number };

/**
 * The batch a start names, checked against the signed-in moderator: it must be live, of this route's
 * tier, and minted for them. A family that requires a batch refuses a start without one.
 */
async function bindBatch(
  raw: string | null,
  tier: ReviewTier,
  required: boolean,
  userId: number
): Promise<Binding> {
  if (!raw) return required ? { ok: false, status: 400 } : { ok: true, batch: undefined };
  if (!reviewBatchesEnabled()) return { ok: false, status: 404 };
  const batch = await getReviewBatch(raw).catch(() => undefined);
  if (batch === undefined) return { ok: false, status: 503 };
  if (!batch || batch.tier !== tier || batch.viewer !== userId) return { ok: false, status: 404 };
  return { ok: true, batch: { hash: batch.hash, tier } };
}

/**
 * `auth/start` for one sheet family: GET asks the moderator to confirm and issues nothing; the
 * confirmed POST issues a code, bound to the batch when one is named, and sends it to the sheet.
 */
export function sheetStartHandlers(family: {
  tier: ReviewTier;
  heading: string;
  /** The general family exists only for batches; the held family also signs in the image-id sheet. */
  batchRequired: boolean;
}): { GET: RequestHandler; POST: RequestHandler } {
  const pagePath = TIER_PAGE[family.tier];
  return {
    GET: async ({ locals, url }) => {
      if (!locals.user || !canAccess(locals.user, pagePath)) return status(403);
      const params = parseStartParams((name) => url.searchParams.get(name));
      if (!params) return status(400);
      const raw = url.searchParams.get('batch');
      const bound = await bindBatch(raw, family.tier, family.batchRequired, locals.user.id);
      if (!bound.ok) return status(bound.status);
      return new Response(
        page(family.heading, locals.user.username ?? `#${locals.user.id}`, params, raw),
        { headers: { ...headers(params.redirect), 'content-type': 'text/html; charset=utf-8' } }
      );
    },
    POST: async ({ locals, request }) => {
      if (!locals.user || !canAccess(locals.user, pagePath)) return status(403);
      const form = await request.formData().catch(() => null);
      const params = form && parseStartParams((name) => form.get(name) as string | null);
      if (!params) return status(400);
      const raw = form.get('batch');
      const bound = await bindBatch(
        typeof raw === 'string' ? raw : null,
        family.tier,
        family.batchRequired,
        locals.user.id
      );
      if (!bound.ok) return status(bound.status);

      const claims = await webSessionClaims(request.headers.get('cookie') ?? '');
      if (!claims?.jti || Number(claims.sub) !== locals.user.id || claims.impersonatedBy != null)
        return status(403);

      const code = await issueCode(params, locals.user.id, claims, bound.batch).catch(() => null);
      if (!code) {
        console.error('[held-sheet] could not store a sign-in code');
        return status(503);
      }
      const location = `${params.redirect}?code=${code}&state=${encodeURIComponent(params.state)}`;
      return new Response(null, {
        status: 303,
        headers: { ...headers(params.redirect), location },
      });
    },
  };
}
