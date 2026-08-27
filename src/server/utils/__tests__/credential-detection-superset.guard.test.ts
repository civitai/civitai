import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { legacySessionCookieName, sessionCookieName } from '@civitai/auth';
import type { NextApiRequest } from 'next';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';
import { requestCarriesCallerCredentials } from '~/server/utils/endpoint-helpers';

/**
 * RELATIONSHIP GUARD — the cache-control credential predicate must stay a
 * SUPERSET of what the session layer actually accepts as a credential.
 *
 * WHY IT MATTERS. `PublicEndpoint` / `MixedAuthEndpoint` pick a response's
 * `Cache-Control` from `requestCarriesCallerCredentials(req)`:
 *
 *     credentialed  -> private, no-cache   (never stored by a shared cache)
 *     anonymous     -> public, s-maxage=…  (stored at the edge, replayed to anyone)
 *
 * That predicate is the whole mechanism, because the edge does not help.
 * Measured on production, same URL across arms: an anonymous request populates a
 * URL, and a later request carrying `Authorization` is served that cached entry
 * (`cf-cache-status: HIT`, still `public`). `Vary: Authorization` is INERT at our
 * CDN. A virgin URL requested first WITH a credential does correctly get
 * `private` + `BYPASS`, so the origin predicate works and that third arm is a
 * cache hit rather than a misclassification.
 *
 * The failure is therefore silent and specific: if the session layer learns a
 * credential spelling this predicate does not recognise, a request carrying it is
 * classified ANONYMOUS, gets `public, s-maxage`, and its per-caller body is cached
 * and served to other people. Nothing throws.
 *
 * ── WHAT THIS CERTIFIES, AND WHAT IT DOES NOT ────────────────────────────────
 * 🔴 Read this before trusting a green run. An earlier version claimed a spelling
 * "nobody has thought of yet is handled by construction". An adversarial 14-mutant
 * sweep killed that claim: nine survived — a header read through a `const` alias,
 * one through destructuring, a credential read moved to a NEW FILE, and a NEW
 * COOKIE, on the axis that version called un-driftable. This is the honest
 * contract.
 *
 * CAUGHT (each mutation-verified below):
 *   - a header or query param read by literal name, dot or bracket notation;
 *   - a header read via a `const NAME = 'literal'` alias in the same source;
 *   - a header read by DESTRUCTURING `req.headers`, renamed or not;
 *   - a bracket read whose name cannot be resolved — that FAILS rather than
 *     vanishing, which is the difference between a guard and a filter;
 *   - a credential-reading module added to the entry point's import graph;
 *   - a new cookie helper used on the session path but not by the predicate;
 *   - the predicate narrowing on any of the above.
 *
 * NOT CAUGHT: a name computed at runtime (a function return, a template, a config
 * value), or a credential read in a module reached other than by a static
 * relative import from the entry point. Both are out of reach of a source parse;
 * the fail-closed bracket rule narrows the first considerably.
 */

const SRC = resolve(__dirname, '../../..');
const ENTRY = 'server/auth/get-server-auth-session.ts';

/**
 * The modules that turn a raw request into a session.
 *
 * A LEDGER, not a convenience list: the scope test derives the entry point's own
 * local imports and fails when this set misses one, so a credential read cannot
 * be quarantined into a file the guard never reads. Listed files must also exist,
 * so a rename cannot silently shrink the scanned surface.
 */
const SESSION_PATH_FILES = [ENTRY, 'server/auth/session-client.ts', 'server/auth/bearer-token.ts'];

/**
 * Local modules the entry point imports that do NOT read credentials off the
 * request. Fail-closed: anything else it imports must be scanned.
 */
const NON_CREDENTIAL_MODULES: Record<string, string> = {
  'server/auth/session-metrics.ts': 'counters only — takes no request',
  'server/utils/url-helpers.ts': 'builds a base URL; reads nothing off the request',
};

/** Request HEADER reads on the session path that are not credentials. */
const NON_CREDENTIAL_HEADERS: Record<string, string> = {
  host: 'response-side only — the cookie domain for maybeRollHubCookie / maybeUpgradeLegacySession, never read to identify a caller',
};

/** QUERY reads on the session path that are not credentials. */
const NON_CREDENTIAL_QUERY: Record<string, string> = {};

/**
 * Cookie-name helpers used on the session path that do NOT name a credential.
 * Deliberately a separate list per axis: one flat map meant exempting a header
 * silently exempted an identically-named query param.
 */
const NON_CREDENTIAL_COOKIE_HELPERS: Record<string, string> = {
  deviceCookieName:
    'a device identifier used for rolling/upgrade bookkeeping; authenticates nobody on its own',
};

/** `in` fails open on prototype keys (`constructor`, `valueOf`, `toString`). */
function isExempt(list: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(list, name);
}

function readSource(rel: string): string {
  return stripSourceComments(readFileSync(resolve(SRC, rel), 'utf8'));
}

function sessionPathSource(): string {
  return SESSION_PATH_FILES.map(readSource).join('\n');
}

/** Resolve `const NAME = 'literal'` so a bracket read via a constant is visible. */
function literalConsts(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/g
  ))
    out.set(m[1], m[2]);
  return out;
}

/**
 * Names read off `req.<bag>`, by any spelling this parse can see.
 *
 * 🔴 An unresolvable bracket read yields a SENTINEL rather than nothing. Silently
 * dropping what it cannot understand is exactly how the first version let a
 * `const`-aliased header through.
 */
function extractReads(src: string, bag: 'headers' | 'query'): string[] {
  const names = new Set<string>();
  const consts = literalConsts(src);
  const B = `req\\.${bag}`;

  for (const m of src.matchAll(new RegExp(`\\b${B}\\s*\\??\\.\\s*([A-Za-z][\\w]*)`, 'g')))
    names.add(m[1]);

  // Capture the WHOLE bracket expression, then decide. Matching only the shapes
  // we understand means anything else vanishes — and a read we cannot see is
  // exactly the one that gets through. `req.headers[computeName()]` failed this
  // way while an identifier-only pattern was in place.
  for (const m of src.matchAll(new RegExp(`\\b${B}\\s*(?:\\?\\.)?\\[([^\\]]+)\\]`, 'g'))) {
    const inner = m[1].trim();
    const literal = inner.match(/^['"]([^'"]+)['"]$/);
    if (literal) {
      names.add(literal[1]);
      continue;
    }
    const ident = inner.match(/^[A-Za-z_$][\w$]*$/);
    const resolved = ident ? consts.get(inner) : undefined;
    names.add(resolved ?? `<unresolvable:${inner}>`);
  }

  for (const m of src.matchAll(new RegExp(`\\{([^}]*)\\}\\s*=\\s*${B}\\b`, 'g'))) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const quoted = t.match(/^['"]([^'"]+)['"]\s*:/);
      if (quoted) {
        names.add(quoted[1]);
        continue;
      }
      const bare = t.match(/^([A-Za-z_$][\w$]*)/);
      if (bare) names.add(bare[1]);
    }
  }

  const exempt = bag === 'headers' ? NON_CREDENTIAL_HEADERS : NON_CREDENTIAL_QUERY;
  return [...names].filter((n) => !isExempt(exempt, n));
}

/** Query params also arrive via `new URL(...).searchParams.get('x')`. */
function extractQueryReads(src: string): string[] {
  const names = new Set<string>(extractReads(src, 'query'));
  for (const m of src.matchAll(/searchParams\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) names.add(m[1]);
  return [...names].filter((n) => !isExempt(NON_CREDENTIAL_QUERY, n));
}

/** Cookie-name HELPERS invoked in a `req.cookies[...]` read on the session path. */
function extractCookieHelpers(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/req\.cookies\s*\??\.?\[\s*([A-Za-z_$][\w$]*)\s*\(/g))
    names.add(m[1]);
  return [...names].filter((n) => !isExempt(NON_CREDENTIAL_COOKIE_HELPERS, n));
}

/** Local (relative) modules a source file imports, as repo-relative paths. */
function localImports(rel: string): string[] {
  const src = readSource(rel);
  const dir = resolve(SRC, rel, '..');
  const out = new Set<string>();
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const abs = resolve(dir, m[1]);
    for (const cand of [`${abs}.ts`, `${abs}.tsx`, `${abs}/index.ts`]) {
      if (existsSync(cand)) {
        out.add(cand.slice(SRC.length + 1));
        break;
      }
    }
  }
  return [...out];
}

/**
 * A request carrying `name`, in the shape Next hands an API route.
 *
 * Axis-aware deliberately: `cookie` is a real header the predicate parses, and
 * `'synthetic-value'` is not a parseable cookie pair — a naive fixture made a
 * legitimate `req.headers.cookie` read look UNRECOGNISED and pointed the reader
 * at exempting the whole raw-Cookie axis.
 */
function reqWithHeader(name: string): NextApiRequest {
  const value =
    name.toLowerCase() === 'cookie' ? `${sessionCookieName()}=synthetic` : 'synthetic-value';
  return {
    headers: { [name]: value },
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

function reqWithCookie(name: string): NextApiRequest {
  return {
    headers: {},
    cookies: { [name]: 'synthetic-value' },
    query: {},
    url: '/api/v1/x',
  } as unknown as NextApiRequest;
}

describe('credential detection is a superset of the session layer', () => {
  // ── Controls on the DERIVATION ─────────────────────────────────────────────
  // Without these a broken parse yields an empty set and everything below passes
  // vacuously — a guard that reads as coverage while providing none.

  it('the session-path sources are readable, listed and non-trivial', () => {
    const src = sessionPathSource();
    expect(src.length).toBeGreaterThan(2_000);
    expect(src).toContain('getServerAuthSession');
    for (const f of SESSION_PATH_FILES)
      expect(existsSync(resolve(SRC, f)), `${f} is listed but does not exist`).toBe(true);
  });

  it('finds the credential spellings we KNOW exist', () => {
    const src = sessionPathSource();
    expect(extractReads(src, 'headers')).toContain('authorization');
    expect(extractQueryReads(src)).toContain('token');
    expect(extractCookieHelpers(src).sort()).toEqual(
      ['legacySessionCookieName', 'sessionCookieName'].sort()
    );
  });

  it('sees every notation it claims to', () => {
    // Each of these SURVIVED an earlier version; all are now pinned.
    expect(extractReads("const t = req.headers['x-api-key'];", 'headers')).toContain('x-api-key');
    expect(extractReads("const t = req.headers?.['x-fwd'];", 'headers')).toContain('x-fwd');
    expect(extractReads("const H = 'x-alias';\nconst t = req.headers[H];", 'headers')).toContain(
      'x-alias'
    );
    expect(extractReads('const { authorization } = req.headers;', 'headers')).toContain(
      'authorization'
    );
    expect(extractReads("const { 'x-api-key': k } = req.headers;", 'headers')).toContain(
      'x-api-key'
    );
    expect(extractQueryReads("const t = req.query['api_key'];")).toContain('api_key');
  });

  it('FAILS CLOSED on a bracket read it cannot resolve', () => {
    const found = extractReads('const t = req.headers[computeName()];', 'headers');
    const sentinel = found.find((n) => n.startsWith('<unresolvable:'));
    expect(sentinel, 'an unresolvable read must surface, not vanish').toBeDefined();
    // And the sentinel is not something the predicate accepts, so it fails the
    // relationship assertion rather than passing quietly.
    expect(requestCarriesCallerCredentials(reqWithHeader(sentinel as string))).toBe(false);
  });

  it('ignores commented-out reads — and this control is not vacuous', () => {
    // 🔴 BRACKET notation deliberately. An earlier version used a hyphenated name
    // in DOT notation, which the dot pattern can never yield, so the assertion
    // held even with comment-stripping replaced by the identity function — the
    // one control protecting a real fail-open direction was decorative.
    const src = [
      "      // const a = req.headers['x-commented'];",
      "      const b = req.headers['x-live'];",
    ].join('\n');
    const stripped = extractReads(stripSourceComments(src), 'headers');
    expect(stripped).toContain('x-live');
    expect(stripped).not.toContain('x-commented');
    // Prove the fixture CAN express the failure: unstripped, it is found.
    expect(extractReads(src, 'headers')).toContain('x-commented');
  });

  // ── Scope ──────────────────────────────────────────────────────────────────

  it('scans every local module the session entry point imports', () => {
    // Extracting bearer parsing into a helper file is an ordinary refactor, and
    // it silently disarmed the previous version of this guard.
    const unscanned = localImports(ENTRY).filter(
      (f) => !SESSION_PATH_FILES.includes(f) && !isExempt(NON_CREDENTIAL_MODULES, f)
    );
    expect(
      unscanned,
      `${ENTRY} imports these local modules, which are neither scanned for credential reads ` +
        `nor declared non-credential: [${unscanned.join(', ')}]. A credential read in one of ` +
        `them is invisible here. Add it to SESSION_PATH_FILES, or to NON_CREDENTIAL_MODULES ` +
        `with a reason.`
    ).toEqual([]);
  });

  // ── The relationship ───────────────────────────────────────────────────────

  it('every HEADER the session path reads is recognised as a credential', () => {
    const unrecognised = extractReads(sessionPathSource(), 'headers').filter(
      (h) => !requestCarriesCallerCredentials(reqWithHeader(h))
    );
    expect(
      unrecognised,
      `the session layer reads these request headers, but requestCarriesCallerCredentials does ` +
        `not treat them as credentials: [${unrecognised.join(', ')}]. A request carrying one ` +
        `would be classified ANONYMOUS and its per-caller body cached publicly. Teach the ` +
        `predicate the spelling, or declare it in NON_CREDENTIAL_HEADERS with a reason — noting ` +
        `that exempting a whole axis (e.g. 'cookie') hides future reads on it too.`
    ).toEqual([]);
  });

  it('every QUERY PARAM the session path reads is recognised as a credential', () => {
    const unrecognised = extractQueryReads(sessionPathSource()).filter(
      (q) => !requestCarriesCallerCredentials(reqWithQuery(q))
    );
    expect(
      unrecognised,
      `the session layer reads these query parameters, but requestCarriesCallerCredentials does ` +
        `not treat them as credentials: [${unrecognised.join(', ')}].`
    ).toEqual([]);
  });

  it('every COOKIE the session path authenticates with is recognised', () => {
    // BEHAVIOURAL, not textual. The previous version asserted both files mention
    // the same helper NAMES — which a decoy call elsewhere in a 700-line file
    // satisfies while the real list is hardcoded. This calls each helper and asks
    // the predicate about the cookie it actually names, so the two sides can only
    // agree by agreeing.
    const helpers: Record<string, (secure?: boolean) => string> = {
      sessionCookieName,
      legacySessionCookieName,
    };
    const used = extractCookieHelpers(sessionPathSource());

    const unknown = used.filter((h) => !Object.prototype.hasOwnProperty.call(helpers, h));
    expect(
      unknown,
      `the session path resolves cookie names with these helpers, which this guard cannot ` +
        `evaluate: [${unknown.join(', ')}]. If one names a credential the predicate must ` +
        `recognise it — add it to the map here, or to NON_CREDENTIAL_COOKIE_HELPERS with a reason.`
    ).toEqual([]);

    for (const name of used) {
      // Both variants: the predicate registers secure and non-secure spellings,
      // and a deploy's env decides which is live.
      for (const secure of [true, false]) {
        const cookie = helpers[name](secure);
        expect(
          requestCarriesCallerCredentials(reqWithCookie(cookie)),
          `the session path authenticates with ${name}(${secure}) = "${cookie}", but the ` +
            `predicate does not recognise it`
        ).toBe(true);
      }
    }
  });

  // ── Negative controls on the guard's own strictness ────────────────────────

  it('does NOT demand that unrelated request fields be credentials', () => {
    expect(requestCarriesCallerCredentials(reqWithHeader('accept-language'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithQuery('limit'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithCookie('theme'))).toBe(false);
  });

  it('exemption lookup does not fail open on prototype keys', () => {
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'constructor')).toBe(false);
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'valueOf')).toBe(false);
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'host')).toBe(true);
  });
});
