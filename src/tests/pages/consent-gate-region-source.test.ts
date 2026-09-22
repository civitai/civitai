import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE CONSENT GATE'S REGION MUST COME FROM CONTEXT, NEVER FROM AN `_app` PROP.
 *
 * ## The fail-open this pins
 *
 * `isConsentRequired(region)` returns **false** for an absent region — correct for a genuinely
 * unknown one, and a compliance hole for a *missing* one. `ThirdPartyConsentProvider`
 * re-evaluates it on every render, so the question is entirely "where does `region` come from,
 * and is that source still populated after a client-side navigation".
 *
 * `_app`'s `region` is not. `MyApp.getInitialProps` early-returns on a client-side navigation
 * (`if (!request) return initialProps;`) and `const region = getRegion(request)` lives below
 * that guard — pinned against the real `getInitialProps` by the `SERVERSIDE_ONLY_PROPS` ledger
 * in `src/server/__tests__/app-settings-bootstrap.test.ts`. Threading that prop in meant a
 * California visitor who had REJECTED third-party analytics/advertising had `CAConsentManager`
 * unmounted on their first client-side navigation, dropping every `useThirdPartyConsent()`
 * consumer onto the context default (`allowed: true`) for the rest of the session. Same root
 * cause as the `<FaroProvider region={region.countryCode}>` white-screen (#5001, pinned by
 * `src/tests/pages/app-region-optional-chain.test.ts`) — that one threw, this one did not.
 *
 * `useAppContext().region` is the durable source: `AppProvider` freezes its context value in a
 * `useState` initializer at mount, seeded from the same SSR region.
 *
 * ## Why STRUCTURAL as well as behavioural
 *
 * The behaviour is covered by
 * `src/components/Consent/ThirdPartyConsentProvider.browser.test.tsx`, which mounts the real
 * `AppProvider` and drives a navigation. That file is the one that would catch `AppProvider`
 * losing its freeze. What it CANNOT see is `_app` itself: it models `_app`'s wiring rather
 * than importing it (`MyApp` is not exported, and it instantiates the entire root provider
 * tree). So a revert that re-adds `region={region}` to the `_app` call site and re-adds the
 * prop to the component would be a working pair that the browser test's own harness does not
 * reproduce. This file is what fails on that revert, by name.
 *
 * ## What it checks, stated as narrowly as it is implemented
 *
 *   1. `_app` renders exactly one `<ThirdPartyConsentProvider>`, and that element carries
 *      neither a `region` attribute nor ANY JSX spread — a spread could smuggle one in without
 *      the attribute ever appearing.
 *   2. The component's `Props` type declares no `region` member, so re-adding the call site
 *      alone is a compile error rather than a silently-ignored prop.
 *   3. The component binds `region` by DESTRUCTURING a `useAppContext()` call.
 *   4. `useMaybeAppContext` is used nowhere in the component file — its own `it`, not a
 *      trailing assertion on (3), because every mutant that reaches for it ALSO breaks (3)'s
 *      ledger and would leave this one unexecuted. It is the sharp check: that hook returns
 *      `undefined` outside a provider instead of throwing, so swapping to it restores this
 *      exact fail-open while reading as defensive code.
 *   5. `isConsentRequired` is called exactly once in the component file and its argument is
 *      EXACTLY the text `region`. The count is the reachability half — (2), (3) and (4) go
 *      green if the gate is simply deleted, which is not the same as being fixed. WHICH
 *      `region` that identifier is bound to is (3)'s claim, not this one's; the two together
 *      are what say the gate is evaluated on the context value.
 *
 * ## What it does NOT check
 *
 * That `AppProvider` still freezes its value (the browser test owns that), and anything about
 * `CONSENT_REQUIRED_REGIONS`' membership. It is deliberately over-strict about spelling: a
 * renamed import of `ThirdPartyConsentProvider` or `useAppContext`, or reading region via
 * `useAppContext().region` without destructuring, fails here even though it is safe. That
 * direction cannot pass while the hazard exists — update it if you change the spelling on
 * purpose.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_FILE = 'src/pages/_app.tsx';
const CONSENT_FILE = 'src/components/Consent/ThirdPartyConsentProvider.tsx';

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

/** The `export function ThirdPartyConsentProvider(...) { … }` declaration body. */
function consentComponentBody(sourceFile: ts.SourceFile): ts.Block {
  const decl = collect(
    sourceFile,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'ThirdPartyConsentProvider'
  )[0] as ts.FunctionDeclaration | undefined;

  // Not `expect(...).toBeDefined()` plus a non-null assertion: if the component is renamed this
  // guard has lost its subject and must say so rather than silently checking nothing.
  if (!decl?.body) {
    throw new Error(
      `${CONSENT_FILE}: no \`function ThirdPartyConsentProvider\` with a body found. This ` +
        `guard's subject moved — re-point it at the component that decides whether the ` +
        `consent gate mounts, rather than deleting it.`
    );
  }
  return decl.body;
}

/** The opening elements of every `<ThirdPartyConsentProvider …>` in a file. */
function consentProviderElements(scope: ts.Node) {
  return collect(
    scope,
    (n) =>
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === 'ThirdPartyConsentProvider'
  ) as (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[];
}

describe('the consent gate reads `region` from context, never from an `_app` prop', () => {
  it('`_app` passes no `region` — and no spread that could carry one — to the consent provider', () => {
    const elements = consentProviderElements(parse(APP_FILE));

    if (elements.length !== 1) {
      throw new Error(
        `expected exactly one <ThirdPartyConsentProvider> in ${APP_FILE}, found ` +
          `${elements.length}. If it was renamed or aliased on import, re-point this guard; ` +
          `if it was removed, the consent gate is gone and this file should go with it.`
      );
    }

    const props = elements[0].attributes.properties;

    const named = props
      .filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name))
      .map((p) => (p.name as ts.Identifier).text);
    expect(
      named,
      '`region` is SSR-only — it is `undefined` on every client-side navigation, so threading ' +
        'it here makes the consent gate unmount mid-session and every consumer fall through ' +
        'to the ALLOW default. The component reads `useAppContext().region` instead'
    ).not.toContain('region');

    // Separate from the ledger above because a spread carries no attribute NAME to find:
    // `{...{ region }}` or `{...props}` would pass the check above while doing the same damage.
    const spreads = props.filter(ts.isJsxSpreadAttribute).map((p) => p.getText());
    expect(
      spreads,
      'a JSX spread on <ThirdPartyConsentProvider> can smuggle a `region` prop past the ' +
        'attribute ledger above — pass props explicitly here'
    ).toEqual([]);

    // Reachability floor: this element is supposed to carry the two props it does take, so an
    // empty attribute list means the call site was gutted rather than fixed.
    expect(named).toEqual(expect.arrayContaining(['initialConsent', 'loggedIn']));
  });

  it('the component declares no `region` prop, so re-adding the call site fails tsc', () => {
    const consent = parse(CONSENT_FILE);

    const propsAlias = collect(
      consent,
      (n) => ts.isTypeAliasDeclaration(n) && n.name.text === 'Props'
    )[0] as ts.TypeAliasDeclaration | undefined;
    if (!propsAlias) throw new Error(`${CONSENT_FILE}: type Props not found`);

    const members = (collect(propsAlias, ts.isTypeLiteralNode) as ts.TypeLiteralNode[]).flatMap(
      (lit) =>
        lit.members
          .filter((m): m is ts.PropertySignature => ts.isPropertySignature(m))
          .map((m) => (ts.isIdentifier(m.name) ? m.name.text : ''))
    );

    expect(
      members,
      'Props must NOT declare `region` — its absence is what turns a re-added ' +
        '`<ThirdPartyConsentProvider region={region}>` in _app into a compile error instead of ' +
        'a silently-ignored prop'
    ).not.toContain('region');
    // A floor on the ledger: without this, deleting every member would pass.
    expect(members).toEqual(expect.arrayContaining(['children', 'initialConsent', 'loggedIn']));
  });

  it('`region` is destructured from `useAppContext()`', () => {
    const body = consentComponentBody(parse(CONSENT_FILE));

    const boundFromAppContext = (
      collect(body, ts.isVariableDeclaration) as ts.VariableDeclaration[]
    )
      .filter(
        (d) =>
          d.initializer !== undefined &&
          ts.isCallExpression(d.initializer) &&
          ts.isIdentifier(d.initializer.expression) &&
          d.initializer.expression.text === 'useAppContext'
      )
      .flatMap((d) =>
        ts.isObjectBindingPattern(d.name)
          ? d.name.elements.map((e) => (ts.isIdentifier(e.name) ? e.name.text : ''))
          : []
      );

    expect(
      boundFromAppContext,
      '`region` must be bound from `useAppContext()` — the value AppProvider freezes at mount, ' +
        'and the only region source that survives a client-side navigation'
    ).toContain('region');
  });

  // 🔴 ITS OWN `it` ON PURPOSE, not a second assertion in the test above. Every mutant that
  // reaches for `useMaybeAppContext` ALSO breaks the destructure ledger, so folded in as a
  // trailing assertion this one would never execute — it would be scored as killing mutants
  // that a different, earlier assertion actually killed. Measured: that is exactly what the
  // first version of this file did.
  it('`useMaybeAppContext` is not used — it would restore the fail-open silently', () => {
    const consent = parse(CONSENT_FILE);

    // 🔴 The sharp one. `useMaybeAppContext` hands back `undefined` outside a provider instead
    // of throwing, so swapping to it re-opens this exact fail-open while reading as defensive
    // code. A broken provider nesting must be a loud developer error, not a quiet compliance
    // regression. Whole-file, not just the component body — an aliasing import counts.
    //
    // 🔴 Identifier nodes, NOT `sourceFile.getText().includes(...)`: the file DOCUMENTS why it
    // does not use this hook, and a text scan reads that prose as a usage. Measured — the first
    // version of this assertion failed on the very comment explaining the rule.
    const maybeUsages = collect(
      consent,
      (n) => ts.isIdentifier(n) && n.text === 'useMaybeAppContext'
    ).map((n) => n.parent?.getText() ?? '(no parent)');
    expect(
      maybeUsages,
      `${CONSENT_FILE} must not use useMaybeAppContext: it returns undefined outside an ` +
        'AppProvider, and `isConsentRequired(undefined)` is false — the consent gate would ' +
        'silently disappear instead of the misnesting being reported'
    ).toEqual([]);
  });

  // Narrower than it may read: this pins that the call EXISTS, happens once, and is handed the
  // bare identifier `region`. WHICH `region` that identifier is bound to is pinned by the
  // destructure ledger above, not here — these two together are the claim.
  it('the gate is still evaluated, exactly once, on the bare `region` identifier', () => {
    const body = consentComponentBody(parse(CONSENT_FILE));

    const calls = (collect(body, ts.isCallExpression) as ts.CallExpression[]).filter(
      (c) => ts.isIdentifier(c.expression) && c.expression.text === 'isConsentRequired'
    );

    // Reachability: the two guards above are equally happy with a component that no longer
    // decides anything. This is what says the decision is still being made.
    expect(
      calls.length,
      'expected exactly one `isConsentRequired(...)` call in ThirdPartyConsentProvider'
    ).toBe(1);

    expect(
      calls[0].arguments.map((a) => a.getText()),
      'the gate must be evaluated on the context-derived `region`, not on a prop or a fallback'
    ).toEqual(['region']);
  });
});
