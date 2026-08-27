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
 * That predicate is the whole mechanism, because the edge does not back it up.
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
 * 🔴 Read this before trusting a green run, and do not strengthen it without
 * re-measuring. Two successive adversarial sweeps found this file claiming more
 * than it did — first "handled by construction" (nine of fourteen mutants
 * survived), then a rewrite that introduced three fresh fail-opens of its own: a
 * destructuring pattern that anchored on the wrong brace and reported a
 * fabricated header name, a constant-resolution map shared across files so a
 * name collision made a real read VANISH, and a cookie axis with no fail-closed
 * path at all. Every claim below is mutation-verified; treat an unverified
 * addition to this list as false.
 *
 * CAUGHT:
 *   - a header or query param read by literal name, dot or bracket notation;
 *   - a header read via a `const NAME = 'literal'` alias in the SAME file;
 *   - a header read by DESTRUCTURING `req.headers`, renamed or not;
 *   - a cookie read by literal name, by a `const` alias, or via a name helper;
 *   - a bracket read whose name cannot be resolved — on ANY of the three axes,
 *     that FAILS rather than vanishing;
 *   - a credential-reading module added to the entry point's import graph,
 *     whether imported as `./x` or `~/server/x`;
 *   - the predicate narrowing on ANY SINGLE channel — `req.query` and `req.url`
 *     are probed independently, so two redundant branches cannot shield each
 *     other.
 *
 * NOT CAUGHT: a name computed at runtime (a function return, a template, a
 * config value) — that surfaces as a sentinel FAILURE rather than passing, but
 * the guard cannot tell you the real name; and a credential read in a module
 * reached other than by a static import from the entry point (a dynamic
 * `import()`, or a transitive import two hops away).
 */

const SRC = resolve(__dirname, '../../..');
const ENTRY = 'server/auth/get-server-auth-session.ts';

/**
 * The modules that turn a raw request into a session.
 *
 * A LEDGER, not a convenience list: the scope test derives the entry point's own
 * imports and fails when this set misses one, so a credential read cannot be
 * quarantined into a file the guard never reads.
 */
const SESSION_PATH_FILES = [ENTRY, 'server/auth/session-client.ts', 'server/auth/bearer-token.ts'];

/**
 * Modules the entry point imports that do NOT read credentials off the request.
 * Fail-closed: anything else it imports must be scanned.
 *
 * Keep this HONEST — an entry that no longer matches a real import is dead, and
 * a dead exemption is evidence the derivation's output was never read. The scope
 * test asserts the derivation is non-empty for exactly that reason.
 */
const NON_CREDENTIAL_MODULES: Record<string, string> = {
  'server/auth/session-metrics.ts': 'counters only — takes no request',
  'server/utils/url-helpers.ts': 'builds a base URL from config; reads nothing off the request',
  'env/server.ts': 'environment config; reads nothing off the request',
  'env/other.ts': 'environment config; reads nothing off the request',
};

/**
 * Workspace packages the entry point imports. Not scanned (they are whole
 * packages), so each must be declared with a reason — fail-closed, like modules.
 */
const NON_CREDENTIAL_PACKAGES: Record<string, string> = {
  '@civitai/auth':
    'owns the cookie-NAME vocabulary (sessionCookieName / legacySessionCookieName) and the legacy cookie decode; no `req` crosses this boundary — the session path reads req.cookies itself and passes only a string',
};

/** Request HEADER reads on the session path that are not credentials. */
const NON_CREDENTIAL_HEADERS: Record<string, string> = {
  host: 'response-side only — the cookie domain for maybeRollHubCookie / maybeUpgradeLegacySession, never read to identify a caller',
};

/** QUERY reads on the session path that are not credentials. */
const NON_CREDENTIAL_QUERY: Record<string, string> = {};

/** COOKIE names/helpers on the session path that do not name a credential. */
const NON_CREDENTIAL_COOKIES: Record<string, string> = {
  deviceCookieName:
    'a device identifier used for rolling/upgrade bookkeeping; authenticates nobody on its own',
};

/** Marker for a read whose name this parse could not determine. */
const UNRESOLVABLE = '<unresolvable>';
const isUnresolvable = (n: string) => n.startsWith(UNRESOLVABLE);

/**
 * `in` fails open on prototype keys (`constructor`, `valueOf`, `toString`).
 *
 * Also refuses to exempt a sentinel: an unresolvable read must be made
 * resolvable, never silenced by keying an exemption on the source text that
 * happened to produce it (rename the variable and the failure returns).
 */
function isExempt(list: Record<string, string>, name: string): boolean {
  if (isUnresolvable(name)) return false;
  return Object.prototype.hasOwnProperty.call(list, name);
}

function readSource(rel: string): string {
  return stripSourceComments(readFileSync(resolve(SRC, rel), 'utf8'));
}

/** Each scanned file separately — extraction is PER FILE, never over a join. */
function sessionPathSources(): { rel: string; src: string }[] {
  return SESSION_PATH_FILES.map((rel) => ({ rel, src: readSource(rel) }));
}

/**
 * `const NAME = 'literal'` within ONE file.
 *
 * 🔴 Per-file, and a name declared twice with different values resolves to
 * NOTHING rather than to one of them. A single map over the concatenated
 * sources let a `const CRED = 'host'` in one file resolve a `req.headers[CRED]`
 * in another onto the exempt `host`, so a real credential read vanished with no
 * sentinel — strictly worse than being unresolvable.
 */
function literalConsts(src: string): Map<string, string> {
  const seen = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/g
  )) {
    const [, name, value] = m;
    if (seen.has(name) && seen.get(name) !== value) conflicted.add(name);
    seen.set(name, value);
  }
  for (const n of conflicted) seen.delete(n);
  return seen;
}

/** Split a destructuring pattern on TOP-LEVEL commas (nested braces intact). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Classify one bracket-expression body into a name, or a sentinel. */
function classifyBracket(inner: string, consts: Map<string, string>): string {
  const t = inner.trim();
  const literal = t.match(/^['"]([^'"]+)['"]$/);
  if (literal) return literal[1];
  const ident = t.match(/^[A-Za-z_$][\w$]*$/);
  const resolved = ident ? consts.get(t) : undefined;
  return resolved ?? `${UNRESOLVABLE}:${t}`;
}

/** Names read off `req.<bag>` in ONE file, by any spelling this parse can see. */
function extractReadsIn(
  src: string,
  bag: 'headers' | 'query' | 'cookies',
  opts: { applyExemptions?: boolean } = {}
): string[] {
  const names = new Set<string>();
  const consts = literalConsts(src);
  const B = `req\\.${bag}`;

  // req.x.name / req.x?.name
  for (const m of src.matchAll(new RegExp(`\\b${B}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')))
    names.add(m[1]);

  // req.x[<anything>] — the WHOLE expression, then classified. Matching only
  // understood shapes means anything else vanishes, and a read the guard cannot
  // see is exactly the one that gets through.
  for (const m of src.matchAll(new RegExp(`\\b${B}\\s*(?:\\?\\.)?\\[([^\\]]+)\\]`, 'g'))) {
    const inner = m[1].trim();
    // A COOKIE name may be produced by a name helper, and the cookie test can
    // evaluate one — so record the helper. On headers/query there is no such
    // convention, so a call is simply a name we cannot determine: it must become
    // a sentinel, not be mistaken for the callee's identifier.
    const call = bag === 'cookies' ? inner.match(/^([A-Za-z_$][\w$]*)\s*\(/) : null;
    names.add(call ? call[1] : classifyBracket(inner, consts));
  }

  // Destructuring, via a balanced-brace scan backwards from `= req.<bag>`.
  //
  // 🔴 A regex cannot do this. `\{([^}]*)\}` anchored on the enclosing FUNCTION
  // BODY brace and reported a fabricated name; anchoring on the declaration
  // keyword fixed that and silently dropped the keyword-less assignment form.
  // And every shape a flat pattern cannot express — a type annotation on the
  // left, a default containing braces, a nested pattern — was failing OPEN,
  // while the bracket axis beside it failed closed. Scan, and emit a sentinel
  // for anything unparseable.
  // The negative lookahead is load-bearing: `= req.cookies?.[helper()]` is an
  // ordinary READ, not an alias. Without it every such read was misread as the
  // bag escaping and produced a false sentinel on the real source.
  for (const m of src.matchAll(new RegExp(`=\\s*${B}\\s*(?![.?\\[])`, 'g'))) {
    const before = src.slice(0, m.index ?? 0).trimEnd();
    const lastBrace = before.lastIndexOf('}');
    const tail = lastBrace >= 0 ? before.slice(lastBrace + 1).trim() : null;
    // Allow a type annotation between the pattern and the `=`.
    const isPattern = tail !== null && (tail === '' || /^:[^=]*$/.test(tail));
    if (!isPattern) {
      // `const h = req.headers` — the bag ESCAPES into a variable and every
      // later read through it is invisible. Fail closed rather than pretend.
      names.add(`${UNRESOLVABLE}:aliased-${bag}`);
      continue;
    }
    let depth = 0;
    let i = lastBrace;
    for (; i >= 0; i--) {
      if (before[i] === '}') depth++;
      else if (before[i] === '{') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i < 0) {
      names.add(`${UNRESOLVABLE}:unbalanced-pattern`);
      continue;
    }
    for (const part of splitTopLevel(before.slice(i + 1, lastBrace))) {
      const t = part.trim();
      if (!t || t.startsWith('...')) continue;
      const quoted = t.match(/^['"]([^'"]+)['"]\s*:/);
      if (quoted) {
        names.add(quoted[1]);
        continue;
      }
      const bare = t.match(/^([A-Za-z_$][\w$]*)/);
      if (bare) names.add(bare[1]);
    }
  }

  if (opts.applyExemptions === false) return [...names];
  const exempt =
    bag === 'headers'
      ? NON_CREDENTIAL_HEADERS
      : bag === 'query'
      ? NON_CREDENTIAL_QUERY
      : NON_CREDENTIAL_COOKIES;
  return [...names].filter((n) => !isExempt(exempt, n));
}

/** Every name the session path reads on `bag`, BEFORE exemptions are applied. */
function extractReadsRaw(bag: 'headers' | 'query' | 'cookies'): string[] {
  const out = new Set<string>();
  for (const { src } of sessionPathSources())
    for (const n of extractReadsIn(src, bag, { applyExemptions: false })) out.add(n);
  return [...out];
}

/** Union across the scanned files, extracting each SEPARATELY. */
function extractReads(bag: 'headers' | 'query' | 'cookies'): string[] {
  const out = new Set<string>();
  for (const { src } of sessionPathSources()) for (const n of extractReadsIn(src, bag)) out.add(n);
  return [...out];
}

/** Query params also arrive via `new URL(...).searchParams.get('x')`. */
function extractQueryReads(): string[] {
  const out = new Set<string>(extractReads('query'));
  for (const { src } of sessionPathSources())
    for (const m of src.matchAll(/searchParams\.get\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out].filter((n) => !isExempt(NON_CREDENTIAL_QUERY, n));
}

/**
 * Modules a source file depends on: `import … from`, `export … from`, and
 * side-effect `import '…'`.
 *
 * 🔴 `export … from` is a STATIC, EXECUTED dependency and belongs here. A
 * previous version matched a bare `from '…'`, caught it by accident, and a
 * narrowing to `import … from` silently dropped it — a re-export of a
 * credential-reading module became invisible. That regression was introduced by
 * the fix for the `~/` gap, which is the third time in this file's history that
 * a fix opened the next hole. Widen deliberately, and re-measure.
 *
 * Workspace packages (`@civitai/*`) are dependencies of this repo's own source,
 * NOT third-party — an earlier comment calling them "not our source" was simply
 * wrong. They are not scanned (they are whole packages), so they must be
 * declared in NON_CREDENTIAL_PACKAGES with a reason instead of ignored.
 */
function moduleImports(rel: string): { local: string[]; packages: string[] } {
  const src = readSource(rel);
  const dir = resolve(SRC, rel, '..');
  const local = new Set<string>();
  const packages = new Set<string>();

  const specs: string[] = [];
  // import/export … from '…' — `type` forms carry no runtime read.
  for (const m of src.matchAll(/\b(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g))
    specs.push(m[1]);
  // side-effect: import '…'
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);

  for (const spec of specs) {
    if (spec.startsWith('@civitai/')) {
      packages.add(spec);
      continue;
    }
    const abs = spec.startsWith('~/')
      ? resolve(SRC, spec.slice(2))
      : spec.startsWith('.')
      ? resolve(dir, spec)
      : null;
    if (!abs) continue; // genuine third-party
    for (const cand of [`${abs}.ts`, `${abs}.tsx`, `${abs}/index.ts`]) {
      if (existsSync(cand)) {
        local.add(cand.slice(SRC.length + 1));
        break;
      }
    }
  }
  return { local: [...local], packages: [...packages] };
}

/**
 * A request carrying `name`, in the shape Next hands an API route.
 *
 * Axis-aware: `cookie` is a real header the predicate parses, and
 * `'synthetic-value'` is not a parseable cookie pair — a naive fixture made a
 * legitimate `req.headers.cookie` read look UNRECOGNISED and steered the reader
 * toward exempting the whole raw-Cookie axis.
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

/**
 * Query fixtures, ONE CHANNEL EACH.
 *
 * 🔴 A fixture populating both `req.query` and `req.url` lets the predicate's
 * two query branches shield each other: dropping either one alone stayed green,
 * and only removing BOTH went red. A guard that cannot see a single-branch
 * narrowing is not guarding the branch.
 */
function reqWithQueryOnly(name: string): NextApiRequest {
  return {
    headers: {},
    cookies: {},
    query: { [name]: 'synthetic-value' },
    url: '/api/v1/x',
  } as unknown as NextApiRequest;
}

function reqWithUrlQueryOnly(name: string): NextApiRequest {
  // Encoded: a sentinel is raw source text and could otherwise inject query
  // structure (`…&token=1`) and be blessed by the predicate.
  return {
    headers: {},
    cookies: {},
    query: {},
    url: `/api/v1/x?${encodeURIComponent(name)}=synthetic-value`,
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

/** Cookie-name helpers this guard can evaluate. */
const COOKIE_HELPERS: Record<string, (secure?: boolean) => string> = {
  sessionCookieName,
  legacySessionCookieName,
};

describe('credential detection is a superset of the session layer', () => {
  // ── Controls on the DERIVATION ─────────────────────────────────────────────
  // Without these a broken parse yields an empty set and everything below passes
  // vacuously — a guard that reads as coverage while providing none.

  it('every listed session-path file exists and is non-trivial', () => {
    // Existence FIRST: sessionPathSources() would throw ENOENT before a later
    // existence assertion could produce its own message.
    for (const f of SESSION_PATH_FILES)
      expect(existsSync(resolve(SRC, f)), `${f} is listed but does not exist`).toBe(true);
    const joined = sessionPathSources()
      .map((f) => f.src)
      .join('\n');
    expect(joined.length).toBeGreaterThan(2_000);
    expect(joined).toContain('getServerAuthSession');
  });

  it('finds the credential spellings we KNOW exist', () => {
    expect(extractReads('headers')).toContain('authorization');
    expect(extractQueryReads()).toContain('token');
    expect(extractReads('cookies').sort()).toEqual(
      ['legacySessionCookieName', 'sessionCookieName'].sort()
    );
  });

  it('the import derivation is not empty (positive control)', () => {
    // Gutting moduleImports to return [] left the scope test green — every other
    // derivation here had a positive control and that one did not.
    const { local } = moduleImports(ENTRY);
    expect(local).toContain('server/auth/bearer-token.ts');
    expect(local).toContain('server/auth/session-client.ts');
  });

  it('sees every notation it claims to', () => {
    // Each of these survived some earlier version of this file.
    expect(extractReadsIn("const t = req.headers['x-api-key'];", 'headers')).toContain('x-api-key');
    expect(extractReadsIn("const t = req.headers?.['x-fwd'];", 'headers')).toContain('x-fwd');
    expect(extractReadsIn("const H = 'x-alias';\nconst t = req.headers[H];", 'headers')).toContain(
      'x-alias'
    );
    expect(extractReadsIn("const t = req.cookies?.['civ-alt'];", 'cookies')).toContain('civ-alt');
    expect(
      extractReadsIn("const C = 'civ-alt2';\nconst t = req.cookies?.[C];", 'cookies')
    ).toContain('civ-alt2');
    expect(extractReadsIn("const t = req.query['api_key'];", 'query')).toContain('api_key');
  });

  it('parses destructuring from the DECLARATION, not the enclosing brace', () => {
    // 🔴 The regression that mattered most. With the pattern early in a function
    // body, an unanchored `\{([^}]*)\}` matched from the body brace and yielded
    // the body's leading tokens while MISSING the real name — then advised
    // exempting the fabricated one.
    const inBody = [
      'async function f(req) {',
      '  if (req.context) return null;',
      "  const { 'x-real-cred': c } = req.headers;",
      '  return c;',
      '}',
    ].join('\n');
    const found = extractReadsIn(inBody, 'headers');
    expect(found).toContain('x-real-cred');
    expect(found).not.toContain('if');
    expect(extractReadsIn('const { authorization } = req.headers;', 'headers')).toContain(
      'authorization'
    );
    // A rest element names no specific header.
    expect(extractReadsIn('const { ...rest } = req.headers;', 'headers')).not.toContain('...rest');
  });

  it('FAILS CLOSED on an unresolvable read, on every axis', () => {
    // headers/query: a call is a name we cannot determine -> sentinel.
    for (const bag of ['headers', 'query'] as const) {
      const found = extractReadsIn(`const t = req.${bag}[computeName()];`, bag);
      expect(
        found.some(isUnresolvable),
        `an unresolvable ${bag} read must surface, not vanish`
      ).toBe(true);
    }
    // cookies: a non-call expression is equally unresolvable.
    expect(
      extractReadsIn('const t = req.cookies[opts.name];', 'cookies').some(isUnresolvable),
      'an unresolvable cookie read must surface, not vanish'
    ).toBe(true);
    // A sentinel cannot be silenced through the exemption channel.
    expect(isExempt(NON_CREDENTIAL_HEADERS, `${UNRESOLVABLE}:k`)).toBe(false);
  });

  it('an UNKNOWN cookie helper is not silently accepted', () => {
    // The cookies axis records a helper CALL by name rather than as a sentinel,
    // because the cookie test can evaluate a known helper. The closure for an
    // UNKNOWN one is that test: it falls through to being treated as a literal
    // cookie name, which the predicate does not recognise, so the relationship
    // assertion goes red. Pinned here so the two halves cannot drift apart.
    const found = extractReadsIn('const t = req.cookies?.[mysteryCookieName()];', 'cookies');
    expect(found).toContain('mysteryCookieName');
    expect(Object.prototype.hasOwnProperty.call(COOKIE_HELPERS, 'mysteryCookieName')).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithCookie('mysteryCookieName'))).toBe(false);
  });

  it('refuses to resolve a constant declared twice with different values', () => {
    // Per-file scoping plus conflict-rejection: a colliding alias must become a
    // sentinel, never silently resolve onto an exempt name like `host`.
    const src = [
      "const CRED = 'host';",
      "const CRED = 'x-secret';",
      'const t = req.headers[CRED];',
    ].join('\n');
    const found = extractReadsIn(src, 'headers');
    expect(found.some(isUnresolvable)).toBe(true);
    expect(found).not.toContain('host');
  });

  it('ignores commented-out reads — and this control is not vacuous', () => {
    const src = [
      "      // const a = req.headers['x-commented'];",
      "      const b = req.headers['x-live'];",
    ].join('\n');
    const stripped = extractReadsIn(stripSourceComments(src), 'headers');
    expect(stripped).toContain('x-live');
    expect(stripped).not.toContain('x-commented');
    // Prove the fixture CAN express the failure: unstripped, it is found.
    expect(extractReadsIn(src, 'headers')).toContain('x-commented');
  });

  // ── Scope ──────────────────────────────────────────────────────────────────

  it('scans every module the session entry point imports', () => {
    // Both spellings: `~/server/…` is this repo's dominant style, and an earlier
    // version resolved only `./…`, so the LIKELY refactor was the uncaught one.
    const { local, packages } = moduleImports(ENTRY);
    const unscanned = local.filter(
      (f) => !SESSION_PATH_FILES.includes(f) && !isExempt(NON_CREDENTIAL_MODULES, f)
    );
    const undeclaredPackages = packages.filter((q) => !isExempt(NON_CREDENTIAL_PACKAGES, q));
    expect(
      undeclaredPackages,
      `${ENTRY} imports these workspace packages, which are not scanned and not declared: ` +
        `[${undeclaredPackages.join(', ')}]. They are this repo's own source, not third-party — ` +
        `declare each in NON_CREDENTIAL_PACKAGES with a reason.`
    ).toEqual([]);
    expect(
      unscanned,
      `${ENTRY} imports these modules, which are neither scanned for credential reads nor ` +
        `declared non-credential: [${unscanned.join(', ')}]. A credential read in one of them ` +
        `is invisible here. Add it to SESSION_PATH_FILES, or to NON_CREDENTIAL_MODULES with a reason.`
    ).toEqual([]);
  });

  it('no exemption is STALE — every declared entry must still be a real read', () => {
    // 🔴 A non-empty derivation cannot detect a dead exemption, though a comment
    // here once claimed it did. Measured: adding a bogus module or header name
    // to an exemption map left the suite green. A stale entry is evidence the
    // derivation's output was never read, and it silently widens the exemption
    // surface.
    const { local, packages } = moduleImports(ENTRY);
    const staleModules = Object.keys(NON_CREDENTIAL_MODULES).filter((k) => !local.includes(k));
    const stalePackages = Object.keys(NON_CREDENTIAL_PACKAGES).filter((k) => !packages.includes(k));
    const staleHeaders = Object.keys(NON_CREDENTIAL_HEADERS).filter(
      (k) => !extractReadsRaw('headers').includes(k)
    );
    const staleQuery = Object.keys(NON_CREDENTIAL_QUERY).filter(
      (k) => !extractReadsRaw('query').includes(k)
    );
    const staleCookies = Object.keys(NON_CREDENTIAL_COOKIES).filter(
      (k) => !extractReadsRaw('cookies').includes(k)
    );
    expect(
      { staleModules, stalePackages, staleHeaders, staleQuery, staleCookies },
      'these exemptions no longer match anything the session path reads — remove them'
    ).toEqual({
      staleModules: [],
      stalePackages: [],
      staleHeaders: [],
      staleQuery: [],
      staleCookies: [],
    });
  });

  it('sees a re-export as a dependency (regression)', () => {
    // `export … from` is a static, executed dependency. A previous version
    // caught it by accident with a bare `from '…'` match, and narrowing to
    // `import … from` silently dropped it — a re-exported credential-reading
    // module became invisible.
    const src = "export { qPeek } from './audit-quarantine';\nimport './side-effect';";
    // Parse the same way moduleImports does, on a fixture rather than the tree.
    const specs = [
      ...[...src.matchAll(/\b(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g)].map(
        (m) => m[1]
      ),
      ...[...src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ];
    expect(specs).toContain('./audit-quarantine');
    expect(specs).toContain('./side-effect');
  });

  it('destructuring fails CLOSED on shapes it cannot parse', () => {
    // The bracket axis failed closed while this one failed OPEN — a type
    // annotation, a brace-containing default, a nested pattern and an aliased
    // bag all passed silently.
    expect(extractReadsIn("const { 'x-a': c }: any = req.headers;", 'headers')).toContain('x-a');
    expect(extractReadsIn("const { 'x-b': c = {} } = req.headers;", 'headers')).toContain('x-b');
    expect(extractReadsIn("const { 'x-c': { d } } = req.headers as any;", 'headers')).toContain(
      'x-c'
    );
    // The keyword-less assignment form.
    expect(extractReadsIn("({ 'x-d': c } = req.headers as any);", 'headers')).toContain('x-d');
    // An ordinary read is NOT an alias — this distinction produced a false
    // sentinel on real source when the lookahead was missing.
    expect(
      extractReadsIn('const t = req.cookies?.[sessionCookieName()];', 'cookies').some(
        isUnresolvable
      ),
      'a normal bracket read must not be mistaken for an aliased bag'
    ).toBe(false);
    // Aliasing the bag hides every later read — that must be a sentinel.
    expect(
      extractReadsIn("const h = req.headers;\nconst t = h['x-hidden'];", 'headers').some(
        isUnresolvable
      ),
      'an aliased bag must fail closed'
    ).toBe(true);
  });

  it('sees a leading-underscore property name', () => {
    expect(extractReadsIn('const t = req.query?._apitoken;', 'query')).toContain('_apitoken');
  });

  // ── The relationship ───────────────────────────────────────────────────────

  it('every HEADER the session path reads is recognised as a credential', () => {
    const unrecognised = extractReads('headers').filter(
      (h) => !requestCarriesCallerCredentials(reqWithHeader(h))
    );
    expect(
      unrecognised,
      `the session layer reads these request headers, but requestCarriesCallerCredentials does ` +
        `not treat them as credentials: [${unrecognised.join(', ')}]. A request carrying one ` +
        `would be classified ANONYMOUS and its per-caller body cached publicly. Teach the ` +
        `predicate the spelling; or, if a name is <unresolvable>, make it resolvable (a literal ` +
        `or a single-valued const) rather than exempting it.`
    ).toEqual([]);
  });

  it('every QUERY PARAM is recognised on BOTH channels independently', () => {
    // req.query and req.url are separate branches in the predicate. Probing them
    // together let each shield the other's removal.
    const names = extractQueryReads();
    const missedInQuery = names.filter(
      (q) => !requestCarriesCallerCredentials(reqWithQueryOnly(q))
    );
    const missedInUrl = names.filter(
      (q) => !requestCarriesCallerCredentials(reqWithUrlQueryOnly(q))
    );
    expect(
      missedInQuery,
      `not recognised via req.query: [${missedInQuery.join(', ')}] — getServerAuthSession reads ` +
        `the parsed query, so the predicate must too.`
    ).toEqual([]);
    expect(
      missedInUrl,
      `not recognised via req.url: [${missedInUrl.join(', ')}] — getServerAuthSession parses ` +
        `req.url directly, so a predicate that only reads req.query can be bypassed.`
    ).toEqual([]);
  });

  it('every COOKIE the session path authenticates with is recognised', () => {
    // BEHAVIOURAL for helpers, and literal names are checked directly — an
    // earlier version matched ONLY `req.cookies[helper(` , so a literal or
    // const-aliased cookie name was dropped with no sentinel.
    const used = extractReads('cookies');
    const unresolved = used.filter(isUnresolvable);
    expect(
      unresolved,
      `cookie reads whose name could not be determined: [${unresolved.join(', ')}]`
    ).toEqual([]);

    for (const name of used) {
      const cookies = Object.prototype.hasOwnProperty.call(COOKIE_HELPERS, name)
        ? [COOKIE_HELPERS[name](true), COOKIE_HELPERS[name](false)]
        : [name];
      for (const cookie of cookies) {
        expect(
          requestCarriesCallerCredentials(reqWithCookie(cookie)),
          `the session path authenticates with the cookie "${cookie}" (from ${name}), but the ` +
            `predicate does not recognise it`
        ).toBe(true);
      }
    }
  });

  // ── Negative controls on the guard's own strictness ────────────────────────

  it('does NOT demand that unrelated request fields be credentials', () => {
    expect(requestCarriesCallerCredentials(reqWithHeader('accept-language'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithQueryOnly('limit'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithUrlQueryOnly('limit'))).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithCookie('theme'))).toBe(false);
  });

  it('exemption lookup does not fail open on prototype keys', () => {
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'constructor')).toBe(false);
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'valueOf')).toBe(false);
    expect(isExempt(NON_CREDENTIAL_HEADERS, 'host')).toBe(true);
  });
});
