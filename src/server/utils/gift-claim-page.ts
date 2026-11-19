import type { GetServerSidePropsContext } from 'next';
import { appendSetCookie } from '~/server/utils/set-cookie';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getLoginLink } from '~/utils/login-helpers';

export const GIFT_CODE_COOKIE = 'civ-gift-code';

/**
 * `/gift/[[...code]]`. A code arriving in the path moves into a short-lived, server-only cookie and
 * the URL becomes a bare /gift: analytics and RUM scripts record page URLs, and the code is a live
 * credential.
 */
export function resolveGiftClaimPage({
  features,
  session,
  ctx,
}: {
  features?: Pick<FeatureAccess, 'modelGiftLinks'>;
  session?: unknown;
  ctx: Pick<GetServerSidePropsContext, 'params' | 'req' | 'res'>;
}) {
  if (!features?.modelGiftLinks) return { notFound: true as const };
  const segment = ctx.params?.code;
  const fromPath = Array.isArray(segment) ? segment[0] : undefined;
  if (fromPath) {
    // Path=/, not /gift: a client-side visit runs this from /_next/data/<build>/gift.json, which a
    // /gift cookie never reaches, so the prefill and the clear below would both miss.
    appendSetCookie(
      ctx.res,
      `${GIFT_CODE_COOKIE}=${encodeURIComponent(
        fromPath.slice(0, 64)
      )}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
    );
    return { redirect: { destination: '/gift', permanent: false } };
  }
  if (!session)
    return { redirect: { destination: getLoginLink({ returnUrl: '/gift' }), permanent: false } };
  const initialCode = ctx.req.cookies[GIFT_CODE_COOKIE] ?? '';
  // Read once: left in place, the next account to sign in on this browser would get it prefilled.
  if (initialCode)
    appendSetCookie(
      ctx.res,
      `${GIFT_CODE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
    );
  return { props: { initialCode } };
}
