import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative imports.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';

/**
 * The order of the /hubs landing for a viewer who already has hubs. The page is a long scroll on a
 * phone, so what matters is which section is reached first, and that is a fact about DOM order.
 */

const mocks = vi.hoisted(() => ({
  user: null as null | { id: number },
  query: { data: [] as unknown[], isLoading: false },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({ 'userHub.getAll': { useQuery: () => mocks.query } }),
}));

const { HubsLanding } = await import('./HubsLanding');

const hub = (id: number, name: string) => ({
  id,
  key: `k${id}`,
  name,
  availability: 'Private',
  description: null,
  sourceCounts: { user: 1, model: 0, tag: 0 },
});

/** Where a heading sits in the document, so two of them can be compared. */
const headingIndex = (name: string) => {
  const all = [...document.querySelectorAll('h3')];
  return all.findIndex((h) => h.textContent === name);
};

beforeEach(() => {
  mocks.user = null;
  mocks.query = { data: [], isLoading: false };
});

describe('/hubs landing order', () => {
  test('🔴 a viewer with hubs sees them before the starting points', async () => {
    mocks.user = { id: 1 };
    mocks.query = { data: [hub(1, 'Alpha hub'), hub(2, 'Bravo hub')], isLoading: false };
    renderWithProviders(<HubsLanding />);
    await expect.element(page.getByText('Alpha hub')).toBeInTheDocument();

    const mine = headingIndex('My hubs');
    const starters = headingIndex('Start another hub');
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(starters).toBeGreaterThanOrEqual(0);
    expect(mine).toBeLessThan(starters);
    // The old heading is for a viewer with nothing yet.
    expect(headingIndex('Start with one of these')).toBe(-1);
  });

  test('a signed-in viewer waiting on the list already sees My hubs first', async () => {
    mocks.user = { id: 1 };
    mocks.query = { data: [], isLoading: true };
    renderWithProviders(<HubsLanding />);
    await expect.element(page.getByText('My hubs')).toBeInTheDocument();

    expect(headingIndex('My hubs')).toBeLessThan(headingIndex('Start with one of these'));
  });

  test('a viewer with no hubs keeps the starting points first', async () => {
    mocks.user = { id: 1 };
    renderWithProviders(<HubsLanding />);
    await expect.element(page.getByText('Start with one of these')).toBeInTheDocument();

    expect(headingIndex('Start with one of these')).toBeLessThan(headingIndex('My hubs'));
  });

  test('a signed-out viewer sees only the starting points', async () => {
    renderWithProviders(<HubsLanding />);
    await expect.element(page.getByText('Start with one of these')).toBeInTheDocument();

    expect(headingIndex('My hubs')).toBe(-1);
  });
});
