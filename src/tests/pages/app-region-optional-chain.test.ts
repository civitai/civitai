import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 `region` IS AN SSR-ONLY PROP. `_app` MUST NOT DEREFERENCE IT UNGUARDED.
 *
 * ## The outage this pins
 *
 * `b8680eee65` (#5001) changed the Faro bootstrap from `<FaroProvider />` to
 * `<FaroProvider region={region.countryCode} />`. 🔴 It first SHIPPED in **v5.1.117**, not
 * v5.1.118 — `v5.1.116` still carries the bare `<FaroProvider />`, and `git tag --contains
 * b8680eee65` lists both v5.1.117 and v5.1.118. Start a bisect at v5.1.117.
 * `MyApp.getInitialProps` early-returns on a CLIENT-SIDE navigation:
 *
 *     const { req: request } = appContext.ctx;
 *     if (!request) return initialProps;
 *     // Everything below this point is only serverside
 *
 * `const region = getRegion(request)` lives below that guard, so on every client-side
 * route transition `region` is simply absent from `pageProps` and reads as `undefined`.
 * `undefined.countryCode` throws during render, inside the ROOT error boundary, and the
 * page white-screens. Only the FIRST (server-rendered) page load worked.
 *
 * It passed typecheck because `CustomAppProps` declared `region: RegionInfo` — correct
 * for SSR and wrong for the client-nav path. Making the type honest (`region?:`) is what
 * turns the recurrence into a compile error, which is why this file pins the TYPE too
 * and not only the call site.
 *
 * ## What this guard actually checks, stated as narrowly as it is implemented
 *
 *   1. Inside the body of `function MyApp`, EVERY property/element access on `region` is
 *      optional-chained (`region?.x`). It is a ledger over the whole component body, not a
 *      check on one line, so a second unguarded dereference added anywhere in `MyApp` fails
 *      too. 🔴 The base is UNWRAPPED first, so `region!.x` and `(region as T).x` are
 *      collected and reported as unguarded rather than going invisible — those are the two
 *      shapes `tsc` ALSO cannot see, and `region!.x` is the likeliest recurrence now that
 *      the type is honest, because it is the reflex edit that silences the new
 *      "'region' is possibly 'undefined'" error. The count is asserted non-zero: that is a
 *      floor on the ledger, not merely a vacuity guard — without it, deleting every access
 *      would pass.
 *   2. `MyApp` renders exactly one `<FaroProvider>`, and its `region=` attribute is
 *      EXACTLY the text `region?.countryCode`. Deliberately a literal-string assertion, not
 *      a shape check: it is the narrowest thing that can be wrong, prettier normalises
 *      whitespace so a reformat cannot move it, and its failure message names both sides.
 *      This is also the reachability half — (1) alone goes green if the call site simply
 *      disappears, which is not the same as being fixed.
 *   2b. Nothing in `MyApp` applies a `!` or a cast to `region` in ANY position. Separate
 *      from (1) because the `?.` ledger only looks at `<wrapper>.property`: `const r =
 *      region!; r.countryCode` passes both that ledger and `tsc`. See `regionAssertions`.
 *   3. `CustomAppProps.region` and `AppProvider`'s `AppContext.region` are declared
 *      OPTIONAL. These pin two DIFFERENT things. Re-tightening `CustomAppProps.region` is
 *      what would make `region.countryCode` compile again in this file. Re-tightening
 *      `AppContext.region` would instead make the two consumer guards added alongside this
 *      fix (`CivitaiSessionProvider`, `useRegionWarning`) dead code — `_app` reads `region`
 *      from `pageProps`, never from `useAppContext()`, so that half has no bearing on the
 *      `FaroProvider` line.
 *
 * ## What it does NOT check
 *
 * PLAIN aliasing (`const r = region; r.countryCode`) and plain destructuring
 * (`const { countryCode } = region`) escape the ledgers — the TYPE change in (3) covers
 * those, via `tsc`. The same spellings with a `!` or a cast escape `tsc` too, and (2b) is
 * what catches them. It says nothing about any other SSR-only prop; `region` is the one
 * that broke.
 *
 * It is deliberately OVER-strict in four known ways, none of them a bug: a narrowed plain
 * access (`if (!region) return null;` then `region.countryCode`), a renamed import of
 * `FaroProvider`, an unrelated binding that happens to be spelled `region` in a nested
 * callback (the walk matches identifier TEXT, not the binding), and
 * `(region as RegionInfo | undefined)?.x`, which is honest but still a cast. That
 * direction is the safe one — the test cannot pass while the hazard exists — but expect to
 * update it if you change the spelling on purpose.
 *
 * ## Why this is structural and not a render
 *
 * `MyApp` is not render-testable here: it is not exported (only `trpc.withTRPC(MyApp)` is),
 * it instantiates the entire root provider tree in one go, and it statically imports
 * `~/server/utils/region-blocking` at module scope, which browser-mode's dep scan follows.
 * `FaroProvider` also returns `null` and does its work in an effect, so a successful render
 * would yield nothing to assert beyond "did not throw".
 * The BEHAVIOURAL premise underneath all of this — that `getInitialProps` returns
 * `pageProps` with no `region` when there is no request — is pinned separately, against the
 * real `getInitialProps`, in `src/server/__tests__/app-settings-bootstrap.test.ts`.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_FILE = 'src/pages/_app.tsx';
const PROVIDER_FILE = 'src/providers/AppProvider.tsx';

function parse(relPath: string): ts.SourceFile {
  const abs = path.join(REPO_ROOT, relPath);
  const text = fs.readFileSync(abs, 'utf8');
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collect(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    if (predicate(n)) out.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

/** The `function MyApp(props: CustomAppProps) { … }` declaration body. */
function myAppBody(sourceFile: ts.SourceFile): ts.Block {
  const decl = collect(
    sourceFile,
    (n): n is ts.Node => ts.isFunctionDeclaration(n) && n.name?.text === 'MyApp'
  )[0] as ts.FunctionDeclaration | undefined;

  // Not `expect(...).toBeDefined()` plus a non-null assertion: if the component is renamed
  // this guard has lost its subject and must say so, not silently check nothing.
  if (!decl?.body) {
    throw new Error(
      `${APP_FILE}: no \`function MyApp\` with a body found. This guard's subject moved — ` +
        `re-point it at the component that renders <FaroProvider> rather than deleting it.`
    );
  }
  return decl.body;
}

/**
 * Strip the wrappers that HIDE a dereference from both this walk and from `tsc`:
 * `region!.x` (NonNullExpression), `(region).x`, `(region as T).x`,
 * `(region satisfies T).x`, and chains of those. Without this the base is not an
 * `Identifier`, so the access is never collected — it reads as absent rather than as
 * unguarded.
 *
 * `ts.isTypeAssertionExpression` is listed for completeness but is UNREACHABLE for this
 * subject: the angle-bracket form `<T>region` parses as JSX under `ts.ScriptKind.TSX`, so
 * it can never appear here. Do not cite it as covered.
 */
function unwrapBase(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/** Accesses whose base resolves to the `region` identifier, wrappers stripped. */
function regionAccesses(scope: ts.Node): MemberAccess[] {
  return collect(scope, (n) => {
    if (!ts.isPropertyAccessExpression(n) && !ts.isElementAccessExpression(n)) return false;
    const base = unwrapBase(n.expression);
    return ts.isIdentifier(base) && base.text === 'region';
  }) as MemberAccess[];
}

/**
 * Safe means optional-chained AND reached without a wrapper. `region!.x` carries no
 * `questionDotToken` anyway, but `(region as RegionInfo)?.x` would — and it is still an
 * assertion that the type is non-optional, so it must not count as safe.
 */
function isSafeAccess(node: MemberAccess): boolean {
  return node.questionDotToken !== undefined && unwrapBase(node.expression) === node.expression;
}

/**
 * 🔴 EVERY `!`/cast APPLIED TO `region`, IN ANY POSITION — not just in member-access
 * position. This is a SEPARATE ledger from the `?.` one on purpose.
 *
 * The reflex edit that silences "'region' is possibly 'undefined'" is `!` or a cast, and
 * `tsc` goes quiet the moment either appears. A ledger that only looks at
 * `<wrapper>.property` closes that reflex exactly where tsc's error points and leaves it
 * open ONE LINE UP, which is precisely where a developer who finds `region!.countryCode`
 * still red will move next. Measured: `const r = region!; r.countryCode`,
 * `const r = region as RegionInfo; r.countryCode`,
 * `const { countryCode } = region as RegionInfo;` and `takes(region!)` all passed the
 * `?.` ledger AND `tsc`. This ledger reports all four.
 */
function regionAssertions(scope: ts.Node): string[] {
  return collect(scope, (n) => {
    if (!ts.isNonNullExpression(n) && !ts.isAsExpression(n) && !ts.isSatisfiesExpression(n)) {
      return false;
    }
    const base = unwrapBase(n.expression);
    return ts.isIdentifier(base) && base.text === 'region';
  }).map((n) => n.getText());
}

function optionalPropertyNames(typeMembers: ts.NodeArray<ts.TypeElement>): string[] {
  return typeMembers
    .filter(
      (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.questionToken !== undefined
    )
    .map((m) => (ts.isIdentifier(m.name) ? m.name.text : ''));
}

describe('_app: `region` is SSR-only and must never be dereferenced unguarded', () => {
  it('every access on `region` inside MyApp is optional-chained', () => {
    const accesses = regionAccesses(myAppBody(parse(APP_FILE)));

    // A FLOOR on the ledger, not only a vacuity guard: if every `region` access is deleted
    // or rewritten into a shape this walk cannot see, the assertion below passes on an
    // empty set. Failing here says "the subject moved", which is the honest answer.
    expect(
      accesses.length,
      'no access on `region` found in MyApp — the subject moved; re-point this guard rather than deleting it'
    ).toBeGreaterThan(0);

    const unguarded = accesses.filter((a) => !isSafeAccess(a)).map((a) => a.getText());
    expect(
      unguarded,
      'each of these dereferences `region`, which is `undefined` on every client-side navigation. `?.` it — a `!` or a cast silences tsc without making it safe'
    ).toEqual([]);
  });

  it('nothing in MyApp asserts `region` away with a `!` or a cast, in any position', () => {
    expect(
      regionAssertions(myAppBody(parse(APP_FILE))),
      '`region` is `undefined` on every client-side navigation, so a non-null assertion or a cast is a lie that silences tsc. Narrow it or optional-chain it instead'
    ).toEqual([]);
  });

  it('the <FaroProvider> call site exists and passes an optional-chained region', () => {
    const body = myAppBody(parse(APP_FILE));

    const faro = collect(
      body,
      (n) =>
        (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
        ts.isIdentifier(n.tagName) &&
        n.tagName.text === 'FaroProvider'
    ) as (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[];

    if (faro.length !== 1) {
      throw new Error(
        `expected exactly one <FaroProvider> in MyApp, found ${faro.length}. If it was renamed ` +
          `or aliased on import, re-point this guard; if it was removed, delete this file.`
      );
    }

    const attr = faro[0].attributes.properties.find(
      (p): p is ts.JsxAttribute =>
        ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === 'region'
    );
    expect(attr).toBeDefined();

    const initializer = attr?.initializer;
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) {
      throw new Error('<FaroProvider region={…}> has no expression initializer');
    }
    expect(initializer.expression.getText()).toBe('region?.countryCode');
  });

  it('`region` is declared OPTIONAL on both prop types, so re-breaking it fails tsc', () => {
    const app = parse(APP_FILE);

    const customAppProps = collect(
      app,
      (n) => ts.isTypeAliasDeclaration(n) && n.name.text === 'CustomAppProps'
    )[0] as ts.TypeAliasDeclaration | undefined;
    if (!customAppProps) throw new Error(`${APP_FILE}: type CustomAppProps not found`);

    // Flattens every type literal under the alias. Exact today (there are two — `{ Component }`
    // and the `AppProps<…>` argument — and only one declares `region`); it would stop being
    // exact if a nested literal ever gained its own `region?:`.
    const appPropsOptional = (
      collect(customAppProps, ts.isTypeLiteralNode) as ts.TypeLiteralNode[]
    ).flatMap((lit) => optionalPropertyNames(lit.members));
    expect(
      appPropsOptional,
      'CustomAppProps.region must stay optional — it is what makes a bare `region.countryCode` in this file a compile error'
    ).toContain('region');

    const provider = parse(PROVIDER_FILE);
    const appContext = collect(
      provider,
      (n) => ts.isTypeAliasDeclaration(n) && n.name.text === 'AppContext'
    )[0] as ts.TypeAliasDeclaration | undefined;
    if (!appContext) throw new Error(`${PROVIDER_FILE}: type AppContext not found`);

    const contextOptional = (
      collect(appContext, ts.isTypeLiteralNode) as ts.TypeLiteralNode[]
    ).flatMap((lit) => optionalPropertyNames(lit.members));
    expect(
      contextOptional,
      'AppContext.region must stay optional — re-tightening it turns the guards in CivitaiSessionProvider and useRegionWarning into dead code'
    ).toContain('region');
  });
});
