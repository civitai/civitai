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
}));

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
  const revokeMutation = (opts?: {
    onSuccess?: (d: unknown, v: { appBlockId: string; scopes: string[] }) => unknown;
    onError?: (e: unknown, v: { appBlockId: string; scopes: string[] }) => unknown;
    onSettled?: () => unknown;
  }) => ({
    isPending: false,
    mutate: (vars: { appBlockId: string; scopes: string[] }) => {
      m.revokeCalls.push(vars);
      const done = m.revokeError
        ? opts?.onError?.(
            { data: { code: m.revokeError.code }, message: m.revokeError.message },
            vars
          )
        : opts?.onSuccess?.({ ok: true }, vars);
      void Promise.resolve(done).then(() => opts?.onSettled?.());
    },
  });
  const inert = {
    data: undefined,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: {
      useUtils: () => ({ blocks: { listMyScopeGrants: { invalidate: invalidateSpy } } }),
      useQueries: () => [],
      blocks: {
        listMyScopeGrants: { useQuery: grantsQuery },
        revokeScopes: { useMutation: revokeMutation },
        // The activity panel the drawer also renders. Inert: this file measures the permissions
        // half, and the activity half has its own seam test.
        listMyAppActivity: { useInfiniteQuery: () => ({ ...inert, data: { pages: [] } }) },
        listMyScopeInvocations: { useInfiniteQuery: () => ({ ...inert, data: { pages: [] } }) },
        listMySubscriptions: { useQuery: () => inert },
        grantScopes: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      },
      modelVersion: { getVersionsByIds: { useQuery: () => inert } },
    },
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
  m.invalidateSpy?.mockClear();
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
    // …and each one explains itself rather than sitting there silent or greyed out. The note text
    // is derived from its owner, not retyped: a copied sentence keeps passing after the map changes.
    const notes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="scope-fixed-note"]')
    ).map((el) => el.textContent);
    for (const scope of EXEMPT_IN_FIXTURE) {
      expect(notes, `${name}: no note rendered for ${scope}`).toContain(FIXED_SCOPE_NOTES[scope]);
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
 * 🔴 THE SEAM. Every arm above runs on both surfaces, which proves each one SEPARATELY correct —
 * and "verified in isolation" is exactly how a seam defect survives. This arm renders both mounts
 * from the one fixture in one test and compares the consent DOM they produce, so a divergence in
 * WHICH rows exist, WHICH have controls, or WHAT the notes say fails here even when both surfaces
 * pass every arm above.
 *
 * It pins a RELATIONSHIP rather than a component: the ledger below is an ordered list of
 * (scope, state) pairs, so it fails when the set GROWS or SHRINKS on either side, not merely when
 * a value changes.
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
