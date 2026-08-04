import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-wholesale-module-mock'];

// Same harness shape as no-io-in-transaction.test.ts: RuleTester drives the test
// framework's globals, so `ruleTester.run(...)` must be called at the top level
// of the module (NOT nested inside a vitest `it()`). `parser` is a valid
// top-level RuleTester option in ESLint 8 (eslintrc mode) but @types/eslint's
// config type omits it — build untyped and cast so `tsc --noEmit` stays green.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};
const ruleTester = new RuleTester(ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]);

// A realistic `src/`-relative filename, needed by the cases that use a RELATIVE
// module specifier: the rule resolves those against the linted file before
// comparing them with the configured `~/utils/trpc` target.
const TEST_FILE = 'src/components/Foo/__tests__/foo.browser.test.tsx';

// ESLint invokes rules with ABSOLUTE filenames, and that is the branch where a
// relative specifier is resolved against the repo's own `src/`. The cases that
// pin the package boundary have to use real absolute paths under this repo, or
// they exercise the repo-relative branch instead and prove nothing.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC_FILE_ABS = path.join(REPO_ROOT, TEST_FILE);
const PKG_FILE_ABS = path.join(REPO_ROOT, 'packages/blocks-react/src/__tests__/foo.test.tsx');

ruleTester.run('no-wholesale-module-mock', rule, {
  valid: [
    // ================================================================
    // The canonical pattern, in each spelling that appears in the repo
    // ================================================================
    // Block body: await importOriginal() into a local, spread it in the return.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal<typeof import('~/utils/trpc')>();
       return { ...actual, trpc: { useUtils: () => ({}) } };
     });`,
    // Concise body variant (AnnouncementEditModal.browser.test.tsx).
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal<Record<string, unknown>>()),
       trpc: { useUtils: () => ({}) },
     }));`,
    // The form the rule's message actually recommends: a type-only namespace
    // import instead of `typeof import('...')`, which @typescript-eslint's
    // consistent-type-imports rejects ("`import()` type annotations are
    // forbidden"). Both must stay valid here.
    `import type * as TrpcModule from '~/utils/trpc';
     vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal<typeof TrpcModule>()),
       trpc: {},
     }));`,
    // vi.importActual is equally acceptable as the source of the spread.
    `vi.mock('~/utils/trpc', async () => {
       const actual = await vi.importActual<typeof import('~/utils/trpc')>('~/utils/trpc');
       return { ...actual, trpc: {} };
     });`,
    // A `function` expression factory, not just an arrow.
    `vi.mock('~/utils/trpc', async function (importOriginal) {
       const actual = await importOriginal();
       return { ...actual, trpc: {} };
     });`,
    // Straight passthrough — returns the original, no object literal to inspect.
    `vi.mock('~/utils/trpc', async (importOriginal) => importOriginal());`,
    // Automock (no factory) preserves the real export shape by construction.
    `vi.mock('~/utils/trpc');`,
    // Vitest's options form (`{ spy: true }`) also keeps the real module.
    `vi.mock('~/utils/trpc', { spy: true });`,

    // ================================================================
    // 🔴 The `importOriginal` BINDING is what matters, not the token
    // ================================================================
    // Regression guard, and the reason the textual check had to go: the factory
    // parameter IS importOriginal whatever it is named. A rule that greps the
    // factory source for /\bimportOriginal\b/ REJECTS this correct code — the
    // textual check was wrong in both directions, not merely permissive.
    `vi.mock('~/utils/trpc', async (orig) => ({ ...(await orig()), trpc: {} }));`,

    // ================================================================
    // Return shapes that are unusual but still provably safe
    // ================================================================
    // `as any` / `satisfies` over a return that DOES spread the original: the
    // type wrapper is unwrapped, and the spread underneath is found.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return { ...actual, trpc: {} } as any;
     });`,
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return { ...actual, trpc: {} } satisfies Record<string, unknown>;
     });`,
    // Object.assign with the original as a source: every source's keys land on
    // the result, so the export surface is preserved.
    `vi.mock('~/utils/trpc', async (importOriginal) =>
       Object.assign({}, await importOriginal(), { trpc: {} }));`,
    // Returning a local whose initialiser spreads the original.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       const out = { ...actual, trpc: {} };
       return out;
     });`,
    // Spread of a local that itself spreads the original (one hop further).
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       const base = { ...actual };
       return { ...base, trpc: {} };
     });`,
    // Both branches of a ternary spread the original.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return flag ? { ...actual, trpc: {} } : { ...actual, trpc: {} };
     });`,
    // Every return path spreads the original.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       if (flag) return { ...actual, trpc: { a: 1 } };
       return { ...actual, trpc: { b: 2 } };
     });`,

    // ================================================================
    // Specifier forms
    // ================================================================
    // Template literal with no expressions is the same specifier.
    {
      code: 'vi.mock(`~/utils/trpc`, async (importOriginal) => ({ ...(await importOriginal()), trpc: {} }));',
      filename: TEST_FILE,
    },
    // A relative specifier that resolves to the SAME module, done correctly.
    {
      code: `vi.mock('../../../utils/trpc', async (importOriginal) => ({ ...(await importOriginal()), trpc: {} }));`,
      filename: TEST_FILE,
    },
    // A relative specifier that resolves to a DIFFERENT module must not fire,
    // even though it is wholesale — the rule is scoped, and over-reach is what
    // gets a rule switched off.
    {
      code: `vi.mock('../../../utils/other', () => ({ trpc: {} }));`,
      filename: TEST_FILE,
    },

    // ================================================================
    // Out of scope
    // ================================================================
    // The rule is scoped to its `modules` option (default just ~/utils/trpc);
    // a wholesale mock of any other module must NOT fire. This is what keeps
    // the rule quiet enough to stay enabled.
    `vi.mock('~/hooks/useCFImageUpload', () => ({ useCFImageUpload: () => ({}) }));`,
    `vi.mock('@mantine/hooks', () => ({ useMediaQuery: () => false }));`,
    // Non-literal specifier (computed) — nothing to match against.
    `vi.mock(SOME_MODULE, () => ({ trpc: {} }));`,
    // Template literal WITH an expression is not statically readable.
    'vi.mock(`~/utils/${name}`, () => ({ trpc: {} }));',
    // Not a vi.mock call at all.
    `foo.mock('~/utils/trpc', () => ({ trpc: {} }));`,
    // Documented gap: a factory passed by reference is not analysed.
    `vi.mock('~/utils/trpc', makeTrpcFactory);`,

    // ================================================================
    // 🔴 A plain unary READS the local, it cannot mutate it
    // ================================================================
    // These four were all reported before: the poisoning clause matched every
    // `UnaryExpression` with an Identifier argument, so `!actual`, `typeof
    // actual`, `void actual` and `-actual` each marked `actual` unknowable and
    // turned correct code into an `error`. None of them can change a binding.
    // Defensive null-check — the shape most likely to be written by an author
    // who has actually been bitten by a bad importOriginal.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       if (!actual) throw new Error('trpc module missing');
       return { ...actual, trpc: {} };
     });`,
    // An assertion about the module, ditto.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       expect(typeof actual).toBe('object');
       return { ...actual, trpc: {} };
     });`,
    // `void` as a deliberate "yes, I know this is unused".
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       void actual;
       return { ...actual, trpc: {} };
     });`,
    // Arithmetic negation is still only a read.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       const n = -actual;
       return { ...actual, trpc: {} };
     });`,

    // ================================================================
    // Guards that had no discriminating case before
    // ================================================================
    // SequenceExpression: the LAST element is the value, and it is safe here.
    // Without the last-element rule this would be read as unprovable.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return (0, { ...actual, trpc: {} });
     });`,
    // LogicalExpression where BOTH sides are provably original-bearing. The
    // invalid cases below only pin the failing side.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       const other = await importOriginal();
       return actual || other;
     });`,
    // TSNonNullExpression must be unwrapped before the spread is inspected.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal())!,
       trpc: {},
     }));`,
    // ChainExpression: `importOriginal?.()` parses as a ChainExpression wrapping
    // the call, so without unwrapping it the original is not recognised.
    `vi.mock('~/utils/trpc', async (importOriginal) => ({
       ...(await importOriginal?.()),
       trpc: {},
     }));`,
    // The old-style TS cast `<any>expr` is a TSTypeAssertion, a different node
    // from `expr as any`. It must be unwrapped too, or a SAFE factory wearing
    // one is reported. (Only parses with JSX off, i.e. a `.ts` file — which is
    // why RuleTester's default filename is left in place for this case.)
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal();
       return <any>{ ...actual, trpc: {} };
     });`,
    // A template literal WITH an expression is not a statically-readable
    // specifier, even when its literal prefix happens to equal the target.
    // Reading just the first quasi here would flag a mock of some OTHER module.
    'vi.mock(`~/utils/trpc${suffix}`, () => ({ trpc: {} }));',
    // A first parameter with a DEFAULT is still the importOriginal binding —
    // it parses as an AssignmentPattern wrapping the identifier.
    `vi.mock('~/utils/trpc', async (importOriginal = fallback) => ({
       ...(await importOriginal()),
       trpc: {},
     }));`,

    // ================================================================
    // 🔴 The `~` alias stops at the package boundary
    // ================================================================
    // `~/utils/trpc` is the alias for the REPO-ROOT src/utils/trpc. A workspace
    // package has its own src/, so from packages/blocks-react the specifier
    // `../utils/trpc` names a DIFFERENT module and must not be flagged.
    // Resolving on "the last /src/ in the path" matched it; over-reach at
    // 'error' is exactly what gets a rule switched off.
    {
      code: `vi.mock('../utils/trpc', () => ({ trpc: {} }));`,
      filename: 'packages/blocks-react/src/__tests__/foo.test.tsx',
    },
    // The same, with the ABSOLUTE filename ESLint really passes — this is the
    // branch the fix changed, so it is the case that actually pins it.
    {
      code: `vi.mock('../utils/trpc', () => ({ trpc: {} }));`,
      filename: PKG_FILE_ABS,
    },

    // ================================================================
    // Nested-function isolation
    // ================================================================
    // A `return` inside an inner callback must not be mistaken for the
    // factory's own return value; the factory's real return spreads correctly.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal<Record<string, unknown>>();
       const useQuery = () => { return { data: undefined, isLoading: false }; };
       return { ...actual, trpc: { model: { getAll: { useQuery } } } };
     });`,

    // ================================================================
    // `completeFactories` — the designated-helper escape
    // ================================================================
    // For `~/server/db/pgDb`, `importOriginal()` would construct REAL pg pools in
    // a unit test, so the remedy is a shared helper whose completeness the TYPE
    // system enforces. The helper call is accepted only when this factory got it
    // from the configured module (the invalid[] cases below pin that).
    {
      code: `vi.mock('~/server/db/pgDb', async () => {
               const { createPgDbMock } = await import('~/test-utils/pgDbMock');
               return createPgDbMock();
             });`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
    },
    // Same, with overrides passed through.
    {
      code: `vi.mock('~/server/db/pgDb', async () => {
               const { createPgDbMock } = await import('~/test-utils/pgDbMock');
               return createPgDbMock({ pgDbWrite: { query: mockQuery } });
             });`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
    },
    // An `importOriginal` spread must STILL be accepted for a module that also
    // nominates a helper — the option adds a path, it does not replace one.
    {
      code: `vi.mock('~/server/db/pgDb', async (importOriginal) => ({
               ...(await importOriginal<Record<string, unknown>>()),
             }));`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
    },
  ],

  invalid: [
    // ================================================================
    // The exact shape that broke five suites / ~36 tests
    // ================================================================
    // Concise arrow returning a hand-written object (AppEditPage.browser.test.tsx).
    {
      code: `vi.mock('~/utils/trpc', () => ({ trpc: { blocks: { getMyAppManifest: { useQuery: () => ({}) } }, useUtils: () => ({}) } }));`,
      errors: [{ messageId: 'wholesaleMock', data: { module: '~/utils/trpc' } }],
    },
    // Block body with a local helper then a hand-written return
    // (ExternalSubmitForm.browser.test.tsx).
    {
      code: `vi.mock('~/utils/trpc', () => {
         const mutation = () => ({ mutate: vi.fn(), isPending: false });
         return { trpc: { appListings: { persistAssetImage: { useMutation: mutation } } } };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Minimal wholesale factory (WorkflowInput.browser.test.tsx) — a neighbouring
    // mock's importActual must not launder this one.
    {
      code: `vi.mock('~/utils/trpc', () => ({ trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Double-quoted specifier.
    {
      code: `vi.mock("~/utils/trpc", () => ({ trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // vi.doMock is the same hazard.
    {
      code: `vi.doMock('~/utils/trpc', () => ({ trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // `vitest.mock` alias.
    {
      code: `vitest.mock('~/utils/trpc', () => ({ trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },

    // ================================================================
    // 🔴 Laundering the TEXTUAL check — the token is present, the
    //    original module is not. Every one of these PASSED the first
    //    cut of this rule, which grepped the factory source.
    // ================================================================
    // An unused parameter named `importOriginal` satisfied the regex. This is
    // the sharpest one: it is the rule's own minimal invalid case plus a single
    // word, and it is one keystroke away from any of the backlog factories.
    {
      code: `vi.mock('~/utils/trpc', (importOriginal) => ({ ...localStub, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A COMMENT mentioning importOriginal satisfied it too — and a large share
    // of the existing backlog factories already carry an explanatory comment.
    {
      code: `vi.mock('~/utils/trpc', () => ({ /* TODO: switch to importOriginal */ ...localStub, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // ...as did the bare string, anywhere in the factory.
    {
      code: `vi.mock('~/utils/trpc', () => ({ note: 'importOriginal', ...localStub, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Spreading a dynamic import of some OTHER module is not the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({ ...(await import('./elsewhere')), trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // `vi.importActual` of a DIFFERENT module leaves every trpc export missing.
    {
      code: `vi.mock('~/utils/trpc', async () => ({ ...(await vi.importActual('~/utils/other')), trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A dynamic import of the module being mocked is a SELF-reference: Vitest
    // serves the mock, not the original. Only importOriginal/importActual work.
    {
      code: `vi.mock('~/utils/trpc', async () => ({ ...(await import('~/utils/trpc')), trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },

    // ================================================================
    // 🔴 Return shapes that bypassed "no object literal ⇒ assume safe"
    // ================================================================
    // `as any` is the idiomatic first reach when fighting a type squiggle in
    // this repo, which makes it the likeliest accidental bypass.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return { trpc: {} } as any;
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return { trpc: {} } satisfies Record<string, unknown>;
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Returning a local built without the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         const out = { trpc: {} };
         return out;
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Object.assign with no original-bearing source.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => Object.assign({}, { trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A logical expression where one side is a bare hand-written object.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => cached || { trpc: {} });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // ...and the memoised variant where the SAFE side is the fallback: `cached`
    // is an unknown value that can be the result, so a correct-looking
    // right-hand side does not redeem it. Both sides have to be provable.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return cached || { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A ternary where only ONE branch spreads the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return flag ? { ...actual } : { trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // No return statement at all — the factory hands Vitest `undefined`.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => { await importOriginal(); });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A bare `return;` is the same thing, written out.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => { await importOriginal(); return; });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // The local is reassigned after being loaded, so the value reaching the
    // spread is no longer knowable — "unsure" must mean "report".
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         let actual = await importOriginal();
         actual = {};
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Spreading a PROPERTY of the original is not spreading the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const mod = await importOriginal();
         return { ...mod.default, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },

    // ================================================================
    // Spread present, but not of the original
    // ================================================================
    // A spread of a LOCAL stub is not a fix — the real module is still gone.
    {
      code: `vi.mock('~/utils/trpc', () => ({ ...baseStub, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // importOriginal is awaited but the result is never spread — the omitted
    // exports are still missing.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal<Record<string, unknown>>();
         return { trpc: { q: actual.queryClient } };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Spread nested one level deep does not protect the module's top-level
    // export surface.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal<Record<string, unknown>>();
         return { trpc: { ...actual } };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Factory delegating to a helper — cannot be proven safe, and in practice
    // is the wholesale pattern.
    {
      code: `vi.mock('~/utils/trpc', () => makeTrpcMock());`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Two return paths, only one of which spreads — the unguarded branch still
    // drops the real exports.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal<Record<string, unknown>>();
         if (flag) return { trpc: {} };
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },

    // ================================================================
    // Specifier forms the first cut did not see at all
    // ================================================================
    // A template literal is a perfectly ordinary way to write the specifier and
    // was skipped entirely (only `Literal` was matched).
    {
      code: 'vi.mock(`~/utils/trpc`, () => ({ trpc: {} }));',
      filename: TEST_FILE,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // A relative specifier reaching the same module. `modules` was raw string
    // equality with no path resolution, so this was invisible.
    {
      code: `vi.mock('../../../utils/trpc', () => ({ trpc: {} }));`,
      filename: TEST_FILE,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // ...including with an explicit extension.
    {
      code: `vi.mock('../../../utils/trpc.ts', () => ({ trpc: {} }));`,
      filename: TEST_FILE,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // A relative specifier under the repo's own src/, with the ABSOLUTE
    // filename ESLint really passes. The package-boundary fix must not have
    // narrowed the real case away — this is the other half of the valid
    // PKG_FILE_ABS case above.
    {
      code: `vi.mock('../../../utils/trpc', () => ({ trpc: {} }));`,
      filename: SRC_FILE_ABS,
      errors: [{ messageId: 'wholesaleMock' }],
    },

    // ================================================================
    // 🔴 `delete` — the one unary that really does mutate
    // ================================================================
    // This is the historical bug in its purest form: the spread still looks
    // right, but an export has been removed from the object being spread. It is
    // statically decidable and used to pass SILENTLY, because the old poisoning
    // clause only matched a unary whose argument was a bare Identifier — and
    // `delete actual.trpcVanilla` takes a MemberExpression.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         delete actual.trpcVanilla;
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Computed member access is the same deletion.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         delete actual['trpcVanilla'];
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // ...and so is one reached through an optional chain.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         delete actual?.trpc.vanilla;
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // An UpdateExpression rebinds the name to a number. The reassignment case
    // above covers `=`; this pins `++` specifically, which is the half of the
    // old clause that was doing real work.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         let actual = await importOriginal();
         actual++;
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },

    // ================================================================
    // Guards that had no discriminating case before
    // ================================================================
    // A name declared TWICE is poisoned: which value reaches the spread is no
    // longer knowable. The order matters for whether this discriminates — only
    // the LAST declarator is recorded in `locals`, so the redeclaration has to
    // be the SAFE-looking one. Here the value that actually reaches the spread
    // depends on `flag`, and without the double-declaration check the rule
    // would read only the conditional `await importOriginal()` and call a mock
    // that may be `localStub` clean.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         var actual = localStub;
         if (flag) { var actual = await importOriginal(); }
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // The plain-sequential spelling of the same hazard, kept because it is the
    // shape an author is most likely to write.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         var actual = await importOriginal();
         var actual = { trpc: {} };
         return { ...actual };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // SequenceExpression: the LAST element is the value. Here the safe-looking
    // first element is discarded at runtime, so the mock is wholesale.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return ({ ...actual }, { trpc: {} });
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Cycle guard: a self-referential initialiser must terminate rather than
    // recurse forever. Without the `seen` set this blows the stack and the rule
    // crashes ESLint on the file instead of reporting.
    {
      code: `vi.mock('~/utils/trpc', () => { const a = a; return a; });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // LogicalExpression: the right-hand side is unknown, so the whole
    // expression is. The `cached || {...}` case above pins the LEFT side.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         return actual || fallbackStub;
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // A local declared with NO initialiser cannot carry anything forward, so
    // spreading it is not provable — the `init ? ... : false` fallback.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         let actual;
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // The old-style TS cast is unwrapped in the reporting direction too: the
    // object literal underneath is what gets classified.
    {
      code: `vi.mock('~/utils/trpc', () => { return <any>{ trpc: {} }; });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Specifier canonicalisation strips a trailing `/index`, so the directory
    // form of the target is the same module.
    {
      code: `vi.mock('~/utils/trpc/index', () => ({ trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // 🔴 EVERY return is inspected, not just the first. The two-returns case
    // above has the BAD return first, so it passes even if the analysis stops
    // after one; this one has the SAFE return first and is the only case that
    // fails if it does.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const actual = await importOriginal();
         if (flag) return { ...actual, trpc: {} };
         return { trpc: {} };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },

    // ================================================================
    // 🔴 Which message an author gets, and why it matters at 'error'
    // ================================================================
    // An object literal with NO spread at all gets `wholesaleMock`, whose
    // advice — "spread the real module" — is precisely what is missing.
    {
      code: `vi.mock('~/utils/trpc', () => ({ trpc: { useUtils: () => ({}) } }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // An object literal that DOES spread, but of something unprovable, gets
    // `unprovableMock` instead. Telling an author who already wrote a spread to
    // "spread the real module" is unactionable, and `unprovableMock` is the
    // message that names the disable-comment escape hatch.
    {
      code: `vi.mock('~/utils/trpc', () => ({ ...someUnknown, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // The same, one level of defensiveness deeper: `(actual ?? {})` is a
    // LogicalExpression whose right side is a bare object literal, so the
    // spread is not provable even though `actual` is.
    {
      code: `vi.mock('~/utils/trpc', async (o) => {
         const actual = await o();
         return { ...(actual ?? {}), trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },

    // ================================================================
    // Documented FALSE POSITIVES — safe shapes reported as unprovable
    // ================================================================
    // These are pinned so the cost of the proof-based design stays visible and
    // a future change to it is a deliberate decision, not a surprise. None
    // exists in the tree today; each is one disable comment away. See the
    // "Known FALSE POSITIVES" list in eslint-local-rules.js.
    // Destructure-and-rebuild: `rest` comes from a pattern, not a tracked
    // initialiser.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const { trpc, ...rest } = await importOriginal();
         return { ...rest, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // Array destructuring out of Promise.all — same reason.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const [actual] = await Promise.all([importOriginal()]);
         return { ...actual, trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // An aliased binding: only the parameter itself is recognised as the
    // original call.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const f = importOriginal;
         return { ...(await f()), trpc: {} };
       });`,
      errors: [{ messageId: 'unprovableMock' }],
    },
    // The `vi.hoisted` idiom builds the spread source outside the factory.
    {
      code: `const { actual } = vi.hoisted(() => ({ actual: {} }));
       vi.mock('~/utils/trpc', () => ({ ...actual, trpc: {} }));`,
      errors: [{ messageId: 'unprovableMock' }],
    },

    // ================================================================
    // Options
    // ================================================================
    // The `modules` option extends the scope to another module.
    {
      code: `vi.mock('~/utils/other', () => ({ thing: 1 }));`,
      options: [{ modules: ['~/utils/other'] }],
      errors: [{ messageId: 'wholesaleMock', data: { module: '~/utils/other' } }],
    },
    // ...including a BARE package specifier, which canonicalises to itself.
    // The doc says "extend `modules` rather than broadening the rule", so the
    // non-`~/` shape of the option has to actually work.
    {
      code: `vi.mock('@mantine/hooks', () => ({ useMediaQuery: () => false }));`,
      options: [{ modules: ['@mantine/hooks'] }],
      errors: [{ messageId: 'wholesaleMock', data: { module: '@mantine/hooks' } }],
    },

    // ================================================================
    // The `{{shape}}` placeholder is user-facing message content
    // ================================================================
    // `unprovableMock` names the shape it could not walk. Pin two distinct
    // values so a constant-shape regression is visible.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => { await importOriginal(); });`,
      errors: [
        { messageId: 'unprovableMock', data: { module: '~/utils/trpc', shape: 'no return value' } },
      ],
    },
    {
      code: `vi.mock('~/utils/trpc', () => makeTrpcMock());`,
      errors: [
        { messageId: 'unprovableMock', data: { module: '~/utils/trpc', shape: 'CallExpression' } },
      ],
    },
    // A generic reference with the CALL forgotten parses as a
    // TSInstantiationExpression; unwrapping it is what lets the message name
    // the `Identifier` underneath instead of a node type no author recognises.
    {
      code: `vi.mock('~/utils/trpc', () => { return makeTrpcMock<TrpcModule>; });`,
      errors: [
        { messageId: 'unprovableMock', data: { module: '~/utils/trpc', shape: 'Identifier' } },
      ],
    },
    {
      code: `vi.mock('~/utils/trpc', () => ({ ...someUnknown, trpc: {} }));`,
      errors: [
        {
          messageId: 'unprovableMock',
          data: {
            module: '~/utils/trpc',
            shape: 'an object literal whose spread does not provably carry the original module',
          },
        },
      ],
    },

    // ================================================================
    // `completeFactories` — the helper must come FROM the configured module
    // ================================================================
    // Without these, the option would be a rubber stamp: any function that
    // happened to be named `createPgDbMock` would silence the rule.
    //
    // A same-named LOCAL function is not the designated helper.
    {
      code: `vi.mock('~/server/db/pgDb', async () => {
               const createPgDbMock = () => ({ pgDbRead: {} });
               return createPgDbMock();
             });`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
      errors: [
        {
          messageId: 'unprovableMock',
          data: { module: '~/server/db/pgDb', shape: 'CallExpression' },
        },
      ],
    },
    // Right name, WRONG source module.
    {
      code: `vi.mock('~/server/db/pgDb', async () => {
               const { createPgDbMock } = await import('~/test-utils/somewhere-else');
               return createPgDbMock();
             });`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
      errors: [
        {
          messageId: 'unprovableMock',
          data: { module: '~/server/db/pgDb', shape: 'CallExpression' },
        },
      ],
    },
    // Correct helper, but nominated for a DIFFERENT module — must not leak.
    {
      code: `vi.mock('~/server/db/pgDb', async () => {
               const { createPgDbMock } = await import('~/test-utils/pgDbMock');
               return createPgDbMock();
             });`,
      options: [
        {
          modules: ['~/server/db/pgDb'],
          completeFactories: {
            '~/utils/trpc': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
      errors: [
        {
          messageId: 'unprovableMock',
          data: { module: '~/server/db/pgDb', shape: 'CallExpression' },
        },
      ],
    },
    // The option must not weaken a module it was not configured for.
    {
      code: `vi.mock('~/utils/trpc', () => ({ trpc: {} }));`,
      options: [
        {
          modules: ['~/utils/trpc', '~/server/db/pgDb'],
          completeFactories: {
            '~/server/db/pgDb': { name: 'createPgDbMock', from: '~/test-utils/pgDbMock' },
          },
        },
      ],
      errors: [{ messageId: 'wholesaleMock', data: { module: '~/utils/trpc' } }],
    },
  ],
});
