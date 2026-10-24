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
 * ⚠️ SECOND COPY. `REPO_ROOT`, `APP_FILE`, `parse`, `collect`, the component/`_app` subject
 * locators and the type-literal member walk below are duplicated in the directory sibling
 * `src/tests/pages/app-region-optional-chain.test.ts`, which pins the FaroProvider white-screen
 * over the same `_app.tsx` and the same `region` variable. Copy-per-guard is this directory's
 * convention (measured at this commit: 25 files under `src/` call `ts.createSourceFile`,
 * across 34 call sites, and none imports an AST-scanning helper from another module — though
 * shared test helpers do exist, so the convention rests on habit and on divergent policies, not
 * on there being nowhere to put one — and `test/strip-comments.ts` exists precisely BECAUSE a
 * scanning technique was copied to a second site, diverged, and produced a false pass, so this
 * is a bet the repo has already lost once — against which
 * `src/components/Apps/AppsBuildBodySkeleton.ssr.browser.test.tsx` records the opposite
 * precedent deliberately, for a copy of this same shape: "four lines of scanner, and each copy
 * carries its own positive control below, which is the thing that actually keeps it honest"),
 * and the duplication was left in place deliberately — but it is recorded here so the next
 * person sees it rather than rediscovering it. The ASYMMETRIC pair is `jsxOpeners` /
 * `soleJsxOpener` / `jsxAttr`: the sibling open-codes the same find-by-tag → assert-exactly-one →
 * find-named-attribute logic inline around its `<FaroProvider>` check, so a fix to either side
 * will not reach the other and — unlike the byte-identical copies — nobody will notice they were
 * the same thing. What does NOT transfer, and is the reason the
 * two files needed different hardening: every type-literal ledger in the sibling is asserted
 * with `.toContain(...)`, which fails LOUD on a member it cannot see, while this file's is
 * `.not.toContain(...)` — the one polarity that can go VACUOUSLY GREEN, which is why the
 * bare-object-literal and index-signature guards exist here and have no analogue there.
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
 *   0a. `_app` passes `region={region}` to `<AppProvider>`. THE PRODUCER SIDE, and since the
 *      consent prop was removed it is the gate's only remaining input — see that test's own
 *      header for why dropping it is silent and universal.
 *   0b. `<ThirdPartyConsentProvider>` is a DESCENDANT of `<AppProvider>` in `_app`. This is what
 *      makes `useAppContext()`'s throw unreachable; nothing else here asserts a tree shape.
 *   1. `_app` renders exactly one `<ThirdPartyConsentProvider>`, and that element carries
 *      neither a `region` attribute nor ANY JSX spread — a spread could smuggle one in without
 *      the attribute ever appearing.
 *   2. The component's `Props` type declares no `region` member AND its parameter is annotated
 *      with the bare `Props` identifier, so re-adding the call site is a compile error rather
 *      than a silently-ignored prop. Both halves are needed: widening the annotation in place
 *      (`Props & { region?: … }`) leaves the alias untouched and re-opens the call site.
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
 * how `region` is DERIVED or which regions are in `CONSENT_REQUIRED_REGIONS` — this file pins
 * the wiring only. It is deliberately over-strict about spelling: a
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

/**
 * The `export function ThirdPartyConsentProvider(...)` declaration. ONE locator for the subject
 * three of the tests below share: the anticipated evolution (an arrow-function `const`) breaks
 * every consumer of it at once, and a second copy would give the fixer two failures prescribing
 * two different remedies for one edit.
 *
 * Not `expect(...).toBeDefined()` plus a non-null assertion: if the component is renamed this
 * guard has lost its subject and must say so rather than silently checking nothing.
 */
function consentComponentDecl(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  const found = collect(
    sourceFile,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'ThirdPartyConsentProvider'
  ) as ts.FunctionDeclaration[];

  // 🔴 NON-UNIQUE IS REFUSED TOO, and this is the likelier of the two locators to need it:
  // `collect` walks nested scopes, and a nested `function ThirdPartyConsentProvider(){}` inside
  // another function is legal TS, so `[0]` could pick the decoy. Measured: pre-hardening that
  // was not SILENT — it turned three tests red with three misleading diagnoses. The win here is
  // the message, not the detection. (A second MODULE-scope
  // `type Props` is a TS duplicate-identifier error, which is why the alias locator's version of
  // this is the weaker of the pair.) Found by the `civitai-reuse-review` lane, which caught the
  // comment below claiming this refusal before it existed.
  if (found.length > 1) {
    throw new Error(
      `${CONSENT_FILE}: found ${found.length} \`function ThirdPartyConsentProvider\` ` +
        `declarations. Re-point this locator at the one that renders the gate rather than ` +
        `letting it pick whichever comes first.`
    );
  }
  const decl = found[0] as ts.FunctionDeclaration | undefined;

  if (!decl) {
    throw new Error(
      `${CONSENT_FILE}: no \`function ThirdPartyConsentProvider\` declaration found. This ` +
        `guard's subject moved — if it became an arrow-function const, re-point this locator ` +
        `at the component that decides whether the consent gate mounts, rather than deleting it.`
    );
  }
  return decl;
}

/** Its body block. */
function consentComponentBody(sourceFile: ts.SourceFile): ts.Block {
  const decl = consentComponentDecl(sourceFile);
  if (!decl.body) {
    throw new Error(
      `${CONSENT_FILE}: \`function ThirdPartyConsentProvider\` has no body — an overload ` +
        `signature or an ambient declaration was picked. Re-point this locator at the ` +
        `implementation rather than deleting the guards that use it.`
    );
  }
  return decl.body;
}

type JsxOpener = ts.JsxSelfClosingElement | ts.JsxOpeningElement;

/** The opening elements of every `<Tag …>` in a subtree. */
function jsxOpeners(scope: ts.Node, tag: string): JsxOpener[] {
  return collect(
    scope,
    (n) =>
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === tag
  ) as JsxOpener[];
}

/** The single `<Tag …>` in a file, or a loud error naming what moved. */
function soleJsxOpener(sourceFile: ts.SourceFile, tag: string, file: string): JsxOpener {
  const found = jsxOpeners(sourceFile, tag);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one <${tag}> in ${file}, found ${found.length}. If it was renamed or ` +
        `aliased on import, re-point this guard; if it was removed, this guard's subject is ` +
        `gone and the removal needs a deliberate decision, not a silently-passing test.`
    );
  }
  return found[0];
}

/** A named attribute on a JSX opener, or `undefined`. */
function jsxAttr(el: JsxOpener, name: string): ts.JsxAttribute | undefined {
  return el.attributes.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === name
  );
}

describe('the consent gate reads `region` from context, never from an `_app` prop', () => {
  /**
   * 🔴 THE PRODUCER SIDE. Removing the `region` prop from the consent provider made
   * `<AppProvider region={region}>` the gate's ONLY remaining input, and nothing else guards it:
   * deleting that attribute compiles (`AppProviderProps.region` is optional), lints (`region` is
   * still read by `<FaroProvider region={region?.countryCode} />`), and leaves every other
   * assertion in this file AND both browser tests green — the browser tests build their own
   * `AppProvider` and feed it `region` directly, which is their stated limitation. The result
   * would be `useAppContext().region === undefined` for every visitor on every page, i.e. the
   * gate never mounting AT ALL — strictly worse than the bug this PR fixes, and with no compile
   * error, no failing test and no log line. Found by the `civitai-test-review` lane.
   */
  it("`_app` seeds AppProvider with `region` — the gate's only remaining input", () => {
    const appProvider = soleJsxOpener(parse(APP_FILE), 'AppProvider', APP_FILE);

    expect(
      jsxAttr(appProvider, 'region')?.initializer?.getText() ?? '(absent)',
      'AppProvider is the ONLY region source ThirdPartyConsentProvider has since the prop was ' +
        'removed. Dropping this attribute compiles, lints and leaves every consent test green ' +
        'while the gate silently never applies to anyone'
    ).toBe('{region}');
  });

  /**
   * 🔴 WHAT MAKES THE THROW UNREACHABLE. `useAppContext()` throws `missing AppProvider in tree`
   * without a provider, and the nearest `<ErrorBoundary>` in `_app` is a DESCENDANT of the
   * consent provider — React boundaries never catch a throw from an ancestor — so a misnesting
   * here is an SSR 500 and a client white-screen, with nothing to catch it. Every other
   * assertion in this file inspects props; a reorder of `_app`'s provider stack that lifted the
   * consent gate above `AppProvider` would pass all of them. Found by the
   * `civitai-correctness-review` lane.
   */
  it('`_app` nests the consent provider INSIDE AppProvider, or `useAppContext()` throws', () => {
    const app = parse(APP_FILE);
    const appProvider = soleJsxOpener(app, 'AppProvider', APP_FILE);
    const consentProvider = soleJsxOpener(app, 'ThirdPartyConsentProvider', APP_FILE);

    // 🔴 SPAN CONTAINMENT IS ONLY A SUBTREE TEST FOR A PAIRED OPENER. A `JsxSelfClosingElement`
    // has no children, so its `.parent` is the ENCLOSING element and the window below would
    // widen to cover that element's SIBLINGS — certifying a nesting that does not exist. The
    // same trap, measured, is documented on `isDescendant` in
    // `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts`. `soleJsxOpener` does
    // not catch it: a self-closing `<AppProvider … />` is still exactly one opener. Refuse it.
    if (!ts.isJsxOpeningElement(appProvider)) {
      throw new Error(
        `${APP_FILE}: <AppProvider> is self-closing, so it has no subtree and the containment ` +
          `test below would be meaningless — it would pass for a SIBLING. Re-point this guard.`
      );
    }
    // The opener is the child of the JsxElement whose span is everything it wraps, so
    // containment is a position test on that ELEMENT's span — not on the opener's.
    // Deliberately over-strict in the safe direction: extracting the inner tree into a `const`
    // above the `return` makes this go red on a nesting that is in fact correct. That is a
    // spelling rule, not a real misnesting — update the guard if you do it on purpose.
    const appProviderElement = appProvider.parent;
    const enclosed =
      appProviderElement.getStart() < consentProvider.getStart() &&
      consentProvider.getEnd() < appProviderElement.getEnd();

    expect(
      enclosed,
      '<ThirdPartyConsentProvider> must be a DESCENDANT of <AppProvider> in _app — it calls ' +
        'useAppContext(), which THROWS without one, above every ErrorBoundary in the tree'
    ).toBe(true);
  });

  it('`_app` passes no `region` — and no spread that could carry one — to the consent provider', () => {
    const props = soleJsxOpener(parse(APP_FILE), 'ThirdPartyConsentProvider', APP_FILE).attributes
      .properties;

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

    // Same subject discipline as `soleJsxOpener` / `consentComponentDecl`: refuse an absent OR a
    // non-unique subject rather than silently taking `[0]`. This one is the WEAKER of the pair —
    // two module-scope `type Props` is a TS duplicate-identifier error, so only a block-scoped
    // decoy is reachable — but the rest of this file refuses on principle, and an inconsistent
    // locator is the one nobody checks.
    const propsAliases = collect(
      consent,
      (n) => ts.isTypeAliasDeclaration(n) && n.name.text === 'Props'
    ) as ts.TypeAliasDeclaration[];
    if (propsAliases.length !== 1) {
      throw new Error(
        `${CONSENT_FILE}: expected exactly one \`type Props\`, found ${propsAliases.length}. ` +
          `If it became an interface or moved, re-point this ledger; if a second one appeared, ` +
          `point it at the one the component's parameter is annotated with. Do not delete it.`
      );
    }
    const propsAlias = propsAliases[0];

    // 🔴 THE LEDGER BELOW WALKS TYPE LITERALS, SO THE ALIAS'S OWN SHAPE IS PART OF THE CLAIM.
    // `type Props = { children; initialConsent; loggedIn } & RegionProps` contributes no member
    // here (the second operand is a type REFERENCE, so there is nothing to flatten), keeps the
    // parameter annotation at the bare `Props`, and re-opens
    // `<ThirdPartyConsentProvider region={…}>` — green on every other assertion in this file.
    // An index signature does the same by disabling JSX excess-property checking. Both spellings
    // found by the `civitai-test-review` lane; neither was caught before these two lines.
    expect(
      propsAlias.type !== undefined && ts.isTypeLiteralNode(propsAlias.type),
      '`Props` must be a bare object literal — an intersection or an alias to an imported type ' +
        'adds accepted props WITHOUT adding a member this ledger can see, which re-opens the ' +
        'call site while every assertion here stays green'
    ).toBe(true);
    expect(
      collect(propsAlias, ts.isIndexSignatureDeclaration).map((n) => n.getText()),
      'an index signature on `Props` disables JSX excess-property checking, so `region={…}` ' +
        'compiles again with no member for this ledger to find'
    ).toEqual([]);

    // 🔴 A MEMBER THE LEDGER CANNOT READ IS A MEMBER THE LEDGER DOES NOT HAVE — AND THERE ARE
    // TWO AXES TO THAT, NOT ONE.
    //
    // NAME: an earlier version mapped a non-`Identifier` name to `''`, so `'region'?: RegionInfo`
    // — a quoted key, one character — vanished from the ledger while TypeScript treated it as the
    // same property. Measured: that mutant left all seven of this file's tests green AND made
    // `<ThirdPartyConsentProvider region={region}>` compile clean under a real `ts.createProgram`.
    //
    // KIND: the fix for that started from `members.filter(isPropertySignature)`, which closed the
    // name axis and left the kind axis wide open. `get region(): RegionInfo | undefined;` is not a
    // PropertySignature, so it was invisible to the very refusal meant to catch this — and a
    // getter-only member is still satisfied by a JSX attribute, so it compiled clean too, with all
    // six assertions in THIS test green. Both axes found by the `civitai-test-review` lane, one
    // round apart, with the mutants and the `ts.createProgram` run each time.
    //
    // So START FROM EVERY MEMBER and refuse anything this ledger cannot read — accessors, methods,
    // call/construct signatures, computed and numeric keys alike. Refusing is deliberate: widening
    // the read would need a policy for each shape, and a shape nobody thought about is exactly how
    // both of these arrived.
    const allMembers = (collect(propsAlias, ts.isTypeLiteralNode) as ts.TypeLiteralNode[]).flatMap(
      (lit) => [...lit.members]
    );
    // The narrowing carries the NAME too, so `m.name.text` below is safe without a cast —
    // `ts.PropertySignature` alone still types `name` as `PropertyName`, which includes
    // `ComputedPropertyName` and has no `.text`. (`pnpm typecheck` covers this file: it lives in
    // `src/tests/pages/`, not a `__tests__/` dir, so the root tsconfig does not exclude it.)
    type ReadableProp = ts.PropertySignature & { name: ts.Identifier | ts.StringLiteral };
    const readable = (m: ts.TypeElement): m is ReadableProp =>
      ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name));

    expect(
      allMembers.filter((m) => !readable(m)).map((m) => m.getText()),
      '`Props` must be plain property signatures named by an identifier or a string literal — an ' +
        'accessor, a method, a call or construct signature, or a computed or numeric key is a ' +
        'prop this ledger cannot see, which is the same thing as not guarding it. Rewrite it as ' +
        'a plain property signature, or re-point this ledger — do not delete it'
    ).toEqual([]);

    // Every survivor is `readable`, so the name read below cannot silently produce `''`.
    //
    // ⚠️ THE REFUSE-TO-GUESS PRINCIPLE IS NOT NEW HERE — `clampStateOf` in
    // `src/server/services/__tests__/collection-item-count-clamp-wiring.test.ts` reached the same
    // conclusion first, for the same reason, and refuses a spread as well as a computed key. Same
    // conclusion, DIFFERENT MECHANISM: it returns an `'unreadable'` sentinel because its caller
    // can act on one, where this ledger has to fail on the spot. Read it before revisiting.
    //
    // It is one of at least FIVE member-name readers under
    // `src/` with five different unreadable-name policies (refuse / `'unreadable'` sentinel /
    // `null` / implicit skip / `''`), plus one that reads `isStringLiteralLike` and is therefore
    // strictly wider than the rest. They do not have to agree, and deliberately are not
    // consolidated: each is safe only under its OWN assertion's polarity — a `''` or a `null` is
    // loud under `.toContain(…)`/`.toBe(1)` and silent under the `.not.toContain(…)` this file
    // uses, which is exactly why this one has to refuse. See this file's header.
    const members = allMembers.filter(readable).map((m) => m.name.text);

    expect(
      members,
      'Props must NOT declare `region` — its absence is what turns a re-added ' +
        '`<ThirdPartyConsentProvider region={region}>` in _app into a compile error instead of ' +
        'a silently-ignored prop'
    ).not.toContain('region');
    // A floor on the ledger: without this, deleting every member would pass.
    expect(members).toEqual(expect.arrayContaining(['children', 'initialConsent', 'loggedIn']));

    // 🔴 The title above claims the compile error; `Props` alone does not deliver it. A
    // signature of `(props: Props & { region?: RegionInfo })` leaves `Props` untouched, passes
    // every other assertion in this file, and makes `<ThirdPartyConsentProvider region={…}>`
    // compile again. Assert the parameter is annotated with the bare `Props` identifier, so the
    // body is as wide as the sentence. Found by the `civitai-test-review` lane.
    expect(
      consentComponentDecl(consent).parameters.map((p) => p.type?.getText() ?? '(untyped)'),
      "the component's parameter must be annotated with the bare `Props` identifier — widening " +
        'it in place (`Props & { region?: RegionInfo }`) re-opens the call site without touching ' +
        'the `Props` alias this test just checked'
    ).toEqual(['Props']);
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
