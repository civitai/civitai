import { ModalsProvider } from '@mantine/modals';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import type * as NotificationsMod from '~/utils/notifications';
import type { ScopeConsentGrant } from './ScopeConsentList';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The grant list shared by the permissions drawer and /apps/activity, mounted directly so these
 * checks run in the blocking component suite. Interactions use DOM `.click()` and only await
 * states that stay put (an open dialog, a recorded call), so nothing here races a timer.
 */

const m = vi.hoisted(() => ({
  revokeCalls: [] as { appBlockId: string; scopes: string[] }[],
  success: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'blocks.revokeScopes': {
          useMutation: () => ({
            isPending: false,
            mutateAsync: (vars: { appBlockId: string; scopes: string[] }) => {
              m.revokeCalls.push(vars);
              return Promise.resolve({ ok: true });
            },
          }),
        },
      },
      {
        useUtils: () => ({
          blocks: { listMyScopeGrants: { invalidate: vi.fn(() => Promise.resolve()) } },
        }),
      }
    ),
  };
});

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showSuccessNotification: m.success,
  showWarningNotification: vi.fn(),
}));

const { ScopeConsentList } = await import('./ScopeConsentList');

const GRANT = {
  appBlockId: 'ab_list',
  name: 'Lighthouse',
  scopes: ['models:read:self', 'ai:write:budgeted', 'apps:storage:read', 'posts:write:self'],
  revokableScopes: ['ai:write:budgeted', 'posts:write:self'],
  grantedScopes: ['ai:write:budgeted', 'posts:write:self'],
  revokedScopes: ['collections:read:private'],
  scopesRevokedAt: new Date('2026-09-14T11:30:00Z'),
  grantWithheldAt: null,
};

/** Every row in the shared rule's order (sensitive by OAuth bit, then the rest), with its title. */
const EXPECTED: [scope: string, title: string][] = [
  ['posts:write:self', 'Publish posts to your profile'],
  ['ai:write:budgeted', 'Run AI work with your Buzz'],
  ['collections:read:private', 'See your private collections'],
  ['models:read:self', 'See the model it sits on'],
  ['apps:storage:read', 'Read its saved data for you'],
];
const titleOf = (scope: string) => EXPECTED.find(([s]) => s === scope)?.[1] ?? '\u0000';

const render = async (grant: ScopeConsentGrant = GRANT) => {
  renderWithProviders(
    <ModalsProvider>
      <ScopeConsentList grant={grant} emptyLabel="Nothing granted." />
    </ModalsProvider>
  );
  await expect.element(page.getByTestId('scope-consent-list')).toBeInTheDocument();
};
const list = () => document.querySelector<HTMLElement>('[data-testid="scope-consent-list"]')!;
const rowFor = (scope: string) =>
  list().querySelector<HTMLElement>(`[data-permission-row="${scope}"]`);
const revokeButtons = () =>
  Array.from(list().querySelectorAll<HTMLElement>('[data-testid="scope-revoke-button"]'));

beforeEach(() => {
  m.revokeCalls = [];
  m.success.mockClear();
});

describe('ScopeConsentList — plain-language rows', () => {
  test('every scope shows its plain title in the shared order, with no scope id', async () => {
    await render();
    const text = list().textContent ?? '';
    for (const [scope, title] of EXPECTED) {
      expect(text, `${scope}'s title`).toContain(title);
      expect(text, `the raw id ${scope} reached the viewer`).not.toContain(scope);
    }
    const rows = Array.from(list().querySelectorAll<HTMLElement>('[data-permission-row]')).map(
      (r) => r.dataset.permissionRow
    );
    expect(rows).toEqual(EXPECTED.map(([scope]) => scope));
  });

  test('each revokable scope has one Remove control in its own row, named by its title', async () => {
    await render();
    const buttons = revokeButtons();
    expect(buttons.map((b) => b.dataset.scope).sort()).toEqual([...GRANT.revokableScopes].sort());
    for (const button of buttons) {
      const scope = button.dataset.scope ?? '';
      expect(button.closest('[data-permission-row]'), scope).toBe(rowFor(scope));
      expect(button.getAttribute('aria-label')).toBe(`Remove “${titleOf(scope)}”`);
      expect(button.textContent).toBe('Remove');
    }
    // Two controls, two different accessible names.
    await expect
      .element(page.getByRole('button', { name: 'Remove “Run AI work with your Buzz”' }))
      .toBeInTheDocument();
  });

  test('a withdrawn permission keeps its row: marked "Removed", title struck, no control', async () => {
    await render();
    const row = rowFor('collections:read:private');
    expect(row?.dataset.revoked).toBe('true');
    expect(row?.querySelector('[data-testid="scope-revoked-mark"]')?.textContent).toBe('Removed');
    const title = row?.querySelector<HTMLElement>('[data-testid="permission-title"]');
    expect(title?.style.textDecoration).toContain('line-through');
    expect(row?.querySelector('[data-testid="scope-revoke-button"]')).toBeNull();
    // A live row beside it is not struck: the strike is keyed on the withdrawn row.
    const live = rowFor('ai:write:budgeted')?.querySelector<HTMLElement>(
      '[data-testid="permission-title"]'
    );
    expect(live?.style.textDecoration ?? '').not.toContain('line-through');
    expect(rowFor('ai:write:budgeted')?.dataset.revoked).toBeUndefined();
  });

  test('confirming Remove revokes exactly that scope, and every message uses its title', async () => {
    await render();
    const button = revokeButtons().find((b) => b.dataset.scope === 'ai:write:budgeted');
    expect(button).toBeTruthy();
    button!.click();

    const body = page.getByTestId('scope-revoke-confirm-body');
    await expect.element(body).toBeInTheDocument();
    await expect.element(body).toHaveTextContent('Run AI work with your Buzz');
    const dialog = document
      .querySelector('[data-testid="scope-revoke-confirm-body"]')
      ?.closest<HTMLElement>('[role="dialog"]');
    const dialogTitle = dialog?.querySelector('.mantine-Modal-title')?.textContent ?? '';
    expect(dialogTitle).toBe('Remove “Run AI work with your Buzz”?');
    expect(dialog?.textContent ?? '').not.toContain('ai:write:budgeted');

    document.querySelector<HTMLElement>('[data-testid="scope-revoke-confirm"]')!.click();
    await vi.waitFor(() => expect(m.revokeCalls).toHaveLength(1));
    expect(m.revokeCalls[0]).toEqual({ appBlockId: 'ab_list', scopes: ['ai:write:budgeted'] });

    await vi.waitFor(() => expect(m.success).toHaveBeenCalledTimes(1));
    const message = String(m.success.mock.calls[0][0].message);
    expect(message).toBe('Lighthouse no longer has “Run AI work with your Buzz”.');
  });
});

describe('ScopeConsentList — row markers', () => {
  // Non-sensitive scopes only: a sensitive row shows its warning icon whatever its state.
  // `user:read:self` is consent-gated; `models:read:self` is consent-exempt, so the app holds it.
  const markerGrant = (grantedScopes: string[]) => ({
    ...GRANT,
    scopes: ['user:read:self', 'models:read:self'],
    revokableScopes: ['user:read:self'],
    grantedScopes,
    revokedScopes: [],
    scopesRevokedAt: null,
  });
  /** The row's leading icon, read from the icon library's own class (present before this change). */
  const markerOf = (scope: string) => {
    const icon = rowFor(scope)?.querySelector(':scope > .mantine-ThemeIcon-root > svg');
    if (icon?.classList.contains('tabler-icon-check')) return 'check';
    if (icon?.classList.contains('tabler-icon-point-filled')) return 'neutral';
    return `unrecognised: ${icon?.getAttribute('class') ?? 'no icon'}`;
  };

  test('a permission the viewer has not granted gets the neutral marker, not the check', async () => {
    await render(markerGrant([]));
    // The fixture really reached the not-granted state, not a neighbouring one.
    expect(
      rowFor('user:read:self')?.querySelector('[data-testid="scope-not-granted-note"]')
    ).not.toBeNull();
    expect(markerOf('user:read:self')).toBe('neutral');
    // A permission the app holds keeps the check in the same list.
    expect(markerOf('models:read:self')).toBe('check');
  });

  test('the same permission, once granted, gets the check', async () => {
    await render(markerGrant(['user:read:self']));
    expect(
      rowFor('user:read:self')?.querySelector('[data-testid="scope-revoke-button"]')
    ).not.toBeNull();
    expect(markerOf('user:read:self')).toBe('check');
  });
});
