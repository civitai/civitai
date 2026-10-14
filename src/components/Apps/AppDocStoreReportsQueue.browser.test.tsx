import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/** The `/apps/review` Storage reports tab: rows, filters → query input, hide/unhide/delete with a reason. */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  rows: [] as Row[],
  listInputs: [] as Record<string, unknown>[],
  hideCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as Record<string, unknown>[],
  getInputs: [] as Record<string, unknown>[],
  invalidated: 0,
  fail: null as null | { message: string; data: { code: string } },
  errors: [] as string[],
  successes: [] as string[],
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showErrorNotification: ({ error }: { error: Error }) => m.errors.push(error.message),
  showSuccessNotification: ({ message }: { message: string }) => m.successes.push(message),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const mutation =
    (calls: () => Record<string, unknown>[]) =>
    (opts: {
      onSuccess?: (d: unknown, v: Record<string, unknown>) => unknown;
      onError?: (e: unknown) => unknown;
    }) => ({
      isPending: false,
      variables: undefined,
      mutate: (vars: Record<string, unknown>) => {
        calls().push(vars);
        if (m.fail) void opts.onError?.(m.fail);
        else void opts.onSuccess?.(vars, vars);
      },
    });
  // `makeTrpcProxy` resolves `router.procedure` paths only; this component's procedures sit
  // four levels deep (`apps.mod.docStore.<proc>`), so that one subtree is a local proxy seeded
  // with the measured procedures. Anything else under `apps` would be a fixture defect.
  const docStore: Record<string, unknown> = {
    listReported: {
      useInfiniteQuery: (input: Record<string, unknown>) => {
        m.listInputs.push(input);
        return {
          data: { pages: [{ items: m.rows, nextCursor: null }] },
          isLoading: false,
          isFetching: false,
          error: null,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          refetch: vi.fn(),
        };
      },
    },
    get: {
      useQuery: (input: Record<string, unknown>, opts: { enabled?: boolean }) => {
        if (opts?.enabled) m.getInputs.push(input);
        return {
          isLoading: false,
          error: null,
          data: opts?.enabled ? { data: { title: 'reported text zq77' } } : undefined,
        };
      },
    },
    setHidden: { useMutation: mutation(() => m.hideCalls) },
    delete: { useMutation: mutation(() => m.deleteCalls) },
  };
  const apps = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'mod'
          ? new Proxy(
              {},
              {
                get: (_t2, k2) =>
                  k2 === 'docStore'
                    ? new Proxy(docStore, {
                        get: (t, proc: string) => {
                          if (proc in t) return t[proc];
                          throw new Error(`unmocked procedure apps.mod.docStore.${proc}`);
                        },
                      })
                    : undefined,
              }
            )
          : undefined,
    }
  );
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {},
      {
        apps,
        useUtils: () => ({
          apps: {
            mod: {
              docStore: {
                listReported: {
                  invalidate: () => {
                    m.invalidated += 1;
                    return Promise.resolve();
                  },
                },
              },
            },
          },
        }),
      }
    ),
  };
});

const { AppDocStoreReportsQueue, DOC_STORE_ACTION_COPY } = await import(
  './AppDocStoreReportsQueue'
);

function row(over: Row = {}): Row {
  return {
    appBlockId: 'apb_ROW1',
    appSlug: 'pose-studio',
    collection: 'posts',
    key: 'k-17',
    reports: 4,
    lastReportedAt: new Date('2026-10-05T10:00:00Z'),
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-02T10:00:00Z'),
    author: { kind: 'user', userId: 31, username: 'author-a' },
    hidden: null,
    sizeBytes: 120,
    version: 3,
    revision: 41,
    ...over,
  };
}

beforeEach(() => {
  m.rows = [];
  m.listInputs = [];
  m.hideCalls = [];
  m.deleteCalls = [];
  m.getInputs = [];
  m.invalidated = 0;
  m.fail = null;
  m.errors = [];
  m.successes = [];
});

const TARGET = { appBlockId: 'apb_ROW1', collection: 'posts', key: 'k-17' };

describe('AppDocStoreReportsQueue', () => {
  test('a row shows the app, the document, the report count and its author for moderators', async () => {
    m.rows = [row()];
    renderWithProviders(<AppDocStoreReportsQueue />);
    const r = page.getByTestId('doc-store-report-row');
    await expect.element(r).toHaveTextContent('pose-studio');
    await expect.element(r).toHaveTextContent('posts/k-17');
    await expect.element(r).toHaveTextContent('4 reports');
    await expect.element(r).toHaveTextContent('author-a (#31)');
    await expect.element(r.getByRole('button', { name: 'Hide' })).toBeVisible();
    expect(page.getByTestId('doc-store-report-hidden').elements()).toHaveLength(0);
  });

  test('defaults the query to visible docs, most reported first', async () => {
    renderWithProviders(<AppDocStoreReportsQueue />);
    await expect.element(page.getByTestId('doc-store-reports-queue')).toBeVisible();
    expect(m.listInputs.at(-1)).toStrictEqual({ status: 'open', sort: 'reports', limit: 50 });
    await expect
      .element(page.getByText('No reported documents match these filters.'))
      .toBeVisible();
  });

  test('changing status and sort re-queries with them', async () => {
    renderWithProviders(<AppDocStoreReportsQueue />);
    await userEvent.click(page.getByTestId('doc-store-reports-status'));
    await userEvent.click(page.getByRole('option', { name: 'Hidden' }));
    await userEvent.click(page.getByTestId('doc-store-reports-sort'));
    await userEvent.click(page.getByRole('option', { name: 'Newest report' }));
    await expect
      .poll(() => m.listInputs.at(-1))
      .toStrictEqual({ status: 'hidden', sort: 'newest', limit: 50 });
  });

  test('hide needs a reason, then sends the target and the reason, and refreshes the queue', async () => {
    m.rows = [row()];
    renderWithProviders(<AppDocStoreReportsQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide' }));
    const confirm = page.getByTestId('doc-store-report-confirm');
    await expect.element(confirm).toBeDisabled();
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'spam link');
    await expect.element(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(m.hideCalls).toStrictEqual([
      { ...TARGET, revision: 41, reason: 'spam link', hidden: true },
    ]);
    expect(m.deleteCalls).toEqual([]);
    expect(m.successes).toEqual([DOC_STORE_ACTION_COPY.hide.done]);
    expect(m.invalidated).toBe(1);
  });

  test('a hidden row offers Unhide, and unhide sends hidden: false', async () => {
    m.rows = [row({ hidden: { at: new Date(), byUserId: 9, byUsername: 'mod-m' } })];
    renderWithProviders(<AppDocStoreReportsQueue />);
    await expect
      .element(page.getByTestId('doc-store-report-hidden'))
      .toHaveTextContent('Hidden by mod-m');
    await userEvent.click(page.getByRole('button', { name: 'Unhide' }));
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'reviewed, fine');
    await userEvent.click(page.getByTestId('doc-store-report-confirm'));
    expect(m.hideCalls).toStrictEqual([
      { ...TARGET, revision: 41, reason: 'reviewed, fine', hidden: false },
    ]);
    expect(m.successes).toEqual([DOC_STORE_ACTION_COPY.unhide.done]);
  });

  test('delete confirms with its own copy and calls delete, not setHidden', async () => {
    m.rows = [row()];
    renderWithProviders(<AppDocStoreReportsQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Delete' }));
    await expect.element(page.getByText(DOC_STORE_ACTION_COPY.delete.title)).toBeVisible();
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'illegal content');
    await userEvent.click(page.getByTestId('doc-store-report-confirm'));
    expect(m.deleteCalls).toStrictEqual([{ ...TARGET, revision: 41, reason: 'illegal content' }]);
    expect(m.hideCalls).toEqual([]);
  });

  test('a refused action is reported and the queue is refreshed', async () => {
    m.rows = [row()];
    m.fail = { message: 'document not found', data: { code: 'NOT_FOUND' } };
    renderWithProviders(<AppDocStoreReportsQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide' }));
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'spam link');
    await userEvent.click(page.getByTestId('doc-store-report-confirm'));
    expect(m.errors).toEqual(['document not found']);
    expect(m.invalidated).toBe(1);
  });

  test('View data loads the one document and shows it', async () => {
    m.rows = [row()];
    renderWithProviders(<AppDocStoreReportsQueue />);
    await userEvent.click(page.getByRole('button', { name: 'View data' }));
    await expect
      .element(page.getByTestId('doc-store-report-data'))
      .toHaveTextContent('reported text zq77');
    expect(m.getInputs.at(-1)).toStrictEqual(TARGET);
  });
});
