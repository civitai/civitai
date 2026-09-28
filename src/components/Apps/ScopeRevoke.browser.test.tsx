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
 *     → four of the seven `CONSENT_EXEMPT_SCOPES`. Present in `scopes` (an app really does declare
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
  revokedScopes: ['collections:read:private'],
  scopesRevokedAt: new Date('2026-09-14T11:30:00Z'),
  buzzBudgetPerDay: null,
  spendScopeGranted: false,
};

/** The four exempt members this fixture declares — the arm asserts every one BY NAME. */
const EXEMPT_IN_FIXTURE = [
  'apps:storage:read',
  'apps:storage:shared:write',
  'collections:read:self',
  'models:read:self',
];

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
    ...(await importOriginal<typeof import('~/utils/notifications')>()),
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
  const invalidateSpy = vi.fn(async () => {});
  m.invalidateSpy = invalidateSpy;
  const grantsQuery = () => ({ data: m.grants, isLoading: false, isError: false });
  /**
   * 🔴 `mutateAsync`, NOT `mutate` + OPTION CALLBACKS — AND THE SHAPE IS THE POINT.
   * `useScopeRevoke` deliberately passes NO `onSuccess`/`onError`/`onSettled` options and handles
   * the outcome in its own promise chain, because the confirm dialog renders into a global provider
   * and can outlive the component: an unsubscribed observer would drop every callback and leave a
   * changed permission unreported. So this mock resolves or REJECTS a promise, exactly as
   * react-query's `mutateAsync` does, and asserts nothing about options. A mock that kept calling
   * option callbacks would keep passing if the hook regressed to them.
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
import { FIXED_SCOPE_NOTES } from '~/components/Apps/scopeConsentRows';
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
const SURFACES = [
  {
    name: 'drawer',
    render: () =>
      renderWithProviders(
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
    render: () =>
      renderWithProviders(
        <ModalsProvider>
          <ScopeGrantsPanel />
        </ModalsProvider>
      ),
  },
] as const;

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
  m.invalidateSpy?.mockClear();
  m.notify?.success.mockClear();
  m.notify?.warning.mockClear();
});

describe.each(SURFACES)('per-scope revoke — $name', ({ name, render }) => {
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
      expect(offered, `${name}: a revoke control was offered for the exempt scope ${scope}`).not.toContain(
        scope
      );
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
      expect(
        note!.textContent,
        `${name}: ${scope}'s row carries the WRONG note — a note describing a different scope's ` +
          'server-side gate is the mis-description this map exists to prevent'
      ).toBe(FIXED_SCOPE_NOTES[scope]);
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
      scopes: [revokableScopesOnScreen()[0] ?? '<none>'],
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
      expect(markedLabel!.className, `${name}: phase-1 utility ${util} lost on a revoked row`).toContain(
        util
      );
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
    expect(m.invalidateSpy, `${name}: a 412 re-read a list the server says did not change`).not
      .toHaveBeenCalled();
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
    expect(m.invalidateSpy, `${name}: a 503 left the list showing a permission that is gone`)
      .toHaveBeenCalled();
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
    expect(m.revokeCalls, `${name}: a suspended app's permission could not be withdrawn`).toHaveLength(
      1
    );
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
    expect(m.notify.warning, `${name}: announced a removal that did not happen`).not.toHaveBeenCalled();
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
    expect(second, 'the fixture needs TWO revokable scopes to tell per-row from global').toBeTruthy();
    const clicked = first.dataset.scope;
    first.click();
    await page.getByRole('button', { name: 'Remove permission' }).click();
    // Mantine renders a Loader inside the button and sets `data-loading` on it.
    await expect
      .element(page.getByTestId('scope-revoke-button').first())
      .toHaveAttribute('data-loading', 'true');
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
    await expect
      .element(page.getByTestId('scope-revoke-button').first())
      .not.toHaveAttribute('data-loading', 'true');
    for (const other of revokeButtons().filter((b) => b.dataset.scope !== clicked)) {
      expect(
        (other as HTMLButtonElement).disabled,
        `${name}: ${other.dataset.scope} is still disabled after the call settled`
      ).toBe(false);
    }
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
    expect(m.notify.warning, `${name}: a clean success was announced as a warning`).not.toHaveBeenCalled();
    // The message names the scope that was actually removed, not the app's whole set.
    expect(String(m.notify.success.mock.calls[0][0].message), name).toContain(scope);
    // …and no inline failure notice on a success.
    expect(document.querySelector('[data-testid="scope-revoke-failure"]'), name).toBeNull();
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

describe.each(SURFACES)('a PRE-PHASE-2 payload — $name', ({ name, render }) => {
  /**
   * 🔴 THE MIXED-VERSION WINDOW: a new client bundle querying a pod still on pre-phase-2 server
   * code gets grant rows with NO `revokableScopes`/`revokedScopes`/`scopesRevokedAt`.
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
    // circumstances — the reassuring-zero shape. One field is the only difference.
    m.grants = [{ ...preMigrationRow(), revokableScopes: GRANT.revokableScopes }];
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
        const state = control ? 'revokable' : mark ? 'revoked' : note ? 'fixed' : 'NOTHING';
        // The note text is part of the pair, so a surface rendering the right STATE with the wrong
        // sentence is still a divergence.
        return `${id.textContent}|${state}|${note?.textContent ?? ''}`;
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
