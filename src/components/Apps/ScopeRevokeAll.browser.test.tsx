import { ModalsProvider } from '@mantine/modals';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import type * as NotificationsMod from '~/utils/notifications';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * "Remove all" on the permissions list, kept apart from `ScopeRevoke.browser.test.tsx`.
 */
const GRANT = {
  appBlockId: 'ab_seam',
  slug: 'lighthouse',
  name: 'Lighthouse',
  origin: 'consent' as const,
  status: 'approved',
  surfaces: { subscriptionScopes: [], modelInstallCount: 0 },
  scopes: ['ai:write:budgeted', 'posts:write:self', 'apps:storage', 'models:read:self'],
  revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
  grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
  revokedScopes: [] as string[],
  scopesRevokedAt: null,
  buzzBudgetPerDay: null,
  spendScopeGranted: false,
};

const m = vi.hoisted(() => ({
  calls: [] as { appBlockId: string; scopes: string[] }[],
  firstError: null as null | { code: string; message: string },
  alwaysError: null as null | { code: string; message: string },
  freshGrants: [] as unknown[],
  fetchOpts: [] as unknown[],
  success: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('~/utils/notifications', async (importOriginal) => {
  m.success = vi.fn();
  return {
    ...(await importOriginal<typeof NotificationsMod>()),
    showSuccessNotification: m.success,
    showWarningNotification: vi.fn(),
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const reject = (e: { code: string; message: string }) =>
    Promise.reject({ data: { code: e.code }, message: e.message });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    setTrpcBatchingEnabled: vi.fn(),
    trpc: makeTrpcProxy(
      {
        'blocks.revokeScopes': {
          useMutation: () => ({
            isPending: false,
            mutateAsync: (vars: { appBlockId: string; scopes: string[] }) => {
              m.calls.push(vars);
              if (m.firstError) {
                const e = m.firstError;
                m.firstError = null;
                return reject(e);
              }
              if (m.alwaysError) return reject(m.alwaysError);
              return Promise.resolve({ ok: true });
            },
          }),
        },
      },
      {
        useUtils: () => ({
          blocks: {
            listMyScopeGrants: {
              invalidate: vi.fn(() => Promise.resolve()),
              fetch: (_input: unknown, opts?: { staleTime?: number }) => {
                m.fetchOpts.push(opts);
                return Promise.resolve(m.freshGrants);
              },
            },
          },
        }),
      }
    ),
  };
});

// eslint-disable-next-line import/first
import { ScopeConsentList } from '~/components/Apps/ScopeConsentList';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

function mount(grant = GRANT) {
  renderWithProviders(
    <ModalsProvider>
      <ScopeConsentList grant={grant} emptyLabel="none" />
    </ModalsProvider>
  );
}

beforeEach(() => {
  m.calls = [];
  m.firstError = null;
  m.alwaysError = null;
  m.freshGrants = [];
  m.fetchOpts = [];
  m.success.mockClear();
});

const sent = () => m.calls.map((c) => [...c.scopes].sort());

describe('Remove all', () => {
  test('🔴 one call carries exactly the removable scopes, never an exempt one', async () => {
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await expect.element(page.getByTestId('scope-revoke-all-kept-note')).toBeVisible();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect.poll(() => m.success.mock.calls.length).toBe(1);
    expect(sent()).toEqual([['ai:write:budgeted', 'posts:write:self']]);
    expect(m.calls[0].appBlockId).toBe('ab_seam');
  });

  test('cancelling the confirm sends nothing', async () => {
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-cancel').click();
    expect(m.calls).toHaveLength(0);
  });

  test('a single removable permission is left to its own button', async () => {
    mount({ ...GRANT, revokableScopes: ['posts:write:self'], grantedScopes: ['posts:write:self'] });
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="scope-revoke-all"]')).toBeNull();
  });

  test('🔴 a batch refused because another tab removed one is retried once, with a real refetch', async () => {
    m.firstError = { code: 'BAD_REQUEST', message: 'you do not hold that scope' };
    m.freshGrants = [{ ...GRANT, grantedScopes: ['posts:write:self'] }];
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect.poll(() => m.success.mock.calls.length).toBe(1);
    expect(sent()).toEqual([['ai:write:budgeted', 'posts:write:self'], ['posts:write:self']]);
    expect(m.fetchOpts).toEqual([{ staleTime: 0 }]);
  });

  test('🔴 the retry never adds a permission the viewer did not confirm', async () => {
    m.firstError = { code: 'BAD_REQUEST', message: 'you do not hold that scope' };
    m.freshGrants = [
      {
        ...GRANT,
        revokableScopes: [...GRANT.revokableScopes, 'collections:read:private'],
        grantedScopes: ['posts:write:self', 'collections:read:private'],
      },
    ];
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect.poll(() => m.calls.length).toBe(2);
    expect(m.calls[1].scopes).toEqual(['posts:write:self']);
  });

  test('a second refusal is shown and not retried again', async () => {
    m.alwaysError = { code: 'BAD_REQUEST', message: 'you do not hold that scope' };
    m.freshGrants = [{ ...GRANT, grantedScopes: ['posts:write:self'] }];
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect
      .element(page.getByTestId('scope-revoke-failure'))
      .toHaveTextContent('you do not hold that scope');
    expect(m.calls).toHaveLength(2);
    expect(m.success).not.toHaveBeenCalled();
  });

  test('a refusal that is not BAD_REQUEST is shown after one call, with no retry', async () => {
    m.alwaysError = { code: 'FORBIDDEN', message: 'not yours to remove' };
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect
      .element(page.getByTestId('scope-revoke-failure'))
      .toHaveTextContent('not yours to remove');
    expect(m.calls).toHaveLength(1);
    expect(m.fetchOpts).toHaveLength(0);
    expect(m.success).not.toHaveBeenCalled();
  });

  test('🔴 a 503 means they were removed: the rows show the removed marker', async () => {
    m.alwaysError = { code: 'SERVICE_UNAVAILABLE', message: 'removed, enforcement lags' };
    mount();
    await page.getByTestId('scope-revoke-all').click();
    await page.getByTestId('scope-revoke-all-confirm').click();
    await expect
      .element(page.getByTestId('scope-revoke-failure'))
      .toHaveAttribute('data-degraded', 'true');
    await expect
      .poll(() => document.querySelectorAll('[data-testid="scope-revoked-mark"]').length)
      .toBe(2);
    expect(m.calls).toHaveLength(1);
  });

  test('more than 32 removable permissions disable the button and say why', async () => {
    const many = Array.from({ length: 33 }, (_, i) => `ai:write:budgeted${i}`);
    mount({ ...GRANT, scopes: many, revokableScopes: many, grantedScopes: many });
    await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="scope-revoke-all"]');
    expect(button?.disabled).toBe(true);
    await expect.element(page.getByText('Too many to remove at once')).toBeVisible();
  });
});
