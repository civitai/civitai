import { vi } from 'vitest';

/**
 * A `trpc` client stub shaped as a PROXY: any router/procedure path answers with an inert hook,
 * and only the procedures a test actually measures are overridden.
 *
 * 🔴 WHY THIS EXISTS — A HAND-ENUMERATED `trpc` MOCK HAS NOW COST THIS REPO FOUR TIMES, AND THE
 * FAILURE NEVER NAMES ITSELF. A literal mock object answers `undefined` for every procedure nobody
 * remembered, so the component throws `TypeError: trpc.<x> is not a function` during render and the
 * test fails on `Cannot find element with locator: …` — a message that reads as "the feature is
 * broken" and says nothing about the fixture. The component under test is fine; the mock is the
 * defect, and it is indistinguishable from a real regression until someone reads the stderr.
 *
 * The measured history, worth keeping because it is why a shared helper beats a per-file rule:
 *   - `AppsWideLayout.geometry.test.tsx` hit it with four real components in one tree and moved to
 *     a local proxy ("a literal mock object fails … for every one nobody remembered, which is a
 *     fixture problem masquerading as a component problem").
 *   - `AppActivityPage.browser.test.tsx` hit it and did the same.
 *   - Phase 3 hit it TWICE MORE: adding `trpc.useUtils()` to the permissions list broke six arms in
 *     `AppPermissionsActivityDrawer.browser.test.tsx` and one in
 *     `AppBlockChromePlatformNav.browser.test.tsx`.
 *   - And `AppBlockChromeMobileShell.browser.test.tsx` was one line from the same break: it opens
 *     the drawer for real, and passed ONLY because its viewer is anon, so the drawer took its
 *     `!isAuthed` branch and never reached the hook. The next authed arm in that file would have
 *     paid for it.
 *
 * ⚠️ THE PER-FILE COMMENT DID NOT WORK, WHICH IS THE ARGUMENT FOR THE HELPER. The drawer test
 * carried an explicit rule — *"If a FOURTH procedure is ever needed, convert the non-spied half to
 * a proxy instead of adding a fifth literal"* — and when `revokeScopes` became exactly that fourth
 * procedure, the same session that wrote the rule added two more literals instead. Prose in a
 * fixture cannot make the next author convert; a helper that is easier to call than to hand-roll
 * can.
 *
 * 🔴 IT DOES NOT MAKE A MOCK PERMISSIVE IN THE DIRECTION THAT MATTERS. Overridden procedures still
 * carry whatever spy the test supplies, so assertions on call arguments are unaffected; what the
 * proxy removes is the ability for an UNMEASURED procedure to crash the render. A test that wants
 * to assert a procedure is never called should spy it explicitly rather than rely on absence.
 *
 * ── 🔴 NEVER ASSERT THROUGH THE DEFAULTS. TWO REASONS, BOTH SILENT. ──────────────────────────────
 *
 * Reported independently by the round-2 test and perf lanes, and worth stating as a rule rather than
 * a caveat because both failures read as a legitimate zero:
 *
 * 1. **`utilsNode()` mints a FRESH `vi.fn()` on every property access.** It rebuilds its `leaf`
 *    object per path segment, so `trpc.useUtils().blocks.x.invalidate` is a DIFFERENT spy each time
 *    it is read. `expect(utils.blocks.x.invalidate).toHaveBeenCalled()` against the default can
 *    therefore never pass — it reads a permanent, silent 0, which is indistinguishable from "the
 *    code under test did not invalidate". If you need to assert an invalidate, pass your own stable
 *    spy via `topLevel.useUtils` (`ScopeRevoke.browser.test.tsx` does exactly this, and the 412-vs-503
 *    arms depend on it).
 * 2. **`inertQuery` / `inertInfiniteQuery` / `inertMutation` are module-level SINGLETONS**, so their
 *    `vi.fn()`s are shared by every un-overridden procedure, in every test, in every file that
 *    imports this helper — and nothing clears them. A `not.toHaveBeenCalled()` reached through a
 *    default is contaminated by any earlier test that touched any other default procedure.
 *
 * The rule that covers both: **the defaults exist to stop a render crashing, never to be measured.**
 * Override anything you intend to assert on.
 */

/** The shape every un-overridden query resolves to: loaded, empty, not an error. */
const inertQuery = {
  data: undefined,
  error: null,
  isLoading: false,
  isFetching: false,
  isPending: false,
  isError: false,
  isSuccess: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
};

/**
 * An un-overridden INFINITE query needs `data.pages` to exist, because the components that read one
 * do `data.pages.flatMap(...)` unguarded. `undefined` there is a crash, not an empty list — the same
 * class of fixture defect this file exists to remove, one level down.
 */
const inertInfiniteQuery = { ...inertQuery, data: { pages: [] as unknown[] } };

const inertMutation = {
  isPending: false,
  isError: false,
  mutate: vi.fn(),
  mutateAsync: vi.fn(async () => undefined),
  reset: vi.fn(),
};

/** `useUtils()`'s shape: any router/procedure path answers with the invalidate/fetch helpers. */
function utilsNode(): unknown {
  const leaf = {
    invalidate: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    prefetch: vi.fn(async () => undefined),
    setData: vi.fn(),
    getData: vi.fn(),
    cancel: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  };
  return new Proxy(
    {},
    {
      get(_t, key: string) {
        if (key === 'then') return undefined; // never look thenable to an `await`
        if (key in leaf) return (leaf as Record<string, unknown>)[key];
        return utilsNode();
      },
    }
  );
}

/**
 * A NESTED sub-router (e.g. `apps.shared`, `apps.storage`) whose every procedure answers
 * with an inert mutation hook. `makeTrpcProxy` resolves `'<router>.<procedure>'` one level
 * deep, so a component reading `trpc.apps.shared.append.useMutation()` needs this as the
 * override for `'apps.shared'`. `has` answers true so an `in` probe sees every procedure.
 */
export function makeInertSubRouter(): unknown {
  return new Proxy(
    {},
    {
      has: () => true,
      get: (_t, key) =>
        key === 'then' ? undefined : { useMutation: () => ({ mutateAsync: vi.fn() }) },
    }
  );
}

/**
 * Build the proxy.
 *
 * @param procedures Overrides keyed `'<router>.<procedure>'`, each the HOOK CONTAINER for that
 *   procedure — e.g. `{ 'blocks.listMyScopeGrants': { useQuery: mySpy } }`. A key with no match
 *   falls through to the inert hooks, so a test only names what it measures.
 * @param topLevel Overrides for client-level members (`useUtils`, `useQueries`, …). `useUtils` and
 *   `useQueries` already have working defaults; pass one only to assert on it.
 */
export function makeTrpcProxy(
  procedures: Record<string, unknown> = {},
  topLevel: Record<string, unknown> = {}
): unknown {
  const hooks: Record<string, unknown> = {
    useQuery: () => inertQuery,
    useInfiniteQuery: () => inertInfiniteQuery,
    useMutation: () => inertMutation,
    useSuspenseQuery: () => inertQuery,
  };
  const procNode = (override: unknown): unknown =>
    new Proxy(
      {},
      {
        get(_t, key: string) {
          if (key === 'then') return undefined;
          if (override && typeof override === 'object' && key in (override as object)) {
            return (override as Record<string, unknown>)[key];
          }
          if (key in hooks) return hooks[key];
          return undefined;
        },
      }
    );
  return new Proxy(
    {},
    {
      get(_t, router: string) {
        if (router === 'then') return undefined;
        if (router in topLevel) return topLevel[router];
        if (router === 'useUtils' || router === 'useContext') return () => utilsNode();
        if (router === 'useQueries') return () => [];
        return new Proxy(
          {},
          {
            get(_t2, proc: string) {
              if (proc === 'then') return undefined;
              return procNode(procedures[`${router}.${proc}`]);
            },
          }
        );
      },
    }
  );
}
