import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'blocks.getInstallConfig': {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
    }),
  };
});

const { AppSettingsModal } = await import('./AppSettingsModal');

const UNKNOWN = 'zz:not-a-real:scope';

function block(scopes: string[]): AvailableBlock {
  return {
    id: 'app-settings-1',
    blockId: 'settings-block',
    appId: 'app-settings-1',
    appName: 'Settings App',
    manifest: { name: 'Settings App', scopes } as AvailableBlock['manifest'],
    installCount: 0,
    category: null,
    scopesSummary: [],
    externalUrl: null,
  };
}

/**
 * The install/manage modal is opened from the /apps marketplace by any signed-in user, so its
 * permission list reads like the store listing: plain titles, no raw scope ids, grouped and
 * ordered by the shared rule. Input order differs from the grouped order at every position.
 */
describe('AppSettingsModal — permission list', () => {
  const INPUT = [
    'models:read:self',
    UNKNOWN,
    'apps:storage:shared:write',
    'user:read:self',
    'ai:write:budgeted',
  ];
  const EXPECTED: [scope: string, title: string][] = [
    ['ai:write:budgeted', 'Run AI work with your Buzz'],
    ['apps:storage:shared:write', 'Post to community data'],
    ['user:read:self', 'See your username and account status'],
    ['models:read:self', 'See the model it sits on'],
    [UNKNOWN, 'Zz not a real scope'],
  ];

  test('shows plain titles in the shared order, with no scope id and none dropped', async () => {
    renderWithProviders(
      <AppSettingsModal block={block(INPUT)} existingByScope={{}} onClose={vi.fn()} />
    );
    await expect.element(page.getByText('This app can')).toBeInTheDocument();
    const text = document.querySelector('[role="dialog"]')?.textContent ?? '';
    for (const [scope, title] of EXPECTED) {
      expect(text, `${scope}'s title`).toContain(title);
      expect(text, `the raw id ${scope} reached the user`).not.toContain(scope);
    }
    expect(text).not.toContain('(no description)');
    const shown = EXPECTED.map(([s, t]) => [s, text.indexOf(t)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([s]) => s);
    expect(shown).toEqual(EXPECTED.map(([s]) => s));
  });
});
