import { ModalsProvider } from '@mantine/modals';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// The seam test renders TWO trees in one test and has to tear the first one down —
// `component-setup`'s `afterEach` has not run yet, and two trees would make every
// document-scoped query read the first. Same mechanism as
// `AppPermissionsActivityDrawer.browser.test.tsx`'s activity seam.
import { cleanup } from 'vitest-browser-react';
// Type-only namespace import, NOT `typeof import('...')` — the latter is rejected by
// @typescript-eslint/consistent-type-imports.
import type * as TrpcMod from '~/utils/trpc';
// Type-only NAMESPACE import, not `typeof import('...')` — `@typescript-eslint/`
// `consistent-type-imports` forbids the inline form, and CI lints changed files. Same reason the
// sibling drawer test imports `TrpcMod` this way.
import type * as NotificationsMod from '~/utils/notifications';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * PHASE 3 — the per-scope REVOKE control, on BOTH permissions surfaces, FROM ONE FIXTURE.
 *
 * 🔴 THE FIXTURE BEING SHARED IS THE POINT OF THE FILE, NOT A CONVENIENCE. The run-frame drawer
 * (`AppPermissionsActivityDrawer`, ~408px) and the full-width "Apps & permissions" tab
 * (`ScopeGrantsPanel` in `src/pages/apps/activity.tsx`) render the same permissions list from the
 * same `blocks.listMyScopeGrants` read, and this pair has ALREADY needed three separate one-sided
 * corrections — the empty-scope label, the budget-control comment, and the query-error branch. A
 * revoke control is a much worse thing to have two copies of: the failure is not a stale sentence
 * but a permission the viewer withdrew on one surface and is still offered on the other. Both
 * surfaces are therefore driven from `GRANT` below, and the seam test compares the DOM they
 * produce rather than trusting that they call the same component.
 *
 * 🔴 AND BOTH ARE THE REAL MOUNTS. `ScopeGrantsPanel` is imported from the page module, not
 * re-implemented here — a test-local copy of the panel would be a THIRD rendering of the list and
 * would stay green while the page diverged.
 */

/**
 * ONE app's grant row, read by every arm and by BOTH mounts.
 *
 * The scope set is chosen so each of the three consent states has at least one row AND so the
 * exempt arm can name more than one member:
 *   - `ai:write:budgeted`, `posts:write:self` → consent-gated, so the server lists them in
 *     `revokableScopes` and they get a real control. `ai:write:budgeted` is also the SPEND scope,
 *     which is what makes the confirm dialog's budget sentence reachable.
 *   - `apps:storage:read`, `apps:storage:shared:write`, `collections:read:self`, `models:read:self`
 *     → four of the `CONSENT_EXEMPT_SCOPES`. Present in `scopes` (an app really does declare
 *     them) and ABSENT from `revokableScopes`, which is exactly the shape the server produces.
 *   - `collections:read:private` → already withdrawn, and deliberately NOT in `scopes`: it tests
 *     the row surviving the publisher dropping it from the manifest.
 *
 * ⚠️ `status: 'suspended'` IS ON THIS FIXTURE ON PURPOSE. `blocks.revokeScopes` has no
 * approved-status gate — withdrawing consent from a suspended app is the case that matters most —
 * and `ScopeGrantSurface` carries no status field at all, so there is nothing for the UI to gate
 * on. Carrying the property anyway makes that a MEASURED fact rather than an inferred one: if
 * anything downstream ever starts branching on it, the suspended arm below goes red.
 */
const GRANT = {
  appBlockId: 'ab_seam',
  slug: 'lighthouse',
  name: 'Lighthouse',
  origin: 'consent' as const,
  status: 'suspended',
  surfaces: { subscriptionScopes: [], modelInstallCount: 0 },
  scopes: [
    'ai:write:budgeted',
    'posts:write:self',
    'apps:storage:read',
    'apps:storage:shared:write',
    'collections:read:self',
    'models:read:self',
  ],
  revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
  /**
   * 🔴 EQUAL TO `revokableScopes` HERE, DELIBERATELY, SO THE ARMS BELOW STAY ABOUT WHAT THEY SAY
   * THEY ARE ABOUT. `revokableScopes` is the APP's consent-gated set and this is the VIEWER's —
   * a row needs to be in BOTH to get a control, since `blocks.revokeScopes` refuses a scope the
   * viewer never granted. Making them equal keeps every `revokeButtons().toHaveLength(
   * GRANT.revokableScopes.length)` assertion in this file measuring the control, not the split.
   * The split itself has its own `describe.each` block near the bottom, on a DERIVED grant.
   */
  grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
  revokedScopes: ['collections:read:private'],
  scopesRevokedAt: new Date('2026-09-14T11:30:00Z'),
  buzzBudgetPerDay: null,
  spendScopeGranted: false,
};

/**
 * The four exempt members this fixture declares, each with a LITERAL fragment its note must carry.
 *
 * 🔴 THE FRAGMENTS ARE HARD-CODED ON PURPOSE — DERIVING THEM FROM `FIXED_SCOPE_NOTES` MAKES THE
 * ASSERTION UNABLE TO FAIL, AND THAT IS NOT HYPOTHETICAL: IT SURVIVED A MEASURED MUTANT. Round 1
 * fixed the flat-list problem by binding each note to its OWN row, but kept
 * `expect(note).toBe(FIXED_SCOPE_NOTES[scope])` — so a mutant that SWAPS two entries' keys swapped
 * the rendered note AND the expectation together, and the whole suite (unit, component, geometry)
 * stayed green. Measured: `notes-swapped` exchanging `models:read:self` with `collections:read:self`
 * → 15/15, 33/33, 46/46 all passing.
 *
 * So each fragment names the MECHANISM that scope's own server-side gate actually is, taken from the
 * gate rather than from the map under test. A swap then puts "the page you opened" on a collections
 * row and "visibility and ownership" on a model row, and both reds.
 *
 * ⚠️ FRAGMENTS, NOT WHOLE SENTENCES, and the trade is deliberate: a whole-string literal here would
 * be a second copy of reviewed prose that reds on every cosmetic reword, which is what
 * `FIXED_SCOPE_NOTES` is for. A fragment naming the gate is the part that must not move, because it
 * is the part that would be a lie on another row. They must stay PAIRWISE DISTINCT — a fragment two
 * scopes share cannot see a swap between them.
 */
const EXEMPT_NOTE_MUST_MENTION: Record<string, RegExp> = {
  /**
   * The app's own private per-install store, READ.
   *
   * 🔴 `/reaches only/i`, NOT `/private store/i` — AND THE FIRST SPELLING LEFT A LIVE SURVIVOR.
   * `FIXED_SCOPE_NOTES['apps:storage:write']` ALSO contains "private store", so swapping those two
   * adjacent entries rendered *"It **writes** only to this app's own private store"* on the
   * read-only row — a false statement about a read permission — while `/private store/i` still
   * matched and `toBe(FIXED_SCOPE_NOTES[scope])` still passed, both sides reading the mutated map.
   * They are the two most swap-prone entries in the map: adjacent, same key prefix, near-identical
   * sentence shape. Reported by the round-2 test lane as `notes-swapped-storage-read-write`.
   */
  'apps:storage:read': /reaches only/i,
  // `resolveSharedContext`'s min-trust gate + moderation + rate limits, on the WRITE path.
  'apps:storage:shared:write': /account-trust/i,
  // Server-side visibility/ownership checks on the collection itself.
  'collections:read:self': /visibility and ownership/i,
  // The subject is fixed by the page the block is mounted on.
  'models:read:self': /the page you opened/i,
};
const EXEMPT_IN_FIXTURE = Object.keys(EXEMPT_NOTE_MUST_MENTION);

const m = vi.hoisted(() => ({
  grants: [] as unknown[],
  /** Every `revokeScopes.mutate` payload, in order. The confirm gate is measured on its LENGTH. */
  revokeCalls: [] as { appBlockId: string; scopes: string[] }[],
  /** Set to drive the error arms. `null` = the mutation succeeds. */
  revokeError: null as null | { code: string; message: string },
  invalidateSpy: undefined as unknown as ReturnType<typeof vi.fn>,
  /**
   * 🔴 HOLDS THE MUTATION OPEN so the PENDING state is observable. Without it the promise settles
   * in the same microtask and the spinner/disabled window never exists to assert on — which is
   * exactly why the whole pending path was unguarded: a mutant deleting the `finally` that clears
   * `pendingScope`, or widening `loading` to every button, survived the entire suite.
   * `gated = true` makes `mutateAsync` return a promise that settles only when `release()` is
   * called; the default `false` settles in the same microtask, as every other arm expects.
   */
  gated: false,
  release: null as null | (() => void),
  /** Same idea for the cache invalidation — see the `trpc` factory. */
  invalidateGated: false,
  releaseInvalidate: null as null | (() => void),
  notify: undefined as unknown as {
    success: ReturnType<typeof vi.fn>;
    warning: ReturnType<typeof vi.fn>;
  },
}));

/**
 * 🔴 THE NOTIFICATION HELPERS ARE SPIED, because the entire success path was otherwise unasserted:
 * deleting `showSuccessNotification`, or swapping the degraded `showWarningNotification` for a
 * SUCCESS one, survived every arm in this file. The second of those is the dangerous one — a 503
 * means "removed, but an open session may keep it for a few minutes", and announcing that as an
 * unqualified success is the misreport the whole degraded branch exists to prevent.
 */
vi.mock('~/utils/notifications', async (importOriginal) => {
  const success = vi.fn();
  const warning = vi.fn();
  m.notify = { success, warning };
  return {
    ...(await importOriginal<typeof NotificationsMod>()),
    showSuccessNotification: success,
    showWarningNotification: warning,
  };
});

vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'viewer', isModerator: false }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true }),
  useFeatureFlagsReady: () => true,
  FeatureFlagsProvider: ({ children }: { children: unknown }) => children,
}));
// The page module calls `createServerSideProps` at import time, which pulls the server graph into
// a browser bundle. Same stub the geometry file uses for the same reason.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

/**
 * 🔴 SPREADS THE REAL MODULE AND OVERRIDES ONLY `trpc` (local-rules/no-wholesale-module-mock). A
 * hand-written replacement module means the day `~/utils/trpc` gains an export this factory omits,
 * every importer gets `undefined`, the FILE fails to load, and the run reports 0 tests collected
 * with no failing assertion — silently green.
 *
 * 🔴 THE MUTATION MOCK INVOKES THE REAL CALLBACKS. `useScopeRevoke` puts everything that matters
 * in `onSuccess` / `onError` / `onSettled` — the cache invalidation, the failure state, the
 * degraded-vs-refused split, the spinner reset. A mock returning an inert `mutate` would leave all
 * of it unexecuted while the arms that "cover" it still passed, so the mock drives the same three
 * callbacks react-query would. The error object carries `data.code` and `message` because those
 * are the only two fields the hook reads.
 */
vi.mock('~/utils/trpc', async (importOriginal) => {
  /**
   * 🔴 GATEABLE, because `justRevoked`'s whole lifetime is "until this settles". With an
   * immediately-resolving invalidate there is no in-flight window to observe at all, and the arm
   * that tests the window would pass or fail for reasons unrelated to it.
   */
  const invalidateSpy = vi.fn(() => {
    if (!m.invalidateGated) return Promise.resolve();
    return new Promise<void>((resolve) => {
      m.releaseInvalidate = () => resolve();
    });
  });
  m.invalidateSpy = invalidateSpy;
  const grantsQuery = () => ({ data: m.grants, isLoading: false, isError: false });
  /**
   * 🔴 `mutateAsync`, MIRRORING WHAT THE HOOK CALLS — it resolves or REJECTS a promise, exactly as
   * react-query's `mutateAsync` does, and asserts nothing about option callbacks.
   *
   * ⚠️ AN EARLIER DOCBLOCK HERE JUSTIFIED THE SHAPE WITH A REACT-QUERY BEHAVIOUR THAT DOES NOT
   * EXIST, and the justification is RETRACTED. It said the hook avoids option callbacks "because the
   * confirm dialog renders into a global provider and can outlive the component: an unsubscribed
   * observer would drop every callback and leave a changed permission unreported", and concluded
   * that "a mock that kept calling option callbacks would keep passing if the hook regressed to
   * them" — i.e. it set out to ENFORCE this shape on a false premise. The round-2 correctness lane
   * read `@tanstack/query-core@5.101.0`: `Mutation.execute` awaits `onSuccess`/`onError`/`onSettled`
   * unconditionally, with no reference to `#observers`. Only per-call `mutate(vars, options)`
   * options are listener-gated, and this code never used those.
   *
   * The shape is still correct and this mock is still the right mock — but for the ORDERING reason
   * documented on the hook (telling the viewer before reconciling the cache, which the option form
   * could not express), not for a lifecycle reason. Do not re-derive the retracted claim from the
   * fact that the fixture is written this way.
   */
  const revokeMutation = () => ({
    isPending: false,
    mutateAsync: (vars: { appBlockId: string; scopes: string[] }) => {
      m.revokeCalls.push(vars);
      const settle = () =>
        m.revokeError
          ? Promise.reject({ data: { code: m.revokeError.code }, message: m.revokeError.message })
          : Promise.resolve({ ok: true });
      // Gated: return a promise that does not settle until the arm calls `release()`, so the
      // PENDING window is observable. See `m.gated`.
      if (!m.gated) return settle();
      return new Promise((resolve, reject) => {
        m.release = () => settle().then(resolve, reject);
      });
    },
  });
  /**
   * 🔴 A PROXY WITH TWO OVERRIDES — the six inert entries this file first hand-enumerated
   * (`listMyAppActivity`, `listMyScopeInvocations`, `listMySubscriptions`, `grantScopes`,
   * `modelVersion`, `useQueries`) were the same landmine the sibling chrome files just paid for,
   * planted in the file that exists BECAUSE of it. Every one of them was there only to stop a
   * neighbouring subtree crashing; none is measured here. See `test/trpcProxyStub.ts`.
   *
   * `useUtils` is overridden rather than defaulted because the 412-vs-503 arms assert on whether
   * the grant list was re-read, so that spy is load-bearing.
   */
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        'blocks.listMyScopeGrants': { useQuery: grantsQuery },
        'blocks.revokeScopes': { useMutation: revokeMutation },
      },
      { useUtils: () => ({ blocks: { listMyScopeGrants: { invalidate: invalidateSpy } } }) }
    ),
  };
});

// eslint-disable-next-line import/first
import { AppPermissionsActivityDrawer } from '~/components/AppBlocks/AppPermissionsActivityDrawer';
// eslint-disable-next-line import/first
import { ScopeGrantsPanel } from '~/pages/apps/activity';
// eslint-disable-next-line import/first
import {
  FIXED_SCOPE_NOTES,
  SCOPE_NOT_GRANTED_NOTE,
  SCOPE_WITHHELD_NOTE,
} from '~/components/Apps/scopeConsentRows';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The two REAL surfaces, as a named pair every arm loops over.
 *
 * 🔴 A LOOP, NOT TWO COPIES OF EACH ARM. An arm written once per surface is how one of them stops
 * being updated — which is the documented history of this exact pair. Every behavioural claim
 * below is therefore asserted on both mounts or on neither, and the surface name is in the failure
 * message so a one-sided regression says WHICH side.
 */
/**
 * 🔴 EACH SURFACE EXPOSES ITS ELEMENT AS WELL AS A `render()`, SO AN ARM CAN FORCE A GENUINE
 * RE-RENDER WITH THE NEW FIXTURE. Nothing else in this file needed it, and its absence made one
 * assertion VACUOUS: `ModalsProvider` receives `children` as a prop, so toggling a modal re-renders
 * the provider but React bails out on the SAME child element and the permissions subtree never
 * re-reads `listMyScopeGrants`. An arm that changed `m.grants` and then opened/cancelled a dialog to
 * "force a render" therefore measured the PREVIOUS payload — and passed, because the local override
 * happened to produce the same mark count. `rerender(element())` is the only thing here that really
 * re-reads the query mock.
 */
const SURFACES = [
  {
    name: 'drawer',
    element: () => (
      <ModalsProvider>
        <AppPermissionsActivityDrawer
          appBlockId={GRANT.appBlockId}
          appName={GRANT.name}
          opened
          onClose={vi.fn()}
        />
      </ModalsProvider>
    ),
  },
  {
    name: 'activity page',
    element: () => (
      <ModalsProvider>
        <ScopeGrantsPanel />
      </ModalsProvider>
    ),
  },
].map((surface) => ({ ...surface, render: () => renderWithProviders(surface.element()) }));

function revokeButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="scope-revoke-button"]'));
}
function revokableScopesOnScreen(): string[] {
  return revokeButtons().map((b) => b.dataset.scope ?? '');
}

beforeEach(() => {
  m.grants = [GRANT];
  m.revokeCalls = [];
  m.revokeError = null;
  m.gated = false;
  m.release = null;
  m.invalidateGated = false;
  m.releaseInvalidate = null;
  m.invalidateSpy?.mockClear();
  m.notify?.success.mockClear();
  m.notify?.warning.mockClear();
});

describe.each(SURFACES)('per-scope revoke — $name', ({ name, render, element }) => {
  test('a control is offered for EVERY revokable scope and for no other row', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    // The SET, not a count: a count is satisfied by two controls on the wrong two scopes.
    expect(revokableScopesOnScreen().sort(), name).toEqual([...GRANT.revokableScopes].sort());
  });

  test('🔴 no control for a consent-EXEMPT scope — asserted for all four by name', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const offered = revokableScopesOnScreen();
    // 🔴 BY NAME, AND MORE THAN ONE. A control on an exempt scope is a LIE, not a cosmetic bug:
    // `partitionByConsent` signs an exempt scope on the exempt test ALONE, before it consults the
    // grant, so the row would update, the mutation would be refused by the server, and — if the
    // server's refusal were ever relaxed — the app would keep the permission anyway.
    for (const scope of EXEMPT_IN_FIXTURE) {
      expect(
        offered,
        `${name}: a revoke control was offered for the exempt scope ${scope}`
      ).not.toContain(scope);
    }
    // …and each one explains itself rather than sitting there silent or greyed out.
    //
    // 🔴 THE NOTE IS READ FROM ITS OWN ROW, NOT FROM A FLAT LIST OF EVERY NOTE ON SCREEN — and the
    // flat-list version was walkable by a MUTANT THAT ROTATES `FIXED_SCOPE_NOTES`' VALUES. Collecting
    // all notes and asserting set membership per scope only checks that the right SENTENCES appear
    // somewhere; swap two values and the set is unchanged, so this arm passed, and so did every
    // other guard in the segment (the unit test compares `fixedScopeNote(s)` against
    // `FIXED_SCOPE_NOTES[s]` — both sides read the mutated map — and the seam ledger only compares
    // the two surfaces against each other, so both were identically wrong). Nothing bound a note to
    // a row. Live consequence: a viewer told that `collections:write:self` "reads only the model on
    // the page the app is mounted on", i.e. exactly the mis-description the notes exist to prevent.
    // Found by the test-review lane.
    for (const scope of EXEMPT_IN_FIXTURE) {
      const id = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')
      ).find((el) => el.textContent === scope);
      expect(id, `${name}: no row rendered for ${scope}`).toBeTruthy();
      const row = id!.closest('[data-testid="block-scope-list"] > *');
      expect(row, `${name}: ${scope}'s id is not inside a scope row`).toBeTruthy();
      const note = row!.querySelector('[data-testid="scope-fixed-note"]');
      expect(note, `${name}: no note in ${scope}'s OWN row`).toBeTruthy();
      // The row carries the map's sentence for THIS scope…
      expect(note!.textContent, `${name}: ${scope}'s row carries a different note`).toBe(
        FIXED_SCOPE_NOTES[scope]
      );
      // 🔴 …AND THE SENTENCE NAMES THIS SCOPE'S OWN GATE, asserted against a LITERAL. The line
      // above alone cannot see a swap, because both its sides read the same (mutated) map — see
      // `EXEMPT_NOTE_MUST_MENTION`. This is the line that kills `notes-swapped`.
      expect(
        note!.textContent ?? '',
        `${name}: ${scope}'s row does not name its own server-side gate — it is carrying another ` +
          "scope's note, which tells the viewer the wrong thing about what governs this permission"
      ).toMatch(EXEMPT_NOTE_MUST_MENTION[scope]);
    }
    // A DISABLED BUTTON IS THE OTHER REJECTED SHAPE — it says "you could do this if something
    // changed", and nothing the viewer can do will ever make an exempt scope withdrawable. So the
    // count of controls must equal the revokable count exactly, enabled or not.
    expect(revokeButtons(), name).toHaveLength(GRANT.revokableScopes.length);
  });

  test('🔴 CANCELLING the confirm fires NO mutation', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    await page.getByTestId('scope-revoke-button').first().click();
    // The dialog really opened — otherwise "no mutation fired" is satisfied by a button that does
    // nothing at all, and this arm would pass against a broken control.
    await expect.element(page.getByTestId('scope-revoke-confirm-body')).toBeVisible();
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(m.revokeCalls, `${name}: cancelling the confirm still fired the mutation`).toHaveLength(
      0
    );
  });

  test('🔴 CONFIRMING fires it EXACTLY ONCE, with the right appBlockId and scope', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    // 🔴 THE EXPECTED SCOPE IS CAPTURED **BEFORE** THE CLICK. It used to be read afterwards, from
    // `revokableScopesOnScreen()[0]` — i.e. derived from the post-action DOM, which is the state the
    // action is supposed to change. That went red the moment a successful revoke started suppressing
    // its own row's control (correctly): `[0]` then resolved to a DIFFERENT scope and the assertion
    // compared the payload against the wrong one. An expectation read out of post-action state is
    // not an expectation.
    const target = revokableScopesOnScreen()[0];
    expect(target, 'the fixture has no revokable scope').toBeTruthy();
    await page.getByTestId('scope-revoke-button').first().click();
    await expect.element(page.getByTestId('scope-revoke-confirm-body')).toBeVisible();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    // ONCE — a double-fire would revoke twice and, on a shape where the second call raced the
    // first's invalidate, report a failure for a revoke that succeeded.
    expect(m.revokeCalls, name).toHaveLength(1);
    expect(m.revokeCalls[0], name).toEqual({
      appBlockId: GRANT.appBlockId,
      // ONE scope, not the app's whole set: the payload is what the server stores as the
      // suppression list, and sending every scope would withdraw permissions the viewer kept.
      scopes: [target],
    });
    // The list is re-read, or the row keeps showing a permission that is gone.
    expect(m.invalidateSpy, `${name}: the grant list was not invalidated`).toHaveBeenCalled();
  });

  test('a REVOKED scope still renders, marked, and the timestamp is app-level', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const [revokedScope] = GRANT.revokedScopes;
    // It is present AT ALL — this scope is deliberately absent from `scopes`, so a surface that
    // rendered the manifest intersection alone would have forgotten the withdrawal entirely.
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')
    ).map((el) => el.textContent);
    expect(ids, `${name}: the withdrawn scope vanished from the list`).toContain(revokedScope);
    // …marked, not merely present. TWO independent marks, because either alone is weak: the
    // `data-revoked` hook on the Badge ROOT, and the strike on its LABEL.
    //
    // ⚠️ THE STRIKE CLASS IS ON THE LABEL, NOT THE ROOT — this arm asserted the root first and
    // went red on `'m_347db0ec mantine-Badge-root'`. `BlockScopeList` passes it through Mantine's
    // `classNames={{ label: … }}`, which is also where phase 1's `whitespace-normal break-all
    // text-start` live, so reading the root would have been a guard on the wrong box.
    const marked = document.querySelector<HTMLElement>('[data-revoked="true"]');
    expect(marked?.textContent, name).toBe(revokedScope);
    const markedLabel = marked?.querySelector<HTMLElement>('.mantine-Badge-label');
    expect(markedLabel, `${name}: the revoked badge has no Mantine label box`).toBeTruthy();
    expect(markedLabel!.className, name).toContain('line-through');
    // 🔴 AND PHASE 1'S THREE UTILITIES SURVIVE ON THAT SAME LABEL. `line-through` is APPENDED to
    // the truncation fix, not substituted for it, and a revoked row is the one row where a
    // careless rewrite of that template string would drop them — silently, since only an
    // over-long id at 408px shows the difference.
    for (const util of ['whitespace-normal', 'break-all', 'text-start']) {
      expect(
        markedLabel!.className,
        `${name}: phase-1 utility ${util} lost on a revoked row`
      ).toContain(util);
    }
    await expect.element(page.getByTestId('scope-revoked-mark')).toBeVisible();
    // 🔴 THE "WHEN" IS APP-LEVEL AND APPEARS EXACTLY ONCE. `scopesRevokedAt` is ONE timestamp per
    // (user, app) — `revoked_scopes` is a TEXT[] with nowhere to hold per-entry times — so a
    // per-row "revoked <when>" label would be wrong for every revoke but the latest. Its own
    // server docblock calls that "a LIE printed next to an individual scope row".
    const stamps = document.querySelectorAll('[data-testid="scope-revoked-at"]');
    expect(stamps, `${name}: expected exactly one app-level revoked-at line`).toHaveLength(1);
    expect(stamps[0].textContent, name).toContain('2026-09-14');
    // And no control on a row that is already gone.
    expect(revokableScopesOnScreen(), name).not.toContain(revokedScope);
  });

  test('🔴 the PRE-MIGRATION refusal renders a comprehensible message, not a crash or silence', async () => {
    // A real, expected runtime state: `revoked_scopes` is added by a HAND-APPLIED migration, so a
    // viewer can reach this control on an environment where the column does not exist. The server
    // answers 412 with `CONSENT_REVOKE_UNAVAILABLE_MESSAGE` and changes nothing.
    m.revokeError = {
      code: 'PRECONDITION_FAILED',
      message:
        'Withdrawing a permission is not available on this environment yet. Nothing was changed. Try again later.',
    };
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    const notice = page.getByTestId('scope-revoke-failure');
    await expect.element(notice).toBeVisible();
    // The SERVER's sentence, whole — not a client paraphrase, which would be a second copy of a
    // message the server already owns and carries on a 4xx specifically so it survives
    // `client-safe-error.ts`.
    await expect.element(notice).toHaveTextContent(m.revokeError.message);
    // 🔴 NOT the degraded flavour: nothing was recorded, so this must not read as "removed".
    expect(
      document.querySelector('[data-testid="scope-revoke-failure"]')?.getAttribute('data-degraded'),
      name
    ).toBe('false');
    // …and the list is NOT re-read, because the server states the row did not move.
    expect(
      m.invalidateSpy,
      `${name}: a 412 re-read a list the server says did not change`
    ).not.toHaveBeenCalled();
    // The row is still there and still offers the control — the viewer can retry once the
    // migration lands. A crash or a vanished control would both fail here.
    expect(revokableScopesOnScreen(), name).toEqual(
      expect.arrayContaining([GRANT.revokableScopes[0]])
    );
  });

  test('🔴 a 503 marker failure reads as REMOVED-but-lagging, and DOES re-read the list', async () => {
    // The outcome the brief for this phase did not mention and the one most easily got wrong: the
    // permission IS durably gone (Postgres was written first); only the in-flight-token marker did
    // not go out. Rendering this as "could not remove" would tell the viewer nothing was recorded
    // when the half governing every future mint was.
    m.revokeError = {
      code: 'SERVICE_UNAVAILABLE',
      message:
        'The permission was removed and will not be granted again, but an already-open app ' +
        'session may keep using it for a few more minutes. Reload the app to be sure.',
    };
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    const notice = page.getByTestId('scope-revoke-failure');
    await expect.element(notice).toBeVisible();
    await expect.element(notice).toHaveTextContent(m.revokeError.message);
    expect(
      document.querySelector('[data-testid="scope-revoke-failure"]')?.getAttribute('data-degraded'),
      `${name}: a 503 was rendered as a plain refusal`
    ).toBe('true');
    // The row DID change, so the list must be re-read — this is what separates the 503 from the
    // 412 above, and reading it off the same spy in both arms is what makes the pair a discriminator.
    expect(
      m.invalidateSpy,
      `${name}: a 503 left the list showing a permission that is gone`
    ).toHaveBeenCalled();
  });

  test('🔴 a 503 ALSO latches the row as revoked — no live control beside "Permission removed"', async () => {
    /**
     * 🔴 THE ONLY UNGUARDED LINE IN THIS FEATURE. The degraded arm's own
     * `setJustRevoked(...)` — `scopeRevoke.tsx`, inside `if (degraded)` — carried a 🔴 comment
     * stating exactly what it prevents and had NO test: measured, deleting that one line left
     * 625 unit + 91 component + 46 geometry tests green. It was the sole survivor, of 40 mutants,
     * that carried a claim.
     *
     * What it prevents: on a 503 Postgres was written and only the in-flight-token marker failed,
     * so the permission really is withdrawn and the viewer has just been told "Permission
     * removed". Leaving a live Remove button beside that toast is the same misreport the SUCCESS
     * path's latch exists to stop, in the arm that is already telling the viewer it is gone — and
     * pressing it again yields a confirm dialog promising to remove something already removed.
     *
     * 🔴 AND IT IS NOT SELF-HEALING, WHICH IS WHY THE LATCH RATHER THAN THE REFETCH HAS TO DO IT.
     * `listMyScopeGrants` reads the REPLICA while `revokeScopes` writes the PRIMARY, and
     * `src/utils/trpc.ts` sets `staleTime: Infinity` with `refetchOnWindowFocus: false` — so the
     * re-read this arm's sibling asserts can come back WITHOUT the revocation and nothing fetches
     * again. The fixture models exactly that: `m.grants` is never updated, so the only thing that
     * can suppress the control is local state.
     *
     * MUTATION THAT MUST KILL IT: delete the `setJustRevoked` call from the `if (degraded)` block.
     */
    m.revokeError = {
      code: 'SERVICE_UNAVAILABLE',
      message: 'removed, but an open session may keep using it briefly',
    };
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const scope = revokableScopesOnScreen()[0];
    expect(scope, 'the fixture has no revokable scope').toBeTruthy();
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    // Wait on the mark COUNT going 1 -> 2, not on `.first()` being visible: the fixture already
    // renders one revoked row (`collections:read:private`), so `.first()` would resolve off that
    // pre-existing mark and the await would observe nothing. Same trap the sibling arm records.
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="scope-revoked-mark"]').length,
        `${name}: a 503 left ${scope} unmarked — the viewer is told "Permission removed" while the ` +
          'row still says they have it'
      ).toBe(GRANT.revokedScopes.length + 1)
    );
    expect(
      revokableScopesOnScreen(),
      `${name}: a 503 left a live Remove control on ${scope} beside a "Permission removed" ` +
        'warning — pressing it again offers to remove a permission that is already gone'
    ).not.toContain(scope);
    // 🔴 THE OTHER ROW KEEPS ITS CONTROL. Without this the arm is satisfied by a 503 that
    // suppressed the whole feature, which is a different defect reported as this fix.
    for (const other of GRANT.revokableScopes.filter((s) => s !== scope)) {
      expect(revokableScopesOnScreen(), `${name}: ${other} lost its control too`).toContain(other);
    }
    // 🔴 THE SERVER PAYLOAD REALLY DID NOT MOVE, so the suppression is local and not a fixture
    // artefact. Compared against a LITERAL, not against `GRANT.revokedScopes` — `m.grants[0]` IS
    // `GRANT`, so comparing that field to itself cannot see an in-place mutation.
    expect(
      (m.grants[0] as { revokedScopes: string[] }).revokedScopes,
      'the fixture mutated — this arm no longer proves the latch did the work'
    ).toEqual(['collections:read:private']);
  });

  test('🔴 a SUSPENDED app can still be revoked from — there is no status gate in the UI either', async () => {
    // `blocks.revokeScopes` deliberately has no `status === 'approved'` gate: withdrawing consent
    // from a suspended or deprecated app is the case that matters most, and `listMyScopeGrants`
    // has no status filter, so such apps are exactly what a viewer sees listed. The fixture
    // carries `status: 'suspended'` so this is measured rather than inferred from the absence of
    // a field.
    expect(GRANT.status, 'the fixture stopped being a suspended app').toBe('suspended');
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    expect(revokableScopesOnScreen().sort(), name).toEqual([...GRANT.revokableScopes].sort());
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    expect(
      m.revokeCalls,
      `${name}: a suspended app's permission could not be withdrawn`
    ).toHaveLength(1);
  });

  test('the confirm copy states immediacy, re-prompting, and the budget it clears', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    // The SPEND scope's control specifically — revoking it also clears the stored daily limit, and
    // that consequence has to be in the dialog. Located by `data-scope` so the arm cannot silently
    // start reading a different row's button.
    const spendButton = revokeButtons().find((b) => b.dataset.scope === 'ai:write:budgeted');
    expect(spendButton, `${name}: no control for the spend scope`).toBeTruthy();
    spendButton!.click();
    const body = page.getByTestId('scope-revoke-confirm-body');
    await expect.element(body).toBeVisible();
    // "straight away", not "at the next token refresh" — phase 2 publishes a fail-closed Redis
    // marker that the middleware honours on ALREADY-MINTED tokens, so the stronger claim is the
    // true one.
    await expect.element(body).toHaveTextContent(/straight away/i);
    // Re-consent is an explicit PROMPT and accepting it DOES give the permission back. Stated
    // rather than hidden: leaving it out would let a viewer read the revoke as permanent.
    await expect.element(body).toHaveTextContent(/ask you for this permission again/i);
    await expect.element(body).toHaveTextContent(/does give the permission back/i);
    await expect.element(page.getByTestId('scope-revoke-confirm-budget-note')).toBeVisible();
    // 🔴 AND IT DOES NOT OVERSTATE. Revoke and uninstall are different operations on different
    // rows; a dialog implying otherwise repeats the false instruction the /apps/activity copy was
    // corrected for.
    await expect.element(body).toHaveTextContent(/does not uninstall the app/i);
  });

  test('🔴 A THIRD ERROR CODE is NOT reported as removed — the degraded split is exclusive', async () => {
    // 🔴 THE MUTANT THIS EXISTS FOR: `degraded = code === 'SERVICE_UNAVAILABLE'` widened to
    // `code !== 'PRECONDITION_FAILED'`. The 412 arm still reads `false`, the 503 arm still reads
    // `true`, so the split was pinned ONLY at its two named points and every other code fell into
    // the degraded branch unguarded. Live consequence: a 500 / 400 / 429 renders the orange
    // "The permission was removed and will not be granted again…" for a revoke that did NOT happen
    // — a consent surface asserting a withdrawal that does not exist, which is the one direction it
    // must never be wrong in. `BAD_REQUEST` is a real outcome here: the server refuses unknown and
    // consent-exempt scopes with exactly that code.
    m.revokeError = { code: 'BAD_REQUEST', message: 'cannot revoke apps:storage:read: …' };
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    await expect.element(page.getByTestId('scope-revoke-failure')).toBeVisible();
    expect(
      document.querySelector('[data-testid="scope-revoke-failure"]')?.getAttribute('data-degraded'),
      `${name}: a ${m.revokeError.code} was reported as a successful removal`
    ).toBe('false');
    // …and NO "Permission removed" notification of either kind. This is the half a `data-degraded`
    // read alone cannot see: the warning toast asserts removal in its TITLE.
    expect(
      m.notify.warning,
      `${name}: announced a removal that did not happen`
    ).not.toHaveBeenCalled();
    expect(m.notify.success, name).not.toHaveBeenCalled();
    // The row keeps its control so the viewer can retry or read the reason.
    expect(revokableScopesOnScreen(), name).toContain(GRANT.revokableScopes[0]);
  });

  test('🔴 the PENDING window: only THIS row spins, and it clears when the call settles', async () => {
    // 🔴 THREE MUTANTS SURVIVED THE WHOLE SUITE BEFORE THIS ARM, because nothing anywhere asserted
    // a spinner or a disabled state (`loading|disabled|aria-busy|pendingScope` matched zero times):
    //   · delete the `.finally(() => setPendingScope(null))` — the row's button spins FOREVER and
    //     every other Remove button on the app stays permanently disabled;
    //   · `loading={pendingScope === scope}` → `pendingScope !== null` — every button on the card
    //     spins at once, which is the failure the code comment names in prose and nothing checked;
    //   · `disabled={pendingScope !== null && pendingScope !== scope}` → `false`.
    m.gated = true;
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const [first, second] = revokeButtons();
    expect(
      second,
      'the fixture needs TWO revokable scopes to tell per-row from global'
    ).toBeTruthy();
    const clicked = first.dataset.scope;
    first.click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    // Mantine renders a Loader inside the button and sets `data-loading` on it.
    // 🔴 LOCATED BY `data-scope`, NOT `.first()`. Once a successful revoke suppresses its own row's
    // control, `.first()` resolves to a DIFFERENT button than the one that was clicked — so the
    // wait was on a state that deletes itself, a race round 2's own fix introduced. Found by the
    // round-3 test lane.
    const clickedBtn = () =>
      document.querySelector<HTMLElement>(
        `[data-testid="scope-revoke-button"][data-scope="${clicked}"]`
      );
    await vi.waitFor(() =>
      expect(clickedBtn()?.getAttribute('data-loading'), `${name}: ${clicked} never spun`).toBe(
        'true'
      )
    );
    const others = revokeButtons().filter((b) => b.dataset.scope !== clicked);
    for (const other of others) {
      // 🔴 THE OTHER ROWS MUST NOT SPIN — this is what separates per-row keying from a shared
      // boolean, and it is the assertion the prose comment stood in for.
      expect(
        other.getAttribute('data-loading'),
        `${name}: ${other.dataset.scope} is spinning too — the spinner is keyed on the wrong thing`
      ).not.toBe('true');
      // …but they ARE disabled, so a viewer cannot start a second revoke mid-flight.
      expect((other as HTMLButtonElement).disabled, `${name}: ${other.dataset.scope}`).toBe(true);
    }
    // Release the call and the pending state must clear — the `finally` mutant dies here.
    m.release!();
    // The clicked row's control is suppressed by `justRevoked` on success, so assert the spinner is
    // gone whether the button survived or not — both mean the pending state cleared.
    await vi.waitFor(() =>
      expect(
        clickedBtn()?.getAttribute('data-loading') ?? null,
        `${name}: ${clicked} is still spinning after the call settled`
      ).not.toBe('true')
    );
    for (const other of revokeButtons().filter((b) => b.dataset.scope !== clicked)) {
      expect(
        (other as HTMLButtonElement).disabled,
        `${name}: ${other.dataset.scope} is still disabled after the call settled`
      ).toBe(false);
    }
  });

  test('🔴 a just-revoked scope does NOT get its control back while the refetch is in flight', async () => {
    // 🔴 THE DEFECT THE ROUND-1 PERF FIX INTRODUCED, AND THIS ARM IS THE ONE THAT WOULD HAVE CAUGHT
    // IT. Clearing `pendingScope` in `.finally` correctly stopped waiting for the refetch — but the
    // server's grant list still omits the scope until that refetch lands, so the row went back to
    // `revokable` WITH AN ENABLED BUTTON. A viewer could press Remove again and get a confirm dialog
    // promising to remove a permission that was already gone. Found by the round-2 correctness lane,
    // which also pointed out the PENDING arm above *pinned* the bad behaviour by asserting the
    // button re-enables the instant the call settles.
    //
    // 🔴 THE INVALIDATE IS GATED, WHICH IS WHAT MAKES THE WINDOW EXIST. `justRevoked` now lives only
    // until the refetch settles (round 3 — a sticky entry overrode fresh server data and could paint
    // "Removed" over a re-granted LIVE permission). So with an immediately-resolving invalidate there
    // is no window at all, and this arm would be measuring the wrong thing. Holding it open is the
    // world under test; releasing it, at the bottom, is the second half of the claim.
    m.invalidateGated = true;
    const view = await render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const scope = revokableScopesOnScreen()[0];
    expect(scope, 'the fixture has no revokable scope').toBeTruthy();
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    // 🔴 WAIT ON THE MARK COUNT GOING 1 -> 2, NOT ON `.first()` BEING VISIBLE. The fixture already
    // renders ONE revoked row (`collections:read:private`), so `.first()` resolved immediately off
    // that pre-existing mark and the await was a no-op — it waited for nothing while its comment
    // claimed to observe the new local state. The following reads are synchronous, so the failure
    // direction was a false RED rather than a false green, but the sync point was fictional.
    // Found by the round-3 test lane.
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="scope-revoked-mark"]').length,
        `${name}: the just-revoked row never gained its "Removed" mark`
      ).toBe(GRANT.revokedScopes.length + 1)
    );
    // …and offers NO control for that scope, even though `listMyScopeGrants` still reports it as
    // revokable and not revoked.
    expect(
      revokableScopesOnScreen(),
      `${name}: offered a second Remove for ${scope} while the refetch was still in flight`
    ).not.toContain(scope);
    // The OTHER revokable scope keeps its control — this must suppress one row, not the feature.
    const others = GRANT.revokableScopes.filter((s) => s !== scope);
    for (const other of others) {
      expect(revokableScopesOnScreen(), `${name}: ${other} lost its control too`).toContain(other);
    }
    // 🔴 THE FIXTURE REALLY DID NOT CHANGE SERVER-SIDE, so the suppression came from local state.
    // ⚠️ Compared against a LITERAL, not against `GRANT.revokedScopes` — `m.grants[0] === GRANT`, so
    // the previous form compared an array to ITSELF and could not see an in-place
    // `GRANT.revokedScopes.push(...)`, which is exactly what its own message ("the fixture mutated")
    // names. Round-3 test lane.
    expect(
      (m.grants[0] as { revokedScopes: string[] }).revokedScopes,
      'the fixture mutated — this arm no longer tests the in-flight window'
    ).toEqual(['collections:read:private']);

    // 🔴 THE SECOND HALF, REWRITTEN BY ROUND 4: THE CLAIM EXPIRES ON **DATA**, NOT ON THE SETTLE.
    // Round 3 asserted that releasing the refetch dropped the local claim, on the belief that a
    // settled refetch carries the revocation. It does not — `listMyScopeGrants` reads the REPLICA
    // while the revoke writes the PRIMARY — so clearing on the settle flipped the row back to a live
    // control inside replication lag, permanently (`staleTime: Infinity`).
    //
    // So: releasing the refetch WITHOUT the server carrying the revocation must leave the row
    // "Removed" — that is the replication-lag case, and it is TRUE.
    m.releaseInvalidate!();
    await vi.waitFor(() => expect(m.invalidateSpy).toHaveBeenCalled());
    expect(
      revokableScopesOnScreen(),
      `${name}: the row re-offered a control for ${scope} after a refetch that did NOT carry the ` +
        'revocation — this is the replication-lag case, and the permission really is gone'
    ).not.toContain(scope);

    // …and once the server's payload DOES carry it, the entry is LATCHED OFF permanently: the row
    // still reads "Removed", now on the server's authority, with exactly ONE mark rather than a
    // duplicate.
    // 🔴 A FRESH OBJECT, NEVER AN IN-PLACE WRITE. `m.grants[0] === GRANT` — the module-level fixture —
    // so mutating `.revokedScopes` here edited the shared constant and leaked into twelve other
    // tests in this file (measured: 13 failures, most of them unrelated arms reading a fixture that
    // had silently grown a second revoked scope). This is the aliasing the round-3 lane warned about
    // in the assertion three lines up, reproduced by the fix for it.
    m.grants = [{ ...GRANT, revokedScopes: [...GRANT.revokedScopes, scope] }];
    await view.rerender(element());
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="scope-revoked-mark"]').length,
        `${name}: the server-confirmed revocation did not render a mark for ${scope}`
      ).toBe(GRANT.revokedScopes.length + 1)
    );
    expect(revokableScopesOnScreen(), name).not.toContain(scope);

    // 🔴 AND THE LATCH IS TERMINAL — THE ASSERTION ROUND 4's SHAPE COULD NOT MAKE. Feed a payload
    // that DROPS the scope again, which is exactly what a re-grant does (`grantScopes` passes
    // `clearRevocations: true`, and `revocationData` subtracts the incoming scopes from
    // `revoked_scopes`). A masking union would resurrect the local entry here and paint "Removed"
    // over a permission the server reports as live and withdrawable — round 3's defect at full
    // width, with no replication lag involved. Latched, the entry is gone and the server wins.
    m.grants = [{ ...GRANT, revokedScopes: [...GRANT.revokedScopes] }];
    await view.rerender(element());
    await vi.waitFor(() =>
      expect(
        revokableScopesOnScreen(),
        `${name}: a re-granted ${scope} still reads "Removed" — the local claim was masked, not ` +
          'retired, so a later payload resurrected it'
      ).toContain(scope)
    );
    expect(
      document.querySelectorAll('[data-testid="scope-revoked-mark"]').length,
      `${name}: the re-granted row kept its "Removed" marker`
    ).toBe(GRANT.revokedScopes.length);
  });

  test('a SUCCESS announces removal exactly once, and not as a warning', async () => {
    // The success notification path was entirely unasserted: deleting it, or swapping the degraded
    // warning for a success, survived every arm.
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const scope = revokableScopesOnScreen()[0];
    await page.getByTestId('scope-revoke-button').first().click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    await vi.waitFor(() => expect(m.notify.success).toHaveBeenCalledTimes(1));
    expect(
      m.notify.warning,
      `${name}: a clean success was announced as a warning`
    ).not.toHaveBeenCalled();
    // The message names the scope that was actually removed, not the app's whole set.
    expect(String(m.notify.success.mock.calls[0][0].message), name).toContain(scope);
    // …and no inline failure notice on a success.
    expect(document.querySelector('[data-testid="scope-revoke-failure"]'), name).toBeNull();
  });

  test('🔴 the failure notice LOOKS different for 503 vs a refusal — not just `data-degraded`', async () => {
    // 🔴 EVERY OTHER ARM READS `data-degraded`, WHICH IS A TEST HOOK THE VIEWER NEVER SEES. Mutating
    // `c={failure.degraded ? 'orange' : 'red'}` to `'red' : 'red'` therefore survived the whole
    // suite — asserting the shape of the harness rather than the shape of the thing. The colour is
    // the notice's ONLY viewer-visible discriminator between "removed, enforcement lagging" and
    // "refused, nothing changed". Reported by the round-2 test lane.
    /**
     * 🔴 THE INLINE `style.color` DECLARATION, NOT `getComputedStyle().color` — AND THE PROPERTY WAS
     * MEASURED OFF THE RENDERED ELEMENT RATHER THAN GUESSED. Two wrong reads came first, and the
     * positive control below caught both:
     *   1. `getComputedStyle(el).color` returned `rgb(0, 0, 0)` for BOTH arms. Mantine's `c` emits
     *      `color: var(--mantine-color-orange-text)`, and this harness loads no Mantine stylesheet, so
     *      the var is undefined and every `Text` computes to the same default black. That read could
     *      not fail for the right reason or the wrong one — it was blind.
     *   2. `el.style.getPropertyValue('--text-color')` returned `''` — Mantine sets `--text-fz` and
     *      `--text-lh` as custom properties but the colour as a plain `color` declaration.
     * Measured from the actual `outerHTML`:
     *   `style="--text-fz: …; --text-lh: …; color: var(--mantine-color-orange-text);"`
     * The inline declaration is what the component sets, and it is readable here because it is an
     * attribute rather than a resolved value.
     */
    const read = async (err: { code: string; message: string }) => {
      m.revokeError = err;
      render();
      await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
      await page.getByTestId('scope-revoke-button').first().click();
      await page.getByRole('button', { name: 'Remove permission' }).click();
      await expect.element(page.getByTestId('scope-revoke-failure')).toBeVisible();
      const el = document.querySelector<HTMLElement>('[data-testid="scope-revoke-failure"]')!;
      const colour = el.style.color;
      await cleanup();
      return colour;
    };
    const degradedColour = await read({ code: 'SERVICE_UNAVAILABLE', message: 'removed, lagging' });
    const refusedColour = await read({ code: 'PRECONDITION_FAILED', message: 'nothing changed' });
    // A POSITIVE CONTROL FIRST: both must carry a real declaration, or comparing them is comparing
    // two empty strings — the reassuring-zero shape in a style read, which is exactly what the
    // computed-colour version of this arm did.
    for (const c of [degradedColour, refusedColour]) {
      expect(
        c,
        `${name}: the notice set no inline \`color\` at all — Mantine may have changed how \`c\` is ` +
          'emitted (to a class, or to a build-time hex), and this arm is reading the wrong property'
      ).toMatch(/mantine-color/);
    }
    expect(
      degradedColour,
      `${name}: a 503 and a refusal render the SAME colour (${degradedColour}) — a viewer cannot ` +
        'tell "removed, enforcement lagging" from "refused, nothing changed"'
    ).not.toBe(refusedColour);
  });

  test('🔴 a malformed scopesRevokedAt renders NOTHING, not "Invalid Date"', async () => {
    // The NaN guard in `ScopeRevokedAtLine` was unreachable from any fixture — `GRANT` carries a real
    // `Date` and the pre-migration row strips the field — so deleting it left the suite green while a
    // wire value of the wrong shape would print "Invalid Date" on a consent surface. Reported by the
    // round-2 test lane.
    m.grants = [{ ...GRANT, scopesRevokedAt: 'not-a-date' }];
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-testid="scope-revoked-at"]'),
      `${name}: rendered a timestamp line from an unparseable value`
    ).toHaveLength(0);
    expect(document.body.textContent ?? '', name).not.toContain('Invalid Date');
    // …and the rest of the list is unaffected — a bad date must not take the controls with it.
    expect(revokableScopesOnScreen().sort(), name).toEqual([...GRANT.revokableScopes].sort());
  });

  test('🔴 the confirm copy discloses the OAuth sign-out, hedged', async () => {
    // For an app with an `OauthConsent` mirror, `blocks.revokeScopes` runs
    // `revokeOauthConsentForBlock`, which `deleteMany`s EVERY `Access`/`Refresh` key for that
    // client plus the whole consent row — so removing ONE permission can sign the app out
    // entirely. More removal than promised is the safe direction; a viewer being surprised by it
    // is not. Hedged because `ScopeGrantSurface` carries no field saying whether this app has a
    // mirror, so an unconditional claim would be false for the majority that have none.
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    await page.getByTestId('scope-revoke-button').first().click();
    await expect.element(page.getByTestId('scope-revoke-confirm-signout-note')).toBeVisible();
    await expect
      .element(page.getByTestId('scope-revoke-confirm-signout-note'))
      .toHaveTextContent(/signs you in with Civitai/i);
  });

  test('a NON-spend scope omits the budget sentence', async () => {
    // The control on the budget note. Without it, "the budget sentence is present" is satisfied by
    // a dialog that always shows it — including for a scope that clears no budget.
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const other = revokeButtons().find((b) => b.dataset.scope === 'posts:write:self');
    expect(other, `${name}: no control for posts:write:self`).toBeTruthy();
    other!.click();
    await expect.element(page.getByTestId('scope-revoke-confirm-body')).toBeVisible();
    expect(
      document.querySelector('[data-testid="scope-revoke-confirm-budget-note"]'),
      `${name}: the budget note rendered for a scope that clears no budget`
    ).toBeNull();
  });
});

/**
 * 🔴 THE CONTROL ON `EXEMPT_NOTE_MUST_MENTION` ITSELF. The fragments only discriminate if each
 * matches EXACTLY ONE of the four notes — a fragment two notes share cannot see a swap between
 * those two, and a fragment matching nothing would make its arm pass vacuously (a regex that never
 * matches is never asserted against, because the row loop would red on the `toBe` first and the
 * `toMatch` would look redundant). Both failure modes are silent, so they are measured here rather
 * than assumed, in the tier that needs no DOM.
 */
describe('the exempt-note fragments are a usable discriminator', () => {
  /**
   * 🔴 THE KEY SETS MUST BE TIED TOGETHER OR THIS GUARD SILENTLY BECOMES A 4-OF-N SAMPLE.
   * The fixture declares four of `FIXED_SCOPE_NOTES`' entries, so a swap between two of the
   * UNFRAGMENTED scopes is invisible here. That is an accepted limit — the fixture
   * cannot render every scope at a legible drawer width — but it must be an ACCEPTED one rather than
   * a drifting one: without this arm, adding an eighth note leaves the coverage ratio quietly worse
   * and nothing says so. The unfragmented set is therefore enumerated explicitly, and gaining a
   * member reds this test.
   */
  const KNOWINGLY_UNFRAGMENTED = [
    'apps:storage:write',
    'apps:storage:shared:read',
    'collections:write:self',
    // 🔴 THE EIGHTH NOTE THIS DOCBLOCK PREDICTED, LISTED RATHER THAN FRAGMENTED — DELIBERATELY.
    // `goods:read:self` gained a note when upstream's digital-goods rail made it consent-exempt.
    // The alternative is a fragment in `EXEMPT_NOTE_MUST_MENTION`, which the arm below then requires
    // to be IN the fixture (`GRANT.scopes`) — i.e. a fifth exempt row in a drawer the docblock above
    // says cannot render every scope at a legible width. Taking the accepted-limit route keeps this
    // guard honest about its own coverage (now 4 of 8) instead of quietly widening the fixture, and
    // this list is exactly the mechanism provided for that. A swap involving this note is therefore
    // invisible HERE — but not unguarded: the note map's keys are pinned against the server's exempt
    // set in `components/Apps/__tests__/scopeConsentRows.test.ts`.
    'goods:read:self',
    // Listed for the same reason as `goods:read:self`: fragmenting it would mean a fifth exempt row
    // in the fixture. Coverage here is now 4 of 9; the key set is still pinned against the server's
    // exempt list in `scopeConsentRows.test.ts`.
    'apps:store:items:write',
  ];

  test('🔴 every FIXED_SCOPE_NOTES key is either fragmented or knowingly listed as not', () => {
    const covered = new Set([...EXEMPT_IN_FIXTURE, ...KNOWINGLY_UNFRAGMENTED]);
    const uncovered = Object.keys(FIXED_SCOPE_NOTES).filter((s) => !covered.has(s));
    expect(
      uncovered,
      'these notes have no literal fragment binding them to their own row AND are not listed as ' +
        'knowingly unfragmented — a swap involving one of them would be invisible. Add a fragment ' +
        'to EXEMPT_NOTE_MUST_MENTION (and to the fixture), or list it in KNOWINGLY_UNFRAGMENTED.'
    ).toEqual([]);
    // …and the two sets must not overlap, or a scope could be "covered" by being in both.
    const overlap = KNOWINGLY_UNFRAGMENTED.filter((s) => s in EXEMPT_NOTE_MUST_MENTION);
    expect(overlap, 'a scope is both fragmented and listed as unfragmented').toEqual([]);
  });

  test('every fragmented scope is actually IN the fixture', () => {
    // 🔴 THE ARM THAT TIES THE MAP TO THE FIXTURE, because the one below cannot. The previous
    // version asserted `EXEMPT_IN_FIXTURE.length === 4` with the message "the fixture lost its
    // exempt scopes" — but `EXEMPT_IN_FIXTURE` is `Object.keys(EXEMPT_NOTE_MUST_MENTION)`, so that
    // was an assertion about the MAP and could not see `GRANT.scopes` at all. Adding a fifth exempt
    // scope to the fixture, or dropping one from it, left every by-name arm silently not covering it
    // while the "control" stayed green. Reported by the round-2 test lane.
    const notInFixture = EXEMPT_IN_FIXTURE.filter((s) => !GRANT.scopes.includes(s));
    expect(
      notInFixture,
      'these scopes have a fragment but are not in GRANT.scopes, so no row is ever rendered for ' +
        'them and their fragment asserts nothing'
    ).toEqual([]);
  });

  test('each fragment matches exactly ONE note — across the WHOLE map, not just the fixture', () => {
    // 🔴 THE POPULATION IS EVERY ENTRY IN `FIXED_SCOPE_NOTES`, NOT THE FOUR THE FIXTURE RENDERS.
    // Scoping it to the fixture is what let the `apps:storage:read` ↔ `apps:storage:write` swap
    // survive: `apps:storage:write` is not in the fixture, so `/private store/i` looked unique among
    // the four while being ambiguous across the whole map — and a swap only needs the OTHER entry to
    // exist, not to be rendered.
    const notes = Object.entries(FIXED_SCOPE_NOTES).map(([scope, text]) => ({ scope, text }));
    // NOT a count. This control's own message names the hazard it guards — an EMPTY map making the
    // loop below vacuous — and `toBeGreaterThan(0)` is that property exactly. A literal here was a
    // second, unowned copy of the exact-set tripwire and it broke on upstream's eighth exempt scope;
    // the set itself is pinned in `scopeConsentRows.test.ts` (keys === server exempt list) and in
    // `scope-grant.service.test.ts` (the exempt list itself).
    expect(
      notes.length,
      'FIXED_SCOPE_NOTES is empty — this control checks nothing'
    ).toBeGreaterThan(0);
    for (const [scope, re] of Object.entries(EXEMPT_NOTE_MUST_MENTION)) {
      const hits = notes.filter((n) => re.test(n.text)).map((n) => n.scope);
      expect(
        hits,
        `${String(re)} matches ${hits.length} of the ${
          notes.length
        } notes — it must match exactly ` +
          `one (${scope}) or it cannot tell a swapped note from a correct one`
      ).toEqual([scope]);
    }
  });
});

describe.each(SURFACES)('a PRE-PHASE-2 payload — $name', ({ name, render }) => {
  /**
   * 🔴 THE MIXED-VERSION WINDOW: a new client bundle querying a pod still on pre-phase-2 server
   * code gets grant rows with NO `revokableScopes`/`revokedScopes`/`scopesRevokedAt`/`grantedScopes`
   * — `listMyScopeGrants` gained all four in one change and emits them together, so
   * "some present, some absent" is not a state the current server can produce.
   *
   * 🔴 THIS ARM EXISTS BECAUSE THE FIRST IMPLEMENTATION COALESCED `revokableScopes ?? []`, WHICH
   * TURNED "the server did not say" INTO "can't be withdrawn". Every row became `fixed`, so a
   * genuinely withdrawable `ai:write:budgeted` rendered a sentence asserting it was granted by
   * platform policy and permanent — fail-closed for the ACTION and fail-OPEN for the COPY, i.e.
   * a false claim about the viewer's own consent on the consent surface. Found by the
   * correctness-review lane.
   */
  /**
   * The same app, with the three phase-2 fields STRIPPED — derived from `GRANT` by omission rather
   * than retyped, so it cannot drift from the fixture the rest of the file uses.
   */
  const preMigrationRow = () => {
    const {
      revokableScopes: _rs,
      revokedScopes: _rv,
      scopesRevokedAt: _at,
      grantedScopes: _gs,
      ...rest
    } = GRANT;
    return rest;
  };

  beforeEach(() => {
    m.grants = [preMigrationRow()];
  });

  test('🔴 renders the scopes but offers NO control and makes NO claim about them', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    // The rows are still disclosed — the viewer must still see what the app may use.
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')
    ).map((el) => el.textContent);
    expect(ids, name).toEqual(GRANT.scopes);
    // No control — the server did not say any of these is withdrawable.
    expect(revokeButtons(), `${name}: offered a control the server never authorised`).toHaveLength(
      0
    );
    // 🔴 AND NO "can't be withdrawn" NOTE EITHER. This is the half the `?? []` bug got wrong, and
    // it is the assertion that separates this arm from a plain "no button" check: withholding the
    // control is correct, ASSERTING permanence is not.
    expect(
      document.querySelectorAll('[data-testid="scope-fixed-note"]'),
      `${name}: claimed these permissions cannot be withdrawn, on a payload that never said so`
    ).toHaveLength(0);
    // No revoked marker and no timestamp line either — nothing was reported revoked.
    expect(document.querySelectorAll('[data-testid="scope-revoked-mark"]'), name).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="scope-revoked-at"]'), name).toHaveLength(0);
  });

  test('POSITIVE CONTROL: the SAME fixture WITH the field does offer controls', async () => {
    // Without this, the arm above passes for a component that renders no control under any
    // circumstances — the reassuring-zero shape. The phase-2 viewer-side fields are the only
    // difference. ⚠️ BOTH `revokableScopes` AND `grantedScopes` are restored, not just the first:
    // a control needs the app's consent-gated set AND the viewer's own grant, so restoring one
    // leaves every row `unknown` and this control would report the same zero as the arm it is
    // meant to discriminate against — a control that shares the step it is testing.
    m.grants = [
      {
        ...preMigrationRow(),
        revokableScopes: GRANT.revokableScopes,
        grantedScopes: GRANT.grantedScopes,
      },
    ];
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    expect(revokableScopesOnScreen().sort(), name).toEqual([...GRANT.revokableScopes].sort());
    // …and the exempt rows DO get their note once the server has spoken.
    expect(
      document.querySelectorAll('[data-testid="scope-fixed-note"]').length,
      name
    ).toBeGreaterThan(0);
  });
});

describe.each(SURFACES)('a DECLARED scope the viewer never granted — $name', ({ name, render }) => {
  /**
   * 🔴 THE DEFECT: A LIVE "REMOVE" BUTTON ON A PERMISSION NEVER GIVEN, WHOSE CLICK WAS DURABLE.
   * `revokableScopes` is computed server-side from the APP-SIDE set
   * (`consentGatedScopes(displayedScopes).filter(isKnownBlockScope)`) with no reference to the
   * viewer's grant, and `buildScopeConsentRows` took no granted set at all — so an app declaring
   * `posts:write:self` rendered a control for a viewer who never consented to it. The write was
   * not a harmless no-op: a `revoked_scopes` entry survives every later install, so it silently
   * made a FUTURE consent prompt's grant inert. `blocks.revokeScopes` now refuses that call, which
   * is what makes leaving the button a BROKEN control rather than just a confusing one.
   *
   * ⚠️ DERIVED FROM `GRANT` BY NARROWING `grantedScopes` ONLY — `revokableScopes` is left alone,
   * because the whole point is that the app's set and the viewer's set differ. Narrowing
   * `revokableScopes` instead is how the server-side variant of this fix would have been spelled,
   * and it is exactly what must NOT happen: the row would land in `fixed`, whose note asserts the
   * permission is granted by platform policy and bounded by server-side checks — false in both
   * halves for something nobody granted.
   */
  const UNGRANTED = 'posts:write:self';
  const STILL_GRANTED = 'ai:write:budgeted';

  beforeEach(() => {
    m.grants = [{ ...GRANT, grantedScopes: [STILL_GRANTED] }];
  });

  test('🔴 offers NO control for it, and still offers one for the granted sibling', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    // The row is still DISCLOSED — the app really does declare this permission.
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')
    ).map((el) => el.textContent);
    expect(ids, name).toContain(UNGRANTED);
    expect(
      revokableScopesOnScreen(),
      `${name}: offered a Remove control for ${UNGRANTED}, which the viewer never granted and ` +
        'which `blocks.revokeScopes` now refuses'
    ).not.toContain(UNGRANTED);
    // 🔴 THE POSITIVE CONTROL, IN THE SAME RENDER: the granted sibling keeps its control, so this
    // is not a component that has stopped offering controls at all.
    expect(revokableScopesOnScreen(), name).toEqual([STILL_GRANTED]);
  });

  test('🔴 says so, and does NOT use the "granted by platform policy" note', async () => {
    render();
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]'))
      .find((el) => el.textContent === UNGRANTED)
      ?.closest('[data-testid="block-scope-list"] > *');
    if (!row) throw new Error(`${name}: no row for ${UNGRANTED}`);
    // Silence is the rejected option: a row with no affordance and no explanation, next to rows
    // that have one, reads as an oversight rather than as a statement.
    const said = row.querySelector('[data-testid="scope-not-granted-note"]');
    expect(
      said,
      `${name}: rendered nothing at all for a declared-but-ungranted permission`
    ).not.toBeNull();
    // 🔴 AND IT IS NOT `fixed`'s SENTENCE.
    expect(row.querySelector('[data-testid="scope-fixed-note"]'), name).toBeNull();
    expect(said?.textContent ?? '', name).not.toContain('granted by platform policy');
    // 🔴 THE WHOLE NORMALISED STRING, NOT A WORD IN IT. ⚠️ This was `toMatch(/not granted/i)` — a
    // guard on two words, which any reword of the sentence walks straight through while still
    // reporting green. The artifact under test IS prose, so the assertion has to pin all of it; a
    // cosmetic reword then fails this arm, which is the price of a machine-readable claim. Compared
    // against the exported constant rather than a retyped literal so the two cannot drift, and
    // `SCOPE_NOT_GRANTED_NOTE`'s own docblock owns what the sentence is allowed to say.
    expect(
      (said?.textContent ?? '').trim(),
      `${name}: the not-granted sentence changed — re-read SCOPE_NOT_GRANTED_NOTE's docblock, ` +
        'especially the cross-reference its second clause depends on'
    ).toBe(SCOPE_NOT_GRANTED_NOTE);
  });
});

describe.each(SURFACES)(
  'a WITHHELD whole grant — the production shape — $name',
  ({ name, render }) => {
    /**
     * 🔴 THE 21-ROW SHAPE, RENDERED. Measured on the production primary 2026-09-28:
     * `revoked_scopes` and `revoked_scopes_at` do not exist in the `civitai` database, and 21 of 41
     * grant rows (51%, 10 users, 11 apps, all stamped 2026-09-17) carry `revoked_at` with
     * `granted_scopes` intact — `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql`, which
     * withholds the whole grant to force a fresh consent after `ai:write:budgeted`'s description
     * widened.
     *
     * The surface reports `grantedScopes: []` (`liveGrantedScopes` collapses on `revoked_at`),
     * `revokedScopes: []` (unreadable column) and the full gated set in `revokableScopes`. Before
     * `grantWithheldAt` every gated row therefore rendered "Not granted yet — the app will ask if
     * it needs this." for permissions those viewers DID grant.
     */
    const heldSince = '2026-09-17T18:12:00Z';
    const withheldGrant = () => ({
      ...GRANT,
      grantedScopes: [],
      revokedScopes: [],
      scopesRevokedAt: null,
      grantWithheldAt: heldSince,
    });

    beforeEach(() => {
      m.grants = [withheldGrant()];
    });

    test('🔴 says ON HOLD, not "Not granted yet", and offers no control', async () => {
      render();
      await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
      const notes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="scope-withheld-note"]')
      );
      expect(
        notes.length,
        `${name}: no row reported the hold — the viewer is told nothing about why their granted ` +
          'permissions are inactive'
      ).toBe(GRANT.revokableScopes.length);
      // 🔴 THE WHOLE NORMALISED STRING, not a word in it — a guard on words is walkable by
      // rewording, and this arc already shipped that mistake once this round.
      for (const note of notes) {
        expect((note.textContent ?? '').trim(), name).toBe(SCOPE_WITHHELD_NOTE);
      }
      // 🔴 AND THE FALSE SENTENCE IS GONE. This is the assertion the whole fix exists for.
      expect(
        document.body.textContent ?? '',
        `${name}: still claims the viewer never granted these — the defect this state removes`
      ).not.toContain(SCOPE_NOT_GRANTED_NOTE);
      expect(
        document.querySelectorAll('[data-testid="scope-not-granted-note"]'),
        name
      ).toHaveLength(0);
      // No control: `getGrantedScopes` returns empty for a non-null `revoked_at`, so the server
      // would refuse every one of them.
      expect(
        revokeButtons(),
        `${name}: offered a Remove control on a withheld grant, which the server refuses`
      ).toHaveLength(0);
      // …and no "Removed" badge, which would assert the VIEWER withdrew them.
      expect(
        document.querySelectorAll('[data-testid="scope-revoked-mark"]'),
        `${name}: claimed the viewer withdrew these — revoked_at has two writers and the client ` +
          'cannot tell which stamped it'
      ).toHaveLength(0);
    });

    test('🔴 carries the app-level hold line, DATED from revoked_at', async () => {
      render();
      await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
      const line = document.querySelector('[data-testid="scope-grant-withheld"]');
      expect(
        line,
        `${name}: no app-level explanation for why every row says "on hold"`
      ).not.toBeNull();
      expect(line?.textContent ?? '', name).toContain('2026-09-17');
      expect(line?.textContent ?? '', name).toContain('on hold');
      // The withdrawal line must NOT appear: `revoked_scopes_at` is null on this shape, so claiming
      // the viewer last removed something would be false.
      expect(
        document.querySelectorAll('[data-testid="scope-revoked-at"]'),
        `${name}: printed a "you last removed a permission" line for a hold they did not cause`
      ).toHaveLength(0);
    });

    test('🔴 the EXEMPT rows are untouched — exemption survives revoked_at', async () => {
      render();
      await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
      // `revoked_at` cannot withhold an exempt scope — the mint signs it on the exempt test alone —
      // so those rows keep their own notes and must NOT be relabelled "on hold".
      expect(
        document.querySelectorAll('[data-testid="scope-fixed-note"]').length,
        `${name}: the exempt rows lost their specific notes on a withheld grant`
      ).toBe(EXEMPT_IN_FIXTURE.length);
    });

    test('CONTROL: the SAME fixture without the flag renders the not-granted sentence', async () => {
      // Without this the arms above pass for a component that never renders `not-granted` at all —
      // the reassuring-zero shape. One field is the only difference.
      m.grants = [{ ...withheldGrant(), grantWithheldAt: null }];
      render();
      await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="scope-withheld-note"]'), name).toHaveLength(
        0
      );
      expect(document.querySelectorAll('[data-testid="scope-not-granted-note"]').length, name).toBe(
        GRANT.revokableScopes.length
      );
      expect(document.querySelectorAll('[data-testid="scope-grant-withheld"]'), name).toHaveLength(
        0
      );
    });
  }
);

/**
 * 🔴 THE SEAM — AND ITS SCOPE IS NARROWER THAN AN EARLIER DOCBLOCK HERE CLAIMED. That version said
 * *"a divergence in WHICH rows exist, WHICH have controls, or WHAT the notes say fails here even
 * when both surfaces pass every arm above."* THAT IS RETRACTED as an over-claim: it describes
 * coverage the construction cannot provide. Both `SURFACES` entries resolve the SAME `GRANT` from
 * the SAME mocked `listMyScopeGrants` and hand it to the SAME `ScopeConsentList`, so the ledger is a
 * pure function of (component, grant) on both sides and equality is close to tautological.
 *
 * 🔴 WHAT IT ACTUALLY CATCHES — three shapes, and the third is why it is worth keeping:
 *   1. one surface stops rendering the component at all (every other arm catches this too);
 *   2. one surface passes a DERIVED grant rather than the row — e.g. `{...grant, revokableScopes: []}`
 *      — which no per-surface arm would notice, since each would still be internally consistent;
 *   3. a future author RE-IMPLEMENTS the permissions list on one surface instead of mounting the
 *      shared component. That is the drift this whole change exists to prevent, and it is a
 *      STRUCTURAL tripwire, not a behavioural one.
 * "Both surfaces identically broken" remains fully satisfiable here. The behavioural claims live in
 * the `describe.each` arms above, which is where they belong. Corrected by the test-review lane.
 *
 * ⚠️ TWO THINGS THIS FILE DOES NOT COVER, named rather than left to be discovered: `emptyLabel` is
 * the one prop that genuinely differs per surface and is invisible with a 7-scope fixture (there is
 * no empty-grant arm), and `ScopeConsentList`'s `grant === undefined` path — live on the drawer
 * whenever `listMyScopeGrants` holds no row for the running app — is untested at this tier.
 */
test('🔴 the drawer and the activity page render ONE consent ledger from one fixture', async () => {
  const ledger = (): string[] => {
    const list = document.querySelector('[data-testid="scope-consent-list"]');
    if (!list) throw new Error('no scope-consent-list rendered');
    return Array.from(list.querySelectorAll<HTMLElement>('[data-testid="block-scope-id"]')).map(
      (id) => {
        const row = id.closest('[data-testid="block-scope-list"] > *');
        if (!row) throw new Error(`scope id ${id.textContent} is not inside a scope row`);
        const control = row.querySelector('[data-testid="scope-revoke-button"]');
        const note = row.querySelector('[data-testid="scope-fixed-note"]');
        const mark = row.querySelector('[data-testid="scope-revoked-mark"]');
        // `not-granted` is enumerated here rather than collapsing into `NOTHING`: the positive
        // control below asserts NO row is in the `NOTHING` state, and that assertion is only about
        // "no affordance and no explanation" if every state that DOES carry an explanation is
        // named. A not-granted row carries one.
        const notGranted = row.querySelector('[data-testid="scope-not-granted-note"]');
        const state = control
          ? 'revokable'
          : mark
          ? 'revoked'
          : note
          ? 'fixed'
          : notGranted
          ? 'not-granted'
          : 'NOTHING';
        // The note text is part of the pair, so a surface rendering the right STATE with the wrong
        // sentence is still a divergence.
        return `${id.textContent}|${state}|${(note ?? notGranted)?.textContent ?? ''}`;
      }
    );
  };

  SURFACES[0].render();
  await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
  const drawerLedger = ledger();
  await cleanup();

  SURFACES[1].render();
  await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
  const pageLedger = ledger();

  // A positive control BEFORE the comparison: two empty ledgers are equal, so without this the
  // whole arm is satisfied by a pair of surfaces that rendered nothing at all.
  expect(drawerLedger.length, 'the drawer rendered no scope rows — the comparison is vacuous').toBe(
    GRANT.scopes.length + GRANT.revokedScopes.length
  );
  // …and no row may be in the `NOTHING` state, which is the shape a ledger equality would happily
  // accept on both sides: every row has to have an affordance or an explanation.
  expect(drawerLedger.filter((r) => r.includes('|NOTHING|'))).toEqual([]);
  expect(pageLedger).toEqual(drawerLedger);
});
