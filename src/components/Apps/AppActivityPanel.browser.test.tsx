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
    // LEGACY row shape — the per-workflow endpoint the writers emitted before it
    // was bounded to a template. No backfill was run, so rows like this are still
    // in the table: their Detail cell must keep resolving from the endpoint tail.
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
  // ── Bounded-endpoint rows (the shape the writers emit today). The endpoint is
  // the aggregation TEMPLATE, so the Detail column must come off `detail`.
  {
    id: '7',
    createdAt: new Date('2026-07-16T06:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'ai:write:budgeted',
    endpoint: 'workflow:submit',
    statusCode: 200,
    detail: { action: 'workflow.submit', amount: -120, outcome: 'ok', workflowId: 'wf_new' },
  },
  {
    id: '8',
    createdAt: new Date('2026-07-16T05:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'ai:write:budgeted',
    // Same TEMPLATE as row 7 — proves two different submits aggregate to one
    // endpoint value while keeping distinct per-row detail. No id yet on this
    // one (the old `workflow:submit:pending` case).
    endpoint: 'workflow:submit',
    statusCode: 200,
    detail: { action: 'workflow.submit', amount: -7, outcome: 'ok' },
  },
  {
    id: '9',
    createdAt: new Date('2026-07-16T04:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'apps:storage',
    endpoint: 'storage:set',
    statusCode: 200,
    detail: { action: 'storage.set', key: 'prefs', outcome: 'ok' },
  },
  {
    id: '10',
    createdAt: new Date('2026-07-16T03:00:00Z'),
    appBlockId: 'apb_1',
    appName: 'Tip App',
    appSlug: 'tip-app',
    blockInstanceId: 'bki_1',
    scope: 'apps:storage',
    // LEGACY per-key storage endpoint + no detail — historical rows must keep
    // rendering both the Action label and the key.
    endpoint: 'storage:delete:legacy_key',
    statusCode: 200,
    detail: null,
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
    // scope ai:write:budgeted + workflow:submit endpoint → legacy "Generated an image".
    // `exact` because getByText is substring-matching by default and the rich
    // workflow rows below render "Generated an image (spent N Buzz)".
    await expect
      .element(page.getByText('Generated an image', { exact: true }))
      .toBeInTheDocument();
  });

  test('(d) unknown action code renders a safe generic line', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText('Performed an app action')).toBeInTheDocument();
  });
});

/**
 * Bounded `endpoint` + per-row `detail`. `block_scope_invocations.endpoint` is
 * the GROUP BY key of the `topEndpoints` rollup, so the writers now emit a
 * TEMPLATE (`workflow:submit`, `storage:set`, `storage:delete`) instead of
 * embedding the workflow id / storage key. The Detail column used to parse that
 * id back OUT of the endpoint string — these tests are the discriminating ones
 * for that regression: without reading `detail`, every templated row degrades to
 * "(no workflow id)" / a bare "storage:set", and no server-side unit test can
 * see it.
 */
describe('AppActivityPanel — Detail column off a BOUNDED endpoint', () => {
  test('templated workflow row renders the workflow id from detail.workflowId', async () => {
    renderWithProviders(<AppActivityPanel />);
    // Row 7: endpoint 'workflow:submit' (no id in it) + detail.workflowId.
    await expect.element(page.getByText('workflow wf_new')).toBeInTheDocument();
  });

  test('two submits share ONE endpoint value while keeping distinct detail (aggregation + per-row payload)', async () => {
    renderWithProviders(<AppActivityPanel />);
    // Rows 7 and 8 both carry endpoint 'workflow:submit' — that constant must
    // never leak into the Detail cell, and each row keeps its own Action
    // sentence off its own detail.
    await expect
      .element(page.getByText('Generated an image (spent 120 Buzz)'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Generated an image (spent 7 Buzz)'))
      .toBeInTheDocument();
    expect(page.getByText('workflow:submit', { exact: true }).elements()).toHaveLength(0);
  });

  test('templated workflow row with NO id renders the explicit "(no workflow id)"', async () => {
    renderWithProviders(<AppActivityPanel />);
    await expect.element(page.getByText('(no workflow id)')).toBeInTheDocument();
  });

  test('templated storage row renders the key from detail.key', async () => {
    renderWithProviders(<AppActivityPanel />);
    // Row 9: endpoint 'storage:set' + detail.key — the bare template must not show.
    await expect.element(page.getByText('key "prefs"')).toBeInTheDocument();
    expect(page.getByText('storage:set', { exact: true }).elements()).toHaveLength(0);
  });

  test('LEGACY per-id rows (no backfill) still resolve from the endpoint tail', async () => {
    renderWithProviders(<AppActivityPanel />);
    // Row 4: 'workflow:submit:wf_9', detail null. Row 10: 'storage:delete:legacy_key'.
    await expect.element(page.getByText('workflow wf_9')).toBeInTheDocument();
    await expect.element(page.getByText('key "legacy_key"')).toBeInTheDocument();
    await expect.element(page.getByText('Deleted app-local storage')).toBeInTheDocument();
  });
});
