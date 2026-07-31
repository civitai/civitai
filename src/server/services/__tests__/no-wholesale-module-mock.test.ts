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
const ruleTester = new RuleTester(
  ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]
);

ruleTester.run('no-wholesale-module-mock', rule, {
  valid: [
    // ---- The canonical pattern (ChallengeUpsertForm.browser.test.tsx) ----
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
    // Straight passthrough — returns the original, no object literal to inspect.
    `vi.mock('~/utils/trpc', async (importOriginal) => importOriginal());`,
    // Automock (no factory) preserves the real export shape by construction.
    `vi.mock('~/utils/trpc');`,

    // ---- Out of scope: other modules ----
    // The rule is scoped to its `modules` option (default just ~/utils/trpc);
    // a wholesale mock of any other module must NOT fire. This is what keeps
    // the rule quiet enough to stay enabled.
    `vi.mock('~/hooks/useCFImageUpload', () => ({ useCFImageUpload: () => ({}) }));`,
    `vi.mock('@mantine/hooks', () => ({ useMediaQuery: () => false }));`,
    // Non-literal specifier (computed) — nothing to match against.
    `vi.mock(SOME_MODULE, () => ({ trpc: {} }));`,
    // Not a vi.mock call at all.
    `foo.mock('~/utils/trpc', () => ({ trpc: {} }));`,

    // ---- Nested-function isolation ----
    // A `return` inside an inner callback must not be mistaken for the
    // factory's own return value; the factory's real return spreads correctly.
    `vi.mock('~/utils/trpc', async (importOriginal) => {
       const actual = await importOriginal<Record<string, unknown>>();
       const useQuery = () => { return { data: undefined, isLoading: false }; };
       return { ...actual, trpc: { model: { getAll: { useQuery } } } };
     });`,
  ],
  invalid: [
    // ---- The exact shape that broke five suites / ~36 tests ----
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
      errors: [{ messageId: 'wholesaleMock' }],
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
    // The `modules` option extends the scope to another module.
    {
      code: `vi.mock('~/utils/other', () => ({ thing: 1 }));`,
      options: [{ modules: ['~/utils/other'] }],
      errors: [{ messageId: 'wholesaleMock', data: { module: '~/utils/other' } }],
    },
  ],
});
