import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — AppActivityPanel renders the enriched per-action audit detail:
 *  (a) a rich mutation row with id → name resolution (tip → @username · version),
 *  (b) a passive read row as a friendly scope label,
 *  (c) an old/null-detail row via the historical scope · endpoint · status path,
 *  (d) an unknown action code as a safe generic line.
 *
 * trpc is mocked wholesale — the two feed queries plus the batch name-resolution
 * lookups (modelVersion.getVersionsByIds + user.getById via useQueries). The
 * factory re-declares `setTrpcBatchingEnabled` because a wholesale vi.mock of
 * `~/utils/trpc` would otherwise break the static import a provider makes (#2946).
 */

const SCOPE_ITEMS = [
  {
    id: '1',
    createdAt: new Date('2026-07-16T12:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'social:tip:self',
    endpoint: 'tip',
    statusCode: 200,
    detail: { action: 'tip', amount: 500, toUserId: 7, outcome: 'ok' },
  },
  {
    id: '2',
    createdAt: new Date('2026-07-16T11:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'social:tip:self',
    endpoint: 'tip',
    statusCode: 200,
    // Rich row that also resolves a ModelVersion subject name (entityType/entityId).
    detail: {
      action: 'tip',
      amount: 5,
      toUserId: 8,
      entityType: 'ModelVersion',
      entityId: 99,
      outcome: 'ok',
    },
  },
  {
    id: '3',
    createdAt: new Date('2026-07-16T10:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'buzz:read:self',
    endpoint: 'me',
    statusCode: 200,
    detail: null, // passive read → friendly scope label
  },
  {
    id: '4',
    createdAt: new Date('2026-07-16T09:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'ai:write:budgeted',
    endpoint: 'workflow:submit:wf_9',
    statusCode: 200,
    detail: null, // pre-W13 mutation row → historical scope · endpoint fallback
  },
  {
    id: '5',
    createdAt: new Date('2026-07-16T08:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'apps:storage',
    endpoint: 'storage:x',
    statusCode: 200,
    detail: { action: 'mystery.future', outcome: 'ok' }, // unknown action code
  },
  {
    id: '6',
    createdAt: new Date('2026-07-16T07:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'social:tip:self',
    endpoint: 'tip',
    statusCode: 200,
    // Non-ModelVersion entity — the view names only ModelVersions, so this must
    // render a safe generic subject, never a crash or an empty "on ".
    detail: { action: 'tip', amount: 250, toUserId: 7, entityType: 'Image', entityId: 42, outcome: 'ok' },
  },
];

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    blocks: {
      listMyAppActivity: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
      listMyScopeInvocations: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: SCOPE_ITEMS, nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
    },
    modelVersion: {
      getVersionsByIds: {
        useQuery: () => ({ data: [{ id: 99, name: 'DreamXL' }] }),
      },
    },
    // userIds resolve in insertion order [7, 8] → alice, bob.
    useQueries: () => [{ data: { username: 'alice' } }, { data: { username: 'bob' } }],
  },
}));

import { AppActivityPanel } from './AppActivityPanel';

describe('AppActivityPanel — W13 action detail', () => {
  test('(a) rich tip row resolves @username', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText('Tipped 500 Buzz to @alice')).toBeInTheDocument();
  });

  test('(a) rich tip row resolves the ModelVersion subject name via getVersionsByIds', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText('Tipped 5 Buzz to @bob on DreamXL')).toBeInTheDocument();
  });

  test('(a) non-ModelVersion tip renders a safe generic subject (no crash, no empty "on ")', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect
      .element(page.getByText('Tipped 250 Buzz to @alice on this image'))
      .toBeInTheDocument();
  });

  test('(b) passive read row shows a friendly scope label', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect
      .element(page.getByText('Read your Buzz balance/history'))
      .toBeInTheDocument();
  });

  test('(c) null-detail mutation row falls back to the historical humanise path', async () => {
    renderWithProviders(<AppActivityPanel />);
    // scope ai:write:budgeted + workflow:submit endpoint → legacy "Generated an image"
    await expect.element(page.getByText('Generated an image')).toBeInTheDocument();
  });

  test('(d) unknown action code renders a safe generic line', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText('Performed an app action')).toBeInTheDocument();
  });
});
