import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-hand-enumerated-trpc-mock'];

// Same harness shape as no-wholesale-module-mock.test.ts: RuleTester drives the
// test framework's globals, so `ruleTester.run(...)` must be called at the top
// level of the module (NOT nested inside a vitest `it()`). `parser` is a valid
// top-level RuleTester option in ESLint 8 (eslintrc mode) but @types/eslint's
// config type omits it — build untyped and cast so `tsc --noEmit` stays green.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};
const ruleTester = new RuleTester(ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]);

// A realistic `src/`-relative filename, needed by the cases that use a RELATIVE
// module specifier: the rule resolves those against the linted file before
// comparing them with the `~/utils/trpc` target.
const TEST_FILE = 'src/components/Foo/__tests__/foo.browser.test.tsx';

ruleTester.run('no-hand-enumerated-trpc-mock', rule, {
  valid: [
    // ================================================================
    // The house pattern — `makeTrpcProxy`, in each spelling in the repo
    // ================================================================
    // Concise body (AppBlockChromePlatformNav.browser.test.tsx: no overrides).
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: makeTrpcProxy(),
     }));`,
    // With procedure overrides (AuthorViaGit.browser.test.tsx).
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: makeTrpcProxy({ 'blocks.listMyScopeGrants': { useQuery: mySpy } }),
     }));`,
    // Both argument positions used (ScopeRevoke.browser.test.tsx).
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return { ...actual, trpc: makeTrpcProxy({ 'a.b': { useQuery: q } }, { useUtils: u }) };
     });`,

    // ================================================================
    // A local `new Proxy` is equally acceptable — 8 files use it
    // ================================================================
    // Inline (AnnouncementsPanel.browser.test.tsx: `trpc: new Proxy(stubbed, …)`).
    // 🔴 Note the Proxy's TARGET is a hand-written literal here, and that must
    // NOT be reported: the literal is the seed of a total surface, not the
    // surface itself — the trap answers for every key the seed omits.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const stubbed = { user: { getById: { useQuery: () => ({ data: undefined }) } } };
       return {
         ...(await importOriginal()),
         trpc: new Proxy(stubbed, { get: (t, p) => (p in t ? t[p] : inert()) }),
       };
     });`,
    // Reached through a factory-local `const` (AppsWideLayout.geometry.test.tsx
    // and AppActivityPage.browser.test.tsx both spell it `const root: unknown =
    // new Proxy(…); return { …, trpc: root }`).
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const root: unknown = new Proxy({}, { get: () => node() });
       return { ...(await importOriginal()), trpc: root };
     });`,
    // Shorthand property off a local const
    // (collection-review-decrement.browser.test.tsx: `return { ...actual, trpc }`).
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const trpc = new Proxy({ useUtils }, { get: (t, k) => (k in t ? t[k] : inertProc()) });
       return { ...(await importOriginal()), trpc };
     });`,

    // ================================================================
    // Nothing to say about a factory that does not override `trpc`
    // ================================================================
    // 4 files in the tree mock other exports of the module and leave `trpc`
    // real. The sibling rule owns the export surface; this one has no opinion.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpcVanilla: { user: { getById: { query: vi.fn() } } },
     }));`,
    // Automock keeps the real client by construction. 🔴 This one is a REAL
    // guard: deleting `if (!factory) return;` makes the rule crash here with
    // `Cannot read properties of undefined (reading 'type')`.
    `vi.mock('~/utils/trpc');`,
    // ⚠️ The next two are DOCUMENTED-GAP PINS, not coverage — said plainly so the
    // factory-type guard above them does not read as tested. Deleting that guard
    // leaves both green, because `collectFactoryReturns` on a non-function hits
    // `if (!factory.body) return [null]`, the shape is null, and the loop skips.
    // The guard is defence-in-depth against that helper changing, and these cases
    // pin the BEHAVIOUR (no report) rather than the guard.
    `vi.mock('~/utils/trpc', { spy: true });`,
    `vi.mock('~/utils/trpc', makeFactory);`,
    // A factory that returns the original outright has no object to inspect.
    `vi.mock('~/utils/trpc', async (importOriginal) => importOriginal());`,
    // `Object.assign` with NO literal argument carries no enumeration — the
    // mirror of the invalid cases below, and what stops that arm from being a
    // blanket report on the construct.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: Object.assign(makeTrpcProxy(), somethingElse),
     }));`,
    // A call that is NOT `Object.assign` keeps falling through, even with a
    // literal argument — the arm is keyed on the callee, not on "a call with an
    // object in it".
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: buildTrpcStub({ user: { getById: { useQuery: q } } }),
     }));`,
    // A factory whose return this rule cannot resolve to a literal is NOT
    // reported — the documented bypass. Pinned so removing the measurement that
    // justifies it is a deliberate act and not a silent tightening.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: buildTrpcStub(),
     }));`,
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: importedStubFromAnotherFile,
     }));`,

    // ================================================================
    // Scope — this is what keeps the rule quiet enough to stay enabled
    // ================================================================
    // A hand-written literal mocking ANY OTHER module is none of this rule's
    // business, however wholesale it looks.
    `vi.mock('~/utils/other', () => ({ trpc: { user: { getById: { useQuery: q } } } }));`,
    `vi.mock('@mantine/hooks', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
    // A relative specifier resolving to a DIFFERENT module must not fire.
    {
      code: `vi.mock('../../../utils/other', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      filename: TEST_FILE,
    },
    // 🔴 A `src/` under a workspace PACKAGE is a different module tree: from
    // packages/, `../utils/trpc` is that package's own module, not `~/utils/trpc`.
    {
      code: `vi.mock('../utils/trpc', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      filename: 'packages/blocks-react/src/__tests__/foo.test.tsx',
    },
    // Not a `vi.mock` call at all — the callee is checked, not the argument.
    `notVi.mock('~/utils/trpc', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
    // A computed key whose value is a VARIABLE cannot be named statically, so it
    // is not treated as the `trpc` key.
    //
    // 🔴 `[trpc]` specifically, not just `[someKey]`: `{ [someKey]: … }` cannot
    // discriminate, because `readStaticPropertyKey` returns `'someKey'` whether or
    // not the computed check is there and the `trpc`-key filter rejects it either
    // way. `[trpc]` reads the VARIABLE `trpc`, which is not the property name, and
    // is the only spelling that pins `!property.computed` — drop that clause and
    // this case becomes a false positive.
    `vi.mock('~/utils/trpc', () => ({ [trpc]: { a: { b: { useQuery: q } } } }));`,
    `vi.mock('~/utils/trpc', () => ({ [someKey]: { a: { b: { useQuery: q } } } }));`,
    // A `trpc` literal nested one level deeper is not the client itself.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       somethingElse: { trpc: { a: { b: { useQuery: q } } } },
     }));`,

    // ================================================================
    // 🔴 The CYCLE GUARD — the failure signal here is a CRASH, not a report
    // ================================================================
    // `trpc: a` where `const a = a`. The value must be the bare identifier: an
    // earlier version of this case used `trpc: { self: a }`, which is an
    // ObjectExpression and so returns `true` on the FIRST switch arm without ever
    // visiting `a` — the cycle was never entered, and deleting the guard left the
    // whole suite green while the comment claimed otherwise.
    //
    // These belong in `valid` because nothing here resolves to a literal, so 0
    // reports is correct. What they pin is termination: RuleTester surfaces a
    // thrown rule as a failure, and without the guard each one dies with
    // `RangeError: Maximum call stack size exceeded`, which in production is
    // ESLint crashing on the file instead of linting it.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const a = a;
       return { ...(await importOriginal()), trpc: a };
     });`,
    // Mutual recursion, two hops.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const a = b;
       const b = a;
       return { ...(await importOriginal()), trpc: a };
     });`,
    // Through an assignment rather than a declarator, since those are tracked too.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       let a;
       a = a;
       return { ...(await importOriginal()), trpc: a };
     });`,

    // ================================================================
    // Documented-gap pins — 0 reports is the CURRENT behaviour, not a goal
    // ================================================================
    // Each is named in the rule's "Known gaps" list and has 0 instances in the
    // tree. They are pinned so the bypass set is greppable, and so closing one
    // later is a deliberate edit to a red test rather than a silent change.
    // `vi.hoisted` — the idiomatic vitest shape, and a gap the sibling names too.
    `const { trpc: hoisted } = vi.hoisted(() => ({ trpc: { user: { getById: { useQuery: q } } } }));
     vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       trpc: hoisted,
     }));`,
    // A member expression off a local.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const stubs = { trpc: { user: { getById: { useQuery: q } } } };
       return { ...(await importOriginal()), trpc: stubs.trpc };
     });`,
    // Array destructuring — the binding comes from a pattern, not an initialiser.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const [stub] = [{ user: { getById: { useQuery: q } } }];
       return { ...(await importOriginal()), trpc: stub };
     });`,
    // A getter: the KEY is read as `trpc`, but the property value is a
    // FunctionExpression, so nothing resolves to a literal.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal()),
       get trpc() { return { user: { getById: { useQuery: q } } }; },
     }));`,
  ],

  invalid: [
    // ================================================================
    // The reported shape — a hand-written object literal
    // ================================================================
    // The canonical defect, and the one #4147 shipped: a factory that spreads
    // the original correctly (so the sibling rule is satisfied) and still pins
    // `trpc` to the three procedures the author needed.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: {
           blocks: {
             getPlacementSpaces: { useQuery: () => ({ data: SPACES }) },
             listInstalled: { useQuery: () => ({ data: [] }) },
           },
           useUtils: () => ({ blocks: { invalidate: vi.fn() } }),
         },
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // An empty literal is the same hazard at its most extreme: EVERY procedure
    // is undefined.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({ ...(await importOriginal()), trpc: {} }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A wholesale factory (no spread at all) is reported by BOTH rules — they
    // are independent, and this one still has its own thing to say.
    {
      code: `vi.mock('~/utils/trpc', () => ({ trpc: { user: { getById: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A quoted key is the same property.
    {
      code: `vi.mock('~/utils/trpc', () => ({ 'trpc': { a: { b: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // 🔴 So is a COMPUTED key with a string literal — otherwise `['trpc']` is a
    // one-character bypass of the whole rule.
    {
      code: `vi.mock('~/utils/trpc', () => ({ ['trpc']: { a: { b: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // ...and an expressionless TEMPLATE literal key, for the same reason. The
    // module-specifier reader already accepts that form, so a key reader that did
    // not was the next one-character bypass along.
    {
      code: 'vi.mock(`~/utils/trpc`, () => ({ [`trpc`]: { a: { b: { useQuery: q } } } }));',
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },

    // ================================================================
    // 🔴 A literal whose VALUES are proxies is still an enumeration
    // ================================================================
    // Two files in the tree have this shape. The procedures under `cosmetic` are
    // total; the ROUTER level is not, so `trpc.user.getById` still crashes.
    // sticker-tray-search-sort.test.ts documents exactly this residual hazard in
    // its own docblock, which is why reporting it is correct rather than noisy.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: { cosmetic: new Proxy({ getStickerBalances: { useQuery: q } }, handler) },
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Spreading a Proxy into a literal does NOT rescue it: a spread copies own
    // enumerable keys and `new Proxy({}, …)` has none, so the trap is lost and
    // the result is an enumeration of whatever else is written there.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const proxied = new Proxy({}, handler);
         return { ...(await importOriginal()), trpc: { ...proxied, user: { getById: { useQuery: q } } } };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },

    // ================================================================
    // 🔴 `Object.assign` is not an escape hatch
    // ================================================================
    // Every source's own enumerable keys land on the result, so one literal
    // argument makes the result an enumeration. `Object.assign` is the first
    // thing an author reaches for when avoiding a spread, and the sibling
    // analyzer already walks it — without this arm it was a one-word bypass
    // (measured: 0 reports against a positive control of 1).
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: Object.assign({}, { user: { getById: { useQuery: q } } }),
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // The TARGET counts too, not just the sources: copying a Proxy's own keys
    // onto a plain `{}` loses the trap entirely, because a Proxy over `{}` has
    // no own keys to copy.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: Object.assign({}, makeTrpcProxy()),
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },

    // ================================================================
    // Resolution — the hops that find the literal
    // ================================================================
    // Through a factory-local `const`. Without this the mirror-image of the
    // `const root = new Proxy(…)` valid case above is a silent pass.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const stub = { user: { getById: { useQuery: q } } };
         return { ...(await importOriginal()), trpc: stub };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Shorthand property off that same binding.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const trpc = { user: { getById: { useQuery: q } } };
         return { ...(await importOriginal()), trpc };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Two hops.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const inner = { user: { getById: { useQuery: q } } };
         const stub = inner;
         return { ...(await importOriginal()), trpc: stub };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // 🔴 A name REASSIGNED to a literal after being bound to a proxy. Keeping
    // every initialiser rather than poisoning the name is what catches this —
    // poisoning would make it a silent pass.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         let stub = makeTrpcProxy();
         stub = { user: { getById: { useQuery: q } } };
         return { ...(await importOriginal()), trpc: stub };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Declared twice, proxy LAST — so a rule that reads only the final
    // initialiser passes it. The literal can still reach the return.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         var stub = { user: { getById: { useQuery: q } } };
         if (flag) { var stub = makeTrpcProxy(); }
         return { ...(await importOriginal()), trpc: stub };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // EITHER branch of a ternary being a literal is enough — the proxy branch
    // does not excuse the other one. (`&&` instead of `||` here is a mutant this
    // case is the only one to kill.)
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: flag ? makeTrpcProxy() : { user: { getById: { useQuery: q } } },
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // ...and in the other order, so a rule that checks only one side is caught
    // whichever side it checks.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: flag ? { user: { getById: { useQuery: q } } } : makeTrpcProxy(),
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A logical fallback to a literal — the literal on the RIGHT.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: cached || { user: { getById: { useQuery: q } } },
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // ...and on the LEFT. Both orders are pinned for the same reason the ternary's
    // are: with only the right-hand case, a mutant that checks `.right` alone
    // survives the whole suite.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: { user: { getById: { useQuery: q } } } || cached,
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A SequenceExpression's value is its LAST element.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: (setup(), { user: { getById: { useQuery: q } } }),
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // `await` of a literal binding. Contrived, but it is one character of
    // bypass, and the branch that handles it has to be reachable to be tested.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const stub = { user: { getById: { useQuery: q } } };
         return { ...(await importOriginal()), trpc: await stub };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Type wrappers change the TYPE, not the value — `as any` is the first thing
    // an author reaches for when fighting a squiggle, so it must not work.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: { user: { getById: { useQuery: q } } } as any,
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({
         ...(await importOriginal()),
         trpc: { user: { getById: { useQuery: q } } } satisfies Record<string, unknown>,
       }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // ================================================================
    // 🔴 The RETURN is resolved too, not just the `trpc` value
    // ================================================================
    // These three escaped BOTH rules before the return was walked: the sibling
    // accepts each as original-preserving (correctly — the export surface IS
    // preserved), so the `trpc` literal inside was unguarded and failed silently.
    //
    // Returning a local that holds the object. 🔴 This is the one that matters:
    // the sibling's own fixture table blesses `const out = { ...actual, trpc: {} };
    // return out;` as VALID, so it is a documented-good authoring shape and an
    // author lands here innocently.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const mod = { ...(await importOriginal()), trpc: { user: { getById: { useQuery: q } } } };
         return mod;
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // `Object.assign` at the RETURN level, with the original as a source.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) =>
         Object.assign({}, await importOriginal(), { trpc: { user: { getById: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A ternary at the RETURN level where one branch carries the literal. The
    // sibling passes this because BOTH branches spread the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return flag
           ? { ...actual, trpc: { user: { getById: { useQuery: q } } } }
           : { ...actual, trpc: makeTrpcProxy() };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // 🔴 One property reachable from TWO returns is reported ONCE. Two annotations
    // on one line reads as a rule bug, and the author has one edit to make.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const mod = { ...(await importOriginal()), trpc: { user: { getById: { useQuery: q } } } };
         if (flag) return mod;
         return mod;
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },

    // ================================================================
    // 🔴 EVERY return is inspected, not just the first
    // ================================================================
    // The SAFE return comes first, so this is the only case that fails if the
    // analysis stops after one return.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         if (flag) return { ...actual, trpc: makeTrpcProxy() };
         return { ...actual, trpc: { user: { getById: { useQuery: q } } } };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // Both returns bad -> two reports, so the count is pinned too and a rule that
    // collapses to one report per call is visible. The `line`s make "the second
    // report lands on the second return" a claim rather than an accident — a count
    // alone cannot tell two reports on one line from one on each, and the dedupe
    // added for the shared-property case is exactly the code that could collapse
    // them wrongly.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         if (flag) return { ...actual, trpc: { a: { b: { useQuery: q } } } };
         return { ...actual, trpc: { c: { d: { useQuery: q } } } };
       });`,
      errors: [
        { messageId: 'handEnumeratedTrpcMock', line: 3 },
        { messageId: 'handEnumeratedTrpcMock', line: 4 },
      ],
    },

    // ================================================================
    // Specifier forms that are the same module
    // ================================================================
    {
      code: 'vi.mock(`~/utils/trpc`, () => ({ trpc: { a: { b: { useQuery: q } } } }));',
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    {
      code: `vi.mock('~/utils/trpc/index', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A relative specifier resolving to the SAME module.
    {
      code: `vi.mock('../../../utils/trpc', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      filename: TEST_FILE,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // `vi.doMock` and the `vitest` alias are the same call.
    {
      code: `vi.doMock('~/utils/trpc', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    {
      code: `vitest.mock('~/utils/trpc', () => ({ trpc: { a: { b: { useQuery: q } } } }));`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },
    // A `function` expression factory, not just an arrow.
    {
      code: `vi.mock('~/utils/trpc', async function (importOriginal) {
         return { ...(await importOriginal()), trpc: { a: { b: { useQuery: q } } } };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock' }],
    },

    // ================================================================
    // 🔴 WHERE the report lands is user-facing, so it is pinned
    // ================================================================
    // The report goes on the `trpc` PROPERTY, not on the `vi.mock` call. On a
    // 200-line factory — and several in this repo are — the call site's line is
    // nowhere near the literal an author has to change, and an annotation on the
    // wrong line is how a finding gets ignored. `line: 4` is the `trpc:` line;
    // the `vi.mock` call is line 1.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return {
           trpc: { user: { getById: { useQuery: q } } },
           ...actual,
         };
       });`,
      errors: [{ messageId: 'handEnumeratedTrpcMock', line: 4 }],
    },
  ],
});
