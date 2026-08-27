import fs from 'fs';
import path from 'path';
import { legacySessionCookieName, sessionCookieName } from '@civitai/auth';
import type { NextApiRequest } from 'next';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
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
 * CDN. A virgin URL requested first WITH a credential correctly gets `private` +
 * `BYPASS`, so the origin predicate works and that third arm is a cache hit
 * rather than a misclassification.
 *
 * So if the session layer learns a credential spelling the predicate does not
 * recognise, a request carrying it is classified ANONYMOUS, gets
 * `public, s-maxage`, and its per-caller body is cached and served to other
 * people. Nothing throws.
 *
 * ── WHY THIS USES THE TYPESCRIPT AST, AND NOT A REGEX ────────────────────────
 * 🔴 Four successive adversarial sweeps rejected four regex-based versions of
 * this file, and the failure was the same every time: a pattern fixes the shapes
 * someone thought of and stays blind to the next ones. Measured casualties, each
 * a real credential read on the real session file that left the suite fully
 * green — a `const` alias; a destructured read; a computed key
 * `{ ['x-api-secret']: s }`; a parenthesized right-hand side `= (req.headers ?? {})`;
 * a read quarantined into a new module; a new cookie. Worse than the misses, two
 * versions FABRICATED a header name — anchoring on an enclosing brace or on a
 * type annotation's brace — and told the maintainer to exempt the fabrication,
 * which would have gone green with the real read still invisible.
 *
 * The lesson is not "write a better regex". JavaScript is not a regular
 * language, and every one of those defects is a parsing defect. The compiler
 * already parses it correctly, this repo already uses its AST for exactly this
 * kind of ledger (see `components/Apps/__tests__/appsStoreAccessCallSites.test.ts`),
 * and doing so also deletes the comment-stripping axis entirely — the AST never
 * sees a comment, so a commented-out read cannot be mistaken for a live one and
 * no stripper can over- or under-strip.
 *
 * WHAT IT CERTIFIES. Every read of `req.headers` / `req.query` / `req.cookies`
 * on the session path resolves to a name the predicate must recognise, or — when
 * the name cannot be determined statically — to a sentinel that FAILS. That
 * includes property access, element access with a literal or a resolvable
 * `const`, destructuring in every form the parser accepts, and assignment of the
 * whole bag to a variable (which hides later reads, so it fails closed).
 *
 * WHAT IT DOES NOT. A name computed at runtime surfaces as a sentinel failure,
 * but the guard cannot tell you what it is. A credential read reached other than
 * by a static import/export from the entry point is out of scope. And a
 * structural check cannot prove the predicate is CORRECT — only that it is asked
 * about every name the session path reads.
 */

const SRC = path.resolve(__dirname, '../../..');
const ENTRY = 'server/auth/get-server-auth-session.ts';

/** Modules that turn a raw request into a session. A ledger, enforced below. */
const SESSION_PATH_FILES = [ENTRY, 'server/auth/session-client.ts', 'server/auth/bearer-token.ts'];

/** Entry-point imports that do NOT read credentials off the request. */
const NON_CREDENTIAL_MODULES: Record<string, string> = {
  'server/auth/session-metrics.ts': 'counters only — takes no request',
  'server/utils/url-helpers.ts': 'builds a base URL from config; reads nothing off the request',
  'env/server.ts': 'environment config; reads nothing off the request',
  'env/other.ts': 'environment config; reads nothing off the request',
};

/** Workspace packages the entry point imports. Not scanned, so declared. */
const NON_CREDENTIAL_PACKAGES: Record<string, string> = {
  '@civitai/auth':
    'owns the cookie-NAME vocabulary and the legacy cookie decode; no `req` crosses this boundary — the session path reads req.cookies itself and passes only a string',
};

const NON_CREDENTIAL_HEADERS: Record<string, string> = {
  host: 'response-side only — the cookie domain for maybeRollHubCookie / maybeUpgradeLegacySession, never read to identify a caller',
};
const NON_CREDENTIAL_QUERY: Record<string, string> = {};
const NON_CREDENTIAL_COOKIES: Record<string, string> = {
  deviceCookieName:
    'a device identifier used for rolling/upgrade bookkeeping; authenticates nobody on its own',
};

const UNRESOLVABLE = '<unresolvable>';
const isUnresolvable = (n: string) => n.startsWith(UNRESOLVABLE);

/** `in` fails open on prototype keys; a sentinel may never be exempted. */
function isExempt(list: Record<string, string>, name: string): boolean {
  if (isUnresolvable(name)) return false;
  return Object.prototype.hasOwnProperty.call(list, name);
}

type Bag = 'headers' | 'query' | 'cookies';

function parse(rel: string): ts.SourceFile {
  const file = path.resolve(SRC, rel);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Strip parens / `as X` / `!` / `satisfies` so `(req.headers as any)!` is seen. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
    else if (ts.isNonNullExpression(n)) n = n.expression;
    else break;
  }
  return n;
}

/**
 * Is this expression `req.<bag>`, however parenthesised, asserted or defaulted?
 *
 * `?? {}` is included deliberately: `= (req.headers ?? {})` is still a read of
 * the bag, and a regex version that did not see through it shipped a live
 * unrecognised credential header green.
 */
function isBag(node: ts.Expression, bag: Bag): boolean {
  const n = unwrap(node);
  if (
    ts.isBinaryExpression(n) &&
    (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isBag(n.left, bag);
  }
  if (!ts.isPropertyAccessExpression(n) && !ts.isPropertyAccessChain(n)) return false;
  const obj = unwrap(n.expression as ts.Expression);
  return ts.isIdentifier(obj) && obj.text === 'req' && n.name.text === bag;
}

/** `const NAME = 'literal'` in one file; a conflicting redeclaration resolves to nothing. */
function literalConsts(sf: ts.SourceFile): Map<string, string> {
  const seen = new Map<string, string>();
  const conflicted = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isStringLiteralLike(init)) {
        const prev = seen.get(node.name.text);
        if (prev !== undefined && prev !== init.text) conflicted.add(node.name.text);
        seen.set(node.name.text, init.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const n of conflicted) seen.delete(n);
  return seen;
}

/** A property NAME from a binding element / element access, or a sentinel. */
function nameOf(node: ts.Node | undefined, consts: Map<string, string>, bag?: Bag): string {
  if (!node) return `${UNRESOLVABLE}:missing`;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return nameOfExpr(node.expression, consts, bag);
  return `${UNRESOLVABLE}:${node.getText().slice(0, 40)}`;
}

function nameOfExpr(expr: ts.Expression, consts: Map<string, string>, bag?: Bag): string {
  const e = unwrap(expr);
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) {
    const resolved = consts.get(e.text);
    return resolved ?? `${UNRESOLVABLE}:${e.text}`;
  }
  // COOKIES only: names come from helpers (`sessionCookieName()`), and the
  // cookie test can EVALUATE a known one. There is no such convention on
  // headers/query, so a call there stays unresolvable.
  if (bag === 'cookies' && ts.isCallExpression(e) && ts.isIdentifier(e.expression))
    return e.expression.text;
  return `${UNRESOLVABLE}:${e.getText().slice(0, 40)}`;
}

/**
 * Every name read off `req.<bag>` in one source file.
 *
 * Fails CLOSED twice over: an undeterminable name becomes a sentinel, and
 * assigning the WHOLE bag to something becomes a sentinel too, because every
 * later read through that alias is invisible to any static analysis.
 */
function extractReadsFrom(sf: ts.SourceFile, bag: Bag, applyExemptions = true): string[] {
  const consts = literalConsts(sf);
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    // req.headers.authorization
    if (
      (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) &&
      isBag(node.expression as ts.Expression, bag)
    ) {
      names.add(node.name.text);
    }

    // req.headers['x'] / req.headers[K] / req.headers[f()]
    if (
      (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) &&
      isBag(node.expression as ts.Expression, bag)
    ) {
      names.add(nameOfExpr(node.argumentExpression, consts, bag));
    }

    // const { a, 'b-c': d, [K]: e } = req.headers   (and the assignment form)
    const bound = (target: ts.Node, source: ts.Expression) => {
      if (!isBag(source, bag)) return;
      if (ts.isObjectBindingPattern(target)) {
        for (const el of target.elements) {
          if (el.dotDotDotToken) continue; // a rest element names nothing specific
          names.add(nameOf(el.propertyName ?? el.name, consts, bag));
        }
        return;
      }
      if (ts.isObjectLiteralExpression(target)) {
        // `({ 'x': c } = req.headers)` parses the LHS as an object literal.
        for (const p of target.properties) {
          if (ts.isShorthandPropertyAssignment(p)) names.add(p.name.text);
          else if (ts.isPropertyAssignment(p)) names.add(nameOf(p.name, consts, bag));
          else if (ts.isSpreadAssignment(p)) continue;
          else names.add(`${UNRESOLVABLE}:${p.getText().slice(0, 40)}`);
        }
        return;
      }
      // `const h = req.headers` — the bag ESCAPES; later reads are invisible.
      names.add(`${UNRESOLVABLE}:aliased-${bag}`);
    };

    if (ts.isVariableDeclaration(node) && node.initializer) bound(node.name, node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isBag(node.right, bag)
    ) {
      bound(unwrap(node.left as ts.Expression), node.right);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!applyExemptions) return [...names];
  const exempt =
    bag === 'headers'
      ? NON_CREDENTIAL_HEADERS
      : bag === 'query'
      ? NON_CREDENTIAL_QUERY
      : NON_CREDENTIAL_COOKIES;
  return [...names].filter((n) => !isExempt(exempt, n));
}

/** Query params also arrive via `new URL(...).searchParams.get('x')`. */
function searchParamReads(sf: ts.SourceFile, consts: Map<string, string>): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ||
        ts.isPropertyAccessChain(node.expression)) &&
      node.expression.name.text === 'get'
    ) {
      const recv = unwrap(node.expression.expression as ts.Expression);
      const isSearchParams =
        (ts.isPropertyAccessExpression(recv) || ts.isPropertyAccessChain(recv)) &&
        recv.name.text === 'searchParams';
      if (isSearchParams && node.arguments.length) out.push(nameOfExpr(node.arguments[0], consts));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function extractReads(bag: Bag, applyExemptions = true): string[] {
  const out = new Set<string>();
  for (const rel of SESSION_PATH_FILES) {
    const sf = parse(rel);
    for (const n of extractReadsFrom(sf, bag, applyExemptions)) out.add(n);
    if (bag === 'query')
      for (const n of searchParamReads(sf, literalConsts(sf))) {
        if (applyExemptions && isExempt(NON_CREDENTIAL_QUERY, n)) continue;
        out.add(n);
      }
  }
  return [...out];
}

/**
 * Modules and workspace packages a source file depends on, from the AST.
 *
 * 🔴 Split from `moduleImports` so it can be exercised DIRECTLY. The previous
 * version's regression test re-implemented the parse on a fixture instead of
 * calling the real function, so deleting `export … from` support from the real
 * one left the suite green — the fix was real and nothing tested it. A scope
 * ledger can only flag what it FINDS, so a detection gap is invisible to it by
 * construction; the only way to cover one is to test the finder.
 */
function depsOf(sf: ts.SourceFile, dir: string): { local: string[]; packages: string[] } {
  const local = new Set<string>();
  const packages = new Set<string>();

  for (const st of sf.statements) {
    let spec: string | undefined;
    let typeOnly = false;
    if (ts.isImportDeclaration(st)) {
      spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      typeOnly = !!st.importClause?.isTypeOnly;
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      // `export … from '…'` is a static, executed dependency.
      spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      typeOnly = st.isTypeOnly;
    }
    if (!spec || typeOnly) continue;

    if (spec.startsWith('@civitai/')) {
      packages.add(spec);
      continue;
    }
    const abs = spec.startsWith('~/')
      ? path.resolve(SRC, spec.slice(2))
      : spec.startsWith('.')
      ? path.resolve(dir, spec)
      : null;
    if (!abs) continue;
    for (const cand of [`${abs}.ts`, `${abs}.tsx`, `${abs}/index.ts`]) {
      if (fs.existsSync(cand)) {
        local.add(cand.slice(SRC.length + 1));
        break;
      }
    }
  }
  return { local: [...local], packages: [...packages] };
}

function moduleImports(rel: string): { local: string[]; packages: string[] } {
  return depsOf(parse(rel), path.resolve(SRC, rel, '..'));
}

/** Parse a snippet the same way the real files are parsed (for the unit cases). */
function readsIn(code: string, bag: Bag): string[] {
  const sf = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.Latest, true);
  return extractReadsFrom(sf, bag);
}

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
function reqWithQueryOnly(name: string): NextApiRequest {
  return {
    headers: {},
    cookies: {},
    query: { [name]: 'synthetic-value' },
    url: '/api/v1/x',
  } as unknown as NextApiRequest;
}
function reqWithUrlQueryOnly(name: string): NextApiRequest {
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

const COOKIE_HELPERS: Record<string, (secure?: boolean) => string> = {
  sessionCookieName,
  legacySessionCookieName,
};

describe('credential detection is a superset of the session layer', () => {
  // ── Controls on the derivation ─────────────────────────────────────────────

  it('every listed session-path file exists and parses', () => {
    for (const rel of SESSION_PATH_FILES) {
      expect(fs.existsSync(path.resolve(SRC, rel)), `${rel} is listed but does not exist`).toBe(
        true
      );
      const sf = parse(rel);
      expect(sf.statements.length, `${rel} parsed to nothing`).toBeGreaterThan(0);
    }
  });

  it('finds the credential spellings we KNOW exist', () => {
    expect(extractReads('headers')).toContain('authorization');
    expect(extractReads('query')).toContain('token');
    expect(extractReads('cookies').sort()).toEqual(
      ['legacySessionCookieName', 'sessionCookieName'].sort()
    );
  });

  it('the import derivation is not empty, and reaches re-exports', () => {
    const { local } = moduleImports(ENTRY);
    expect(local).toContain('server/auth/bearer-token.ts');
    expect(local).toContain('server/auth/session-client.ts');
  });

  it('the dependency finder sees import, export-from and side-effect forms', () => {
    // Exercises depsOf ITSELF — not a re-implementation. `export … from` is a
    // static, executed dependency: a re-exported credential-reading module is
    // as reachable as an imported one, and a previous version silently stopped
    // seeing it.
    const dir = path.resolve(SRC, 'server/auth');
    const sf = ts.createSourceFile(
      'synthetic.ts',
      [
        "export { x } from './bearer-token';",
        "import './session-metrics';",
        "import { y } from '~/server/auth/session-client';",
        "import type { T } from './session-metrics';",
        "import { z } from '@civitai/auth';",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true
    );
    const { local, packages } = depsOf(sf, dir);
    expect(local, 'export … from must be a dependency').toContain('server/auth/bearer-token.ts');
    expect(local, 'a side-effect import must be a dependency').toContain(
      'server/auth/session-metrics.ts'
    );
    expect(local, '~/ specifiers must resolve').toContain('server/auth/session-client.ts');
    expect(packages, 'workspace packages must be surfaced').toContain('@civitai/auth');
  });

  it('parses every read shape, including the ones four regexes missed', () => {
    // Each line below was a measured fail-open or fabrication in some earlier
    // regex version of this file.
    expect(readsIn("const t = req.headers['x-api-key'];", 'headers')).toContain('x-api-key');
    expect(readsIn("const t = req.headers?.['x-fwd'];", 'headers')).toContain('x-fwd');
    expect(readsIn("const H = 'x-alias';\nconst t = req.headers[H];", 'headers')).toContain(
      'x-alias'
    );
    expect(readsIn('const { authorization } = req.headers;', 'headers')).toContain('authorization');
    expect(readsIn("const { 'x-a': c }: any = req.headers;", 'headers')).toContain('x-a');
    expect(readsIn("const { 'x-b': c = {} } = req.headers;", 'headers')).toContain('x-b');
    expect(readsIn("const { 'x-c': { d } } = req.headers as any;", 'headers')).toContain('x-c');
    expect(readsIn("({ 'x-d': c } = req.headers as any);", 'headers')).toContain('x-d');
    // Computed key and parenthesized RHS — both shipped GREEN in the last version.
    expect(readsIn("const { ['x-e']: s } = req.headers;", 'headers')).toContain('x-e');
    expect(readsIn("const { 'x-f': s } = (req.headers ?? {}) as any;", 'headers')).toContain('x-f');
    expect(readsIn("const t = (req.headers ?? {})['x-h'];", 'headers')).toContain('x-h');
    // A type annotation that is an object literal — the shape that FABRICATED a
    // header name and advised exempting it.
    const ann = readsIn("const { 'x-g': c }: { other?: string } = req.headers;", 'headers');
    expect(ann).toContain('x-g');
    expect(ann).not.toContain('other');
    expect(readsIn('const t = req.query?._apitoken;', 'query')).toContain('_apitoken');
    expect(readsIn("const t = req.cookies?.['civ-alt'];", 'cookies')).toContain('civ-alt');
  });

  it('a comment is never a read (no stripper needed — the AST has none)', () => {
    const src = [
      "// const a = req.headers['x-commented'];",
      "const b = req.headers['x-live'];",
    ].join('\n');
    const found = readsIn(src, 'headers');
    expect(found).toContain('x-live');
    expect(found).not.toContain('x-commented');
  });

  it('FAILS CLOSED on an undeterminable name, and on an aliased bag', () => {
    for (const bag of ['headers', 'query'] as const) {
      expect(
        readsIn(`const t = req.${bag}[computeName()];`, bag).some(isUnresolvable),
        `an unresolvable ${bag} read must surface`
      ).toBe(true);
    }
    // Cookies name themselves through helpers, so a CALL is recorded by callee
    // name (the cookie test evaluates known ones and rejects unknown ones — see
    // below). A non-call expression there is still unresolvable.
    expect(readsIn('const t = req.cookies[opts.name];', 'cookies').some(isUnresolvable)).toBe(true);
    expect(
      readsIn('const { [dyn]: s } = req.headers;', 'headers').some(isUnresolvable),
      'an unresolvable computed key must surface'
    ).toBe(true);
    for (const alias of [
      'const h = req.headers;',
      'const h = req.headers ?? {};',
      'const h = (req.headers as any)!;',
    ]) {
      expect(readsIn(alias, 'headers').some(isUnresolvable), `aliased: ${alias}`).toBe(true);
    }
    // An ordinary read is NOT an alias.
    expect(
      readsIn('const t = req.cookies?.[sessionCookieName()];', 'cookies').some(isUnresolvable)
    ).toBe(false);
    // A sentinel can never be silenced through an exemption map.
    expect(isExempt(NON_CREDENTIAL_HEADERS, `${UNRESOLVABLE}:k`)).toBe(false);
  });

  it('an UNKNOWN cookie helper is not silently accepted', () => {
    // The closure for an unrecognised helper is the cookie relationship test: it
    // falls through to being treated as a literal cookie name, which the
    // predicate does not recognise, so that assertion goes red. Pinned here so
    // the two halves cannot drift apart.
    const found = readsIn('const t = req.cookies?.[mysteryCookieName()];', 'cookies');
    expect(found).toContain('mysteryCookieName');
    expect(Object.prototype.hasOwnProperty.call(COOKIE_HELPERS, 'mysteryCookieName')).toBe(false);
    expect(requestCarriesCallerCredentials(reqWithCookie('mysteryCookieName'))).toBe(false);
  });

  it('refuses to resolve a constant declared twice with different values', () => {
    const found = readsIn(
      ["const CRED = 'host';", "const CRED = 'x-secret';", 'const t = req.headers[CRED];'].join(
        '\n'
      ),
      'headers'
    );
    expect(found.some(isUnresolvable)).toBe(true);
    expect(found).not.toContain('host');
  });

  it('no exemption is STALE', () => {
    const { local, packages } = moduleImports(ENTRY);
    expect({
      modules: Object.keys(NON_CREDENTIAL_MODULES).filter((k) => !local.includes(k)),
      packages: Object.keys(NON_CREDENTIAL_PACKAGES).filter((k) => !packages.includes(k)),
      headers: Object.keys(NON_CREDENTIAL_HEADERS).filter(
        (k) => !extractReads('headers', false).includes(k)
      ),
      query: Object.keys(NON_CREDENTIAL_QUERY).filter(
        (k) => !extractReads('query', false).includes(k)
      ),
      cookies: Object.keys(NON_CREDENTIAL_COOKIES).filter(
        (k) => !extractReads('cookies', false).includes(k)
      ),
    }).toEqual({ modules: [], packages: [], headers: [], query: [], cookies: [] });
  });

  // ── Scope ──────────────────────────────────────────────────────────────────

  it('scans every module and package the session entry point depends on', () => {
    const { local, packages } = moduleImports(ENTRY);
    const unscanned = local.filter(
      (f) => !SESSION_PATH_FILES.includes(f) && !isExempt(NON_CREDENTIAL_MODULES, f)
    );
    const undeclared = packages.filter((q) => !isExempt(NON_CREDENTIAL_PACKAGES, q));
    expect(
      unscanned,
      `${ENTRY} depends on these modules, neither scanned nor declared: [${unscanned.join(', ')}]`
    ).toEqual([]);
    expect(
      undeclared,
      `${ENTRY} imports these workspace packages, neither scanned nor declared: ` +
        `[${undeclared.join(', ')}]`
    ).toEqual([]);
  });

  // ── The relationship ───────────────────────────────────────────────────────

  it('every HEADER the session path reads is recognised as a credential', () => {
    const missed = extractReads('headers').filter(
      (h) => !requestCarriesCallerCredentials(reqWithHeader(h))
    );
    expect(
      missed,
      `the session layer reads these headers, but requestCarriesCallerCredentials does not treat ` +
        `them as credentials: [${missed.join(', ')}]. A request carrying one would be classified ` +
        `ANONYMOUS and its per-caller body cached publicly. Teach the predicate the spelling; if a ` +
        `name is <unresolvable>, make it statically determinable rather than exempting it.`
    ).toEqual([]);
  });

  it('every QUERY PARAM is recognised on BOTH channels independently', () => {
    const names = extractReads('query');
    const viaQuery = names.filter((q) => !requestCarriesCallerCredentials(reqWithQueryOnly(q)));
    const viaUrl = names.filter((q) => !requestCarriesCallerCredentials(reqWithUrlQueryOnly(q)));
    expect(viaQuery, `not recognised via req.query: [${viaQuery.join(', ')}]`).toEqual([]);
    expect(viaUrl, `not recognised via req.url: [${viaUrl.join(', ')}]`).toEqual([]);
  });

  it('every COOKIE the session path authenticates with is recognised', () => {
    const used = extractReads('cookies');
    const unresolved = used.filter(isUnresolvable);
    expect(unresolved, `cookie names not determinable: [${unresolved.join(', ')}]`).toEqual([]);
    for (const name of used) {
      const cookies = Object.prototype.hasOwnProperty.call(COOKIE_HELPERS, name)
        ? [COOKIE_HELPERS[name](true), COOKIE_HELPERS[name](false)]
        : [name];
      for (const cookie of cookies)
        expect(
          requestCarriesCallerCredentials(reqWithCookie(cookie)),
          `the session path authenticates with cookie "${cookie}" (from ${name}), unrecognised`
        ).toBe(true);
    }
  });

  // ── Negative controls ──────────────────────────────────────────────────────

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
