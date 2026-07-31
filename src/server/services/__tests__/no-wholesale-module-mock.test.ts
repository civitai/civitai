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
    // Nested-function isolation
    // ================================================================
    // A `return` inside an inner callback must not be mistaken for the
    // factory's own return value; the factory's real return spreads correctly.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal<Record<string, unknown>>();
       const useQuery = () => { return { data: undefined, isLoading: false }; };
       return { ...actual, trpc: { model: { getAll: { useQuery } } } };
     });`,
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
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // A COMMENT mentioning importOriginal satisfied it too — and a large share
    // of the existing backlog factories already carry an explanatory comment.
    {
      code: `vi.mock('~/utils/trpc', () => ({ /* TODO: switch to importOriginal */ ...localStub, trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // ...as did the bare string, anywhere in the factory.
    {
      code: `vi.mock('~/utils/trpc', () => ({ note: 'importOriginal', ...localStub, trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Spreading a dynamic import of some OTHER module is not the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => ({ ...(await import('./elsewhere')), trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // `vi.importActual` of a DIFFERENT module leaves every trpc export missing.
    {
      code: `vi.mock('~/utils/trpc', async () => ({ ...(await vi.importActual('~/utils/other')), trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // A dynamic import of the module being mocked is a SELF-reference: Vitest
    // serves the mock, not the original. Only importOriginal/importActual work.
    {
      code: `vi.mock('~/utils/trpc', async () => ({ ...(await import('~/utils/trpc')), trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
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
      errors: [{ messageId: 'wholesaleMock' }],
    },
    // Spreading a PROPERTY of the original is not spreading the original.
    {
      code: `vi.mock('~/utils/trpc', async (importOriginal) => {
         const mod = await importOriginal();
         return { ...mod.default, trpc: {} };
       });`,
      errors: [{ messageId: 'wholesaleMock' }],
    },

    // ================================================================
    // Spread present, but not of the original
    // ================================================================
    // A spread of a LOCAL stub is not a fix — the real module is still gone.
    {
      code: `vi.mock('~/utils/trpc', () => ({ ...baseStub, trpc: {} }));`,
      errors: [{ messageId: 'wholesaleMock' }],
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

    // ================================================================
    // Options
    // ================================================================
    // The `modules` option extends the scope to another module.
    {
      code: `vi.mock('~/utils/other', () => ({ thing: 1 }));`,
      options: [{ modules: ['~/utils/other'] }],
      errors: [{ messageId: 'wholesaleMock', data: { module: '~/utils/other' } }],
    },
  ],
});
