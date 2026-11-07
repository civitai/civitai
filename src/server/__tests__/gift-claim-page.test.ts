import type { GetServerSidePropsContext } from 'next';
import { describe, expect, it } from 'vitest';
import { GIFT_CODE_COOKIE, resolveGiftClaimPage } from '~/server/utils/gift-claim-page';

const CODE = 'cvg_0123456789ABCDEFGHJKMNPQRS';
const ON = { modelGiftLinks: true };

function ctx({ code, cookies = {} }: { code?: string; cookies?: Record<string, string> } = {}) {
  const headers: Record<string, unknown> = { 'Set-Cookie': ['civ-token=rolled; Path=/'] };
  return {
    headers,
    ctx: {
      params: code ? { code: [code] } : {},
      req: { cookies },
      res: {
        getHeader: (name: string) => headers[name],
        setHeader: (name: string, value: unknown) => {
          headers[name] = value;
        },
      },
    } as unknown as GetServerSidePropsContext,
  };
}

describe('the gift claim page', () => {
  it('moves a code in the path into an HttpOnly cookie and redirects to a bare /gift', () => {
    const { ctx: c, headers } = ctx({ code: CODE });
    const result = resolveGiftClaimPage({ features: ON, session: {}, ctx: c });

    expect(result).toEqual({ redirect: { destination: '/gift', permanent: false } });
    const cookies = headers['Set-Cookie'] as string[];
    const gift = cookies.find((h) => h.startsWith(`${GIFT_CODE_COOKIE}=`));
    expect(gift).toBe(
      `${GIFT_CODE_COOKIE}=${CODE}; Path=/gift; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`
    );
    // A session cookie written earlier in the request survives.
    expect(cookies).toContain('civ-token=rolled; Path=/');
  });

  it('redirects there before the session check, so the login link never carries the code', () => {
    const result = resolveGiftClaimPage({
      features: ON,
      session: null,
      ctx: ctx({ code: CODE }).ctx,
    });
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('caps what it stores at 64 characters', () => {
    const { ctx: c, headers } = ctx({ code: 'x'.repeat(500) });
    resolveGiftClaimPage({ features: ON, session: {}, ctx: c });
    const gift = (headers['Set-Cookie'] as string[]).find((h) => h.startsWith(GIFT_CODE_COOKIE))!;
    expect(gift).toContain(`=${'x'.repeat(64)};`);
  });

  it('sends a signed-out visitor to sign in and back to /gift', () => {
    expect(resolveGiftClaimPage({ features: ON, session: null, ctx: ctx().ctx })).toEqual({
      redirect: { destination: '/login?returnUrl=%2Fgift', permanent: false },
    });
  });

  it('pre-fills the code from the cookie for a signed-in visitor', () => {
    const c = ctx({ cookies: { [GIFT_CODE_COOKIE]: CODE } }).ctx;
    expect(resolveGiftClaimPage({ features: ON, session: {}, ctx: c })).toEqual({
      props: { initialCode: CODE },
    });
  });

  it('is a 404, setting nothing, while the flag is off', () => {
    const { ctx: c, headers } = ctx({ code: CODE });
    expect(resolveGiftClaimPage({ features: { modelGiftLinks: false }, ctx: c })).toEqual({
      notFound: true,
    });
    expect(headers['Set-Cookie']).toEqual(['civ-token=rolled; Path=/']);
  });
});
