import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-module-scope-cache'];

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

ruleTester.run('no-module-scope-cache', rule, {
  valid: [
    // ================================================================
    // The canonical lazy pattern — the house rule this enforces
    // ================================================================
    // `paidAccessCache` in src/server/services/paid-access.service.ts, reduced.
    // The call is inside a function, so it runs on first USE, not on import.
    `function createPaidAccessCache(entityType) {
       return createCachedObject({ key: REDIS_KEYS.CACHES.PAID_ACCESS, idKey: 'entityId' });
     }
     const caches = {};
     function paidAccessCache(entityType) {
       return (caches[entityType] ??= createPaidAccessCache(entityType));
     }`,
    // The memoised-singleton spelling PR #3506 uses for capTierCache.
    `function createCapTierCache() {
       return createCachedObject({ key: REDIS_KEYS.CACHES.PAID_ACCESS_CAP_TIER });
     }
     let instance;
     function capTierCache() {
       return (instance ??= createCapTierCache());
     }`,
    // An arrow, not just a function declaration.
    `const cache = () => createCachedObject({ key: 'k' });`,
    // Inside a method — deferred like any other function body.
    `class Service {
       cache() { return createCachedArray({ key: 'k' }); }
     }`,
    // A NON-STATIC class property initialiser runs per instantiation, not on
    // module evaluation, so it is deferred.
    `class Service { cache = createCachedObject({ key: 'k' }); }`,
    // Nested two functions deep — still deferred.
    `function outer() {
       function inner() { return createCachedObject({ key: 'k' }); }
       return inner;
     }`,
    // A default parameter value is evaluated per CALL, not at module scope.
    `function get(cache = createCachedObject({ key: 'k' })) { return cache; }`,
    // Deferred inside a callback that is not invoked here (the lazy-init idiom
    // via a thunk stored for later).
    `const lazy = { get: () => createCachedObject({ key: 'k' }) };`,
    // 🔴 The boundary of the IIFE cases in `invalid` below: an IIFE nested
    // inside a function that is NOT invoked here is genuinely deferred. The
    // walk must resume through the invocation and then stop at the real
    // function, not report everything that has an IIFE anywhere above it.
    `const get = () => (() => createCachedObject({ key: 'k' }))();`,

    // ================================================================
    // Not a cache creator at all
    // ================================================================
    `const x = createSomethingElse({ key: 'k' });`,
    // A member call, not a bare identifier — a different (namespaced) API.
    `const x = helpers.createCachedObject({ key: 'k' });`,
    // The creator merely REFERENCED, not called: re-exporting is harmless.
    `export { createCachedObject };`,
    // Shadowed name is still matched by name (documented gap), but a plain
    // identifier reference is not a call and must stay silent.
    `const fn = createCachedObject;`,

    // ================================================================
    // The `creators` option narrows what counts
    // ================================================================
    {
      code: `const cache = createCachedArray({ key: 'k' });`,
      options: [{ creators: ['createCachedObject'] }],
    },
  ],

  invalid: [
    // ================================================================
    // 🔴 THE HISTORICAL REGRESSION
    // ================================================================
    // The eager `capTierCache` added to paid-access.service.ts, reduced to its
    // shape. This is the exact code that killed three model-service suites at
    // COLLECTION (57 tests) and turned `Unit tests` red on main for every open
    // PR. If this case stops failing, the rule has stopped guarding anything.
    {
      code: `const capTierCache = createCachedObject<CachedCapTier>({
         key: REDIS_KEYS.CACHES.PAID_ACCESS_CAP_TIER,
         idKey: 'userId',
         ttl: CacheTTL.hour,
         staleWhileRevalidate: false,
         lookupFn: async (ids) => ({}),
       });`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // The second symptom's source: an EXPORTED module-scope cache
    // (`filesForModelVersionCache` in model-file.service.ts). Exported is
    // worse, not better — importers reach it directly.
    {
      code: `export const filesForModelVersionCache = createCachedObject({ key: 'k' });`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // createCachedArray is the same hazard (resource-data.redis.ts's shape).
    {
      code: `export const resourceDataCache = createCachedArray({ key: 'k' });`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },

    // ================================================================
    // Module scope in its other spellings
    // ================================================================
    // Bare expression statement, no binding at all.
    {
      code: `createCachedObject({ key: 'k' });`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // Inside a module-scope object literal — still evaluated on import.
    {
      code: `const caches = { files: createCachedObject({ key: 'k' }) };`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // Inside a module-scope array literal.
    {
      code: `const all = [createCachedObject({ key: 'a' }), createCachedArray({ key: 'b' })];`,
      errors: [{ messageId: 'moduleScopeCache' }, { messageId: 'moduleScopeCache' }],
    },
    // Inside a module-scope `if` — conditional, but still on import.
    {
      code: `let c; if (flag) { c = createCachedObject({ key: 'k' }); }`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // A STATIC class property initialiser DOES run during module evaluation,
    // unlike the instance property in the valid cases above.
    {
      code: `class Service { static cache = createCachedObject({ key: 'k' }); }`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // A class static block runs at module evaluation too.
    {
      code: `class Service { static { createCachedObject({ key: 'k' }); } }`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // A top-level await does not defer anything.
    {
      code: `const c = await Promise.resolve(createCachedObject({ key: 'k' }));`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },

    // ================================================================
    // 🔴 The IIFE bypass — a function wrapper that is NOT deferral
    // ================================================================
    // The obvious way to get past a naive "is it inside a function?" check.
    // These run at module scope regardless of the arrow around them, so a rule
    // that stops at the first enclosing function is wrong here.
    {
      code: `const cache = (() => createCachedObject({ key: 'k' }))();`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    {
      code: `const cache = (function () { return createCachedObject({ key: 'k' }); })();`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // Two IIFEs deep — the walk has to resume from each invocation, not stop.
    {
      code: `const cache = (() => (() => createCachedObject({ key: 'k' }))())();`,
      errors: [{ messageId: 'moduleScopeCache' }],
    },
    // (The boundary case — an IIFE nested inside a function that is not itself
    // invoked — is genuinely lazy and is pinned in `valid` above.)

    // ================================================================
    // The `creators` option, in the reporting direction
    // ================================================================
    {
      code: `const c = makeOurCache({ key: 'k' });`,
      options: [{ creators: ['makeOurCache'] }],
      errors: [{ messageId: 'moduleScopeCache' }],
    },
  ],
});
