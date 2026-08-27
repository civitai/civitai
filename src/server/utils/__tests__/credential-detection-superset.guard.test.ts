import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { NextApiRequest } from 'next';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';
import { requestCarriesCallerCredentials } from '~/server/utils/endpoint-helpers';

/**
 * RELATIONSHIP GUARD — the cache-control credential predicate must stay a
 * SUPERSET of what the session layer actually accepts as a credential.
 *
 * WHY THIS MATTERS. `PublicEndpoint` / `MixedAuthEndpoint` decide a response's
 * `Cache-Control` from `requestCarriesCallerCredentials(req)`:
 *
 *     credentialed  -> private, no-cache   (never stored by a shared cache)
 *     anonymous     -> public, s-maxage=…  (stored at the edge, replayed to anyone)
 *
 * That is the ONLY thing standing between a personalised response body and a
 * shared cache. It is also load-bearing in a way that is easy to miss, because
 * the edge does not help: `Vary: Authorization` is INERT at our CDN — measured
 * on production, an anonymous request populates a URL and a subsequent request
 * carrying `Authorization` is served that cached entry (`cf-cache-status: HIT`).
 * So `Vary` cannot be relied on to separate the two audiences; the origin header
 * is the whole mechanism.
 *
 * The failure mode is therefore precise and silent: if the session layer learns
 * a credential spelling this predicate does not recognise, a request carrying it
 * is classified ANONYMOUS, gets `public, s-maxage`, and its per-caller body is
 * cached and served to other people. Nothing errors. Everything keeps working.
 *
 * `endpoint-helpers.ts` already states the invariant in prose — "the set of
 * credential spellings this predicate recognises must stay a superset of the set
 * `getServerAuthSession` accepts; when one grows, so must the other". This file
 * is that sentence, enforced.
 *
 * ── How it derives, and why not a hand-written list ───────────────────────────
 * A list of spellings is exactly what `public-endpoint-credential-detection.test.ts`
 * already has, and a list cannot fail when the OTHER side grows — which is the
 * event this guard exists for. So the spellings are EXTRACTED from the session
 * layer's own source, and each extracted spelling is then used to SYNTHESISE a
 * request that is fed to the real predicate. A spelling nobody has thought of yet
 * is handled by construction: it is extracted, a request is built from it, and
 * the predicate must answer `true`.
 *
 * Two axes exist, and only one can drift:
 *   - COOKIES cannot. Both sides resolve names through the same shared helpers
 *     (`sessionCookieName` / `legacySessionCookieName`), so there is no second
 *     copy to fall out of step. Asserted structurally below rather than assumed.
 *   - HEADERS and QUERY PARAMS can, because each side reads them by literal name.
 *     Those are what is extracted.
 *
 * Fails CLOSED: an unrecognised header/param on the session path is a failure
 * unless it is explicitly declared a non-credential below, with a reason. A new
 * read is therefore a deliberate decision, not an omission.
 */

const SRC = resolve(__dirname, '../../..');

/**
 * The modules that turn a raw request into a session. If the credential-reading
 * surface grows a new file, add it here — `getServerAuthSession` is the entry
 * point and these are the ones it delegates credential EXTRACTION to.
 */
const SESSION_PATH_FILES = [
  'server/auth/get-server-auth-session.ts',
  'server/auth/session-client.ts',
  'server/auth/bearer-token.ts',
];

/**
 * Reads on the session path that are NOT credentials. Fail-closed means anything
 * not listed here must be recognised by the predicate, so each entry needs a
 * reason a reviewer can check.
 */
const NON_CREDENTIAL_READS: Record<string, string> = {
  host: 'response-side only — the cookie domain for maybeRollHubCookie/maybeUpgradeLegacySession, never read to identify a caller',
};

function sessionPathSource(): string {
  return SESSION_PATH_FILES.map((f) =>
    stripSourceComments(readFileSync(resolve(SRC, f), 'utf8'))
  ).join('\n');
}

/**
 * Header names the session path reads off the request, by literal name.
 *
 * 🔴 BOTH notations, and the bracket form is the important one: a header name
 * containing a hyphen — `x-api-key`, `x-forwarded-user` — CANNOT be read with
 * dot access, so the most likely spelling for a newly-added header is exactly
 * the one a dot-only pattern cannot see. A first version of this matched dot
 * access only, and a mutation adding `req.headers['x-api-key']` to the session
 * path walked straight past the guard.
 */
function extractHeaderReads(src: string): string[] {
  const names = new Set<string>();
  // req.headers.name / req.headers?.name
  for (const m of src.matchAll(/\breq\.headers\s*\??\.\s*([A-Za-z][A-Za-z0-9_]*)/g))
    names.add(m[1]);
  // req.headers['name'] / req.headers["name"] / req.headers?.['name']
  for (const m of src.matchAll(/\breq\.headers\s*(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\]/g))
    names.add(m[1]);
  return [...names].filter((n) => !(n in NON_CREDENTIAL_READS));
}

/** Query-parameter names the session path reads, by literal name. */
function extractQueryReads(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/searchParams\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\breq\.query\s*\??\.\s*([A-Za-z][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\breq\.query\s*(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\]/g))
    names.add(m[1]);
  return [...names].filter((n) => !(n in NON_CREDENTIAL_READS));
}

function reqWithHeader(name: string): NextApiRequest {
  return {
    headers: { [name]: 'synthetic-value' },
    cookies: {},
    query: {},
    url: '/api/v1/x',
  } as unknown as NextApiRequest;
}

function reqWithQuery(name: string): NextApiRequest {
  return {
    headers: {},
    cookies: {},
    query: { [name]: 'synthetic-value' },
    url: `/api/v1/x?${name}=synthetic-value`,
  } as unknown as NextApiRequest;
}

describe('credential detection is a superset of the session layer', () => {
  // ── Controls on the EXTRACTOR itself ───────────────────────────────────────
  // Without these, a broken regex yields an empty set and every assertion below
  // passes vacuously — the guard would be inert and read as coverage.

  it('the session-path sources are readable and non-trivial', () => {
    const src = sessionPathSource();
    expect(src.length).toBeGreaterThan(2_000);
    // The entry point must be in the scanned set, or the extraction is blind.
    expect(src).toContain('getServerAuthSession');
  });

  it('the extractor finds the credential spellings we KNOW exist', () => {
    // Positive control. `authorization` and `token` are read by
    // getServerAuthSession today; an extractor that cannot see them cannot see
    // a new one either.
    const src = sessionPathSource();
    expect(extractHeaderReads(src)).toContain('authorization');
    expect(extractQueryReads(src)).toContain('token');
  });

  it('the extractor sees BRACKET access, not just dot access', () => {
    // Regression control. Hyphenated header names cannot be read with dot
    // access, so bracket access is the ONLY spelling available for them — and a
    // dot-only extractor is blind to exactly the names most likely to be added.
    // A mutation adding `req.headers['x-api-key']` to the session path survived
    // the first version of this guard.
    const bracket = "const t = req.headers['x-api-key'];";
    expect(extractHeaderReads(bracket)).toContain('x-api-key');
    const optional = "const t = req.headers?.['x-forwarded-user'];";
    expect(extractHeaderReads(optional)).toContain('x-forwarded-user');
    const q = "const t = req.query['api_key'];";
    expect(extractQueryReads(q)).toContain('api_key');
  });

  it('the extractor ignores comments (a commented-out read is not a read)', () => {
    const withComment = `
      // req.headers.x-made-up-credential
      const a = req.headers.authorization;
    `;
    const found = extractHeaderReads(stripSourceComments(withComment));
    expect(found).toContain('authorization');
    expect(found).not.toContain('x-made-up-credential');
  });

  // ── The relationship ───────────────────────────────────────────────────────

  it('every HEADER the session path reads is recognised as a credential', () => {
    const src = sessionPathSource();
    const unrecognised = extractHeaderReads(src).filter(
      (h) => !requestCarriesCallerCredentials(reqWithHeader(h))
    );
    expect(
      unrecognised,
      `the session layer reads these request headers, but requestCarriesCallerCredentials ` +
        `does not treat them as credentials: [${unrecognised.join(
          ', '
        )}]. A request carrying one ` +
        `would be classified ANONYMOUS and its per-caller body cached publicly. Either teach the ` +
        `predicate the spelling, or declare it in NON_CREDENTIAL_READS with a reason.`
    ).toEqual([]);
  });

  it('every QUERY PARAM the session path reads is recognised as a credential', () => {
    const src = sessionPathSource();
    const unrecognised = extractQueryReads(src).filter(
      (q) => !requestCarriesCallerCredentials(reqWithQuery(q))
    );
    expect(
      unrecognised,
      `the session layer reads these query parameters, but requestCarriesCallerCredentials ` +
        `does not treat them as credentials: [${unrecognised.join(
          ', '
        )}]. See the header case above.`
    ).toEqual([]);
  });

  it('the COOKIE axis is shared-by-construction, not duplicated', () => {
    // Cookies are the one axis that cannot drift, because both sides resolve
    // names through the same helpers rather than each spelling them. Pinned so
    // that if either side ever hardcodes a name, this fails and the cookie axis
    // joins the extracted ones above.
    const predicateSrc = stripSourceComments(
      readFileSync(resolve(SRC, 'server/utils/endpoint-helpers.ts'), 'utf8')
    );
    const sessionSrc = sessionPathSource();
    for (const helper of ['sessionCookieName', 'legacySessionCookieName']) {
      expect(predicateSrc, `the predicate must derive cookie names via ${helper}()`).toContain(
        `${helper}(`
      );
      expect(sessionSrc, `the session path must derive cookie names via ${helper}()`).toContain(
        `${helper}(`
      );
    }
  });

  // ── Negative control on the guard's own strictness ─────────────────────────

  it('does NOT demand that unrelated request fields be treated as credentials', () => {
    // The predicate is deliberately narrow, and this guard must not quietly
    // require it to widen to anything the session path happens to touch. If this
    // fails, the extractor is over-matching and the assertions above are
    // demanding more than the invariant does.
    expect(requestCarriesCallerCredentials(reqWithHeader('accept-language'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithQuery('limit'))).toBe(false);
    expect(extractHeaderReads(sessionPathSource())).not.toContain('accept-language');
  });
});
