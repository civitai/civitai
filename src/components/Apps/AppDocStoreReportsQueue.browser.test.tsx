import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';

/**
 * The `/apps/review` Storage reports tab against a REAL query cache configured like the
 * app's (`staleTime: Infinity`). The component's own query and mutation options reach
 * react-query untouched; only the network calls are replaced (`m.fetch*`, `m.send*`). That is
 * what lets these tests see a review dialog serving a cached older document.
 */

type Row = Record<string, unknown>;
type Doc = Record<string, unknown>;
const m = vi.hoisted(() => ({
  listCalls: [] as Record<string, unknown>[],
  listResult: { items: [] as Row[], truncated: false, failedApps: 0 },
  fetchGet: null as unknown as (input: Record<string, unknown>) => Promise<Doc>,
  getCalls: 0,
  sent: [] as [string, Record<string, unknown>][],
  fail: null as null | Error,
  errors: [] as string[],
  successes: [] as string[],
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showErrorNotification: ({ error }: { error: Error }) => m.errors.push(error.message),
  showSuccessNotification: ({ message }: { message: string }) => m.successes.push(message),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useQuery, useMutation, useQueryClient } = await import('@tanstack/react-query');
  const LIST = ['docStore', 'listReported'];
  const GET = ['docStore', 'get'];
  const mutation = (name: string) => ({
    useMutation: (options: Record<string, unknown>) =>
      useMutation({
        mutationFn: async (input: Record<string, unknown>) => {
          m.sent.push([name, input]);
          if (m.fail) throw m.fail;
          return {};
        },
        ...options,
      }),
  });
  // `makeTrpcProxy` resolves `router.procedure` paths only; these procedures sit four levels
  // deep (`apps.mod.docStore.<proc>`), so that subtree is a local object seeded with exactly
  // the procedures the component calls. Anything else under it is a fixture defect.
  const docStore: Record<string, unknown> = {
    listReported: {
      useQuery: (input: Record<string, unknown>, options: Record<string, unknown>) =>
        useQuery({
          queryKey: [...LIST, input],
          queryFn: async () => {
            m.listCalls.push(input);
            return m.listResult;
          },
          ...options,
        }),
    },
    get: {
      useQuery: (input: Record<string, unknown>, options: Record<string, unknown>) =>
        useQuery({
          queryKey: [...GET, input],
          queryFn: () => {
            m.getCalls += 1;
            return m.fetchGet(input);
          },
          ...options,
        }),
    },
    setHidden: mutation('setHidden'),
    dismissReports: mutation('dismissReports'),
    delete: mutation('delete'),
  };
  const strict = (t: Record<string, unknown>, where: string) =>
    new Proxy(t, {
      get: (target, key: string) => {
        if (key in target) return target[key];
        throw new Error(`unmocked ${where}.${key}`);
      },
    });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {},
      {
        apps: { mod: { docStore: strict(docStore, 'apps.mod.docStore') } },
        useUtils: () => {
          const client = useQueryClient();
          return {
            apps: {
              mod: {
                docStore: {
                  listReported: { invalidate: () => client.invalidateQueries({ queryKey: LIST }) },
                  get: { invalidate: () => client.invalidateQueries({ queryKey: GET }) },
                },
              },
            },
          };
        },
      }
    ),
  };
});

const { AppDocStoreReportsQueue, DOC_STORE_ACTION_COPY, DOC_STORE_TRUNCATED_COPY } = await import(
  './AppDocStoreReportsQueue'
);

const TARGET = { appBlockId: 'apb_ROW1', collection: 'posts', key: 'k-17' };

function row(over: Row = {}): Row {
  return {
    ...TARGET,
    appSlug: 'pose-studio',
    reports: 4,
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

function doc(revision: number, text: string, over: Doc = {}): Doc {
  return {
    ...TARGET,
    appSlug: 'pose-studio',
    data: { text },
    revision,
    version: 3,
    reports: 4,
    reportsDismissedAt: null,
    hidden: null,
    ...over,
  };
}

/** The app's global query default, `staleTime: Infinity` (`src/utils/trpc.ts`). */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  return renderWithProviders(
    <QueryClientProvider client={client}>
      <AppDocStoreReportsQueue />
    </QueryClientProvider>
  );
}

async function act(button: string, reason: string) {
  await userEvent.click(page.getByRole('button', { name: button }));
  await userEvent.fill(page.getByTestId('doc-store-report-reason'), reason);
  await userEvent.click(page.getByTestId('doc-store-report-confirm'));
}

beforeEach(() => {
  m.listCalls = [];
  m.listResult = { items: [], truncated: false, failedApps: 0 };
  m.fetchGet = async () => doc(41, 'current text');
  m.getCalls = 0;
  m.sent = [];
  m.fail = null;
  m.errors = [];
  m.successes = [];
});

describe('AppDocStoreReportsQueue', () => {
  test('a row shows the app, the document, the report count and its author', async () => {
    m.listResult.items = [row()];
    mount();
    const r = page.getByTestId('doc-store-report-row');
    await expect.element(r).toHaveTextContent('pose-studio');
    await expect.element(r).toHaveTextContent('posts/k-17');
    await expect.element(r).toHaveTextContent('4 reports');
    await expect.element(r).toHaveTextContent('author-a (#31)');
    expect(page.getByTestId('doc-store-reports-truncated').elements()).toHaveLength(0);
    expect(page.getByTestId('doc-store-reports-failed-apps').elements()).toHaveLength(0);
  });

  test('defaults to visible docs; status and Refresh re-query', async () => {
    mount();
    await expect
      .element(page.getByText('No reported documents match these filters.'))
      .toBeVisible();
    expect(m.listCalls).toStrictEqual([{ status: 'open' }]);
    await userEvent.click(page.getByTestId('doc-store-reports-refresh'));
    await expect.poll(() => m.listCalls.length).toBe(2);
    await userEvent.click(page.getByTestId('doc-store-reports-status'));
    await userEvent.click(page.getByRole('option', { name: 'Hidden' }));
    await expect.poll(() => m.listCalls.at(-1)).toStrictEqual({ status: 'hidden' });
  });

  test('a truncated list and an unreadable app are each said plainly', async () => {
    m.listResult = { items: [row()], truncated: true, failedApps: 2 };
    mount();
    await expect
      .element(page.getByTestId('doc-store-reports-truncated'))
      .toHaveTextContent(DOC_STORE_TRUNCATED_COPY);
    await expect
      .element(page.getByTestId('doc-store-reports-truncated'))
      .toHaveTextContent('Dismiss the reports');
    await expect
      .element(page.getByTestId('doc-store-reports-failed-apps'))
      .toHaveTextContent('2 apps could not be read');
  });

  test('🔴 a review showing a cached older document acts on THAT revision, never the newer one', async () => {
    m.listResult.items = [row({ revision: 41 })];
    m.fetchGet = async () => doc(40, 'what the moderator read');
    mount();
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await expect.element(page.getByTestId('doc-store-review-revision')).toHaveTextContent('40');
    await userEvent.keyboard('{Escape}');

    // The author edits; the next read never answers, so the dialog can only show its cache.
    m.fetchGet = () => new Promise<Doc>(() => undefined);
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    // Re-read on open even under the app's `staleTime: Infinity` …
    await expect.poll(() => m.getCalls).toBe(2);
    // … and while that read is outstanding, what is shown is the cached revision 40.
    await expect
      .element(page.getByTestId('doc-store-report-data'))
      .toHaveTextContent('what the moderator read');
    await expect.element(page.getByTestId('doc-store-review-revision')).toHaveTextContent('40');
    await act('Hide', 'spam link');
    // Bound to what was displayed (40), not the list row (41): the server refuses it if the
    // document moved on, so newer content is never hidden unseen.
    expect(m.sent).toStrictEqual([
      ['setHidden', { ...TARGET, revision: 40, reason: 'spam link', hidden: true }],
    ]);
  });

  test('hide needs a reason; success notifies', async () => {
    m.listResult.items = [row()];
    mount();
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await userEvent.click(page.getByRole('button', { name: 'Hide' }));
    await expect.element(page.getByTestId('doc-store-report-confirm')).toBeDisabled();
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'spam link');
    await userEvent.click(page.getByTestId('doc-store-report-confirm'));
    await expect.poll(() => m.successes).toEqual([DOC_STORE_ACTION_COPY.hide.done]);
    expect(m.sent).toStrictEqual([
      ['setHidden', { ...TARGET, revision: 41, reason: 'spam link', hidden: true }],
    ]);
  });

  test('a hidden document offers Unhide (not Dismiss), which sends hidden: false', async () => {
    m.listResult.items = [row({ hidden: { at: new Date(), byUserId: 9, byUsername: 'mod-m' } })];
    m.fetchGet = async () => doc(41, 'x', { hidden: { at: new Date(), byUserId: 9 } });
    mount();
    await expect
      .element(page.getByTestId('doc-store-report-hidden'))
      .toHaveTextContent('Hidden by mod-m');
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await expect.element(page.getByRole('button', { name: 'Unhide' })).toBeVisible();
    // Dismissing is for a document kept visible: not offered on a hidden one.
    expect(page.getByRole('button', { name: 'Dismiss reports' }).elements()).toHaveLength(0);
    await act('Unhide', 'reviewed, fine');
    await expect
      .poll(() => m.sent)
      .toStrictEqual([
        ['setHidden', { ...TARGET, revision: 41, reason: 'reviewed, fine', hidden: false }],
      ]);
  });

  test('Dismiss reports calls dismissReports with the displayed revision', async () => {
    m.listResult.items = [row()];
    mount();
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await act('Dismiss reports', 'reviewed, within the rules');
    await expect
      .poll(() => m.sent)
      .toStrictEqual([
        ['dismissReports', { ...TARGET, revision: 41, reason: 'reviewed, within the rules' }],
      ]);
    await expect.poll(() => m.successes).toEqual([DOC_STORE_ACTION_COPY.dismiss.done]);
  });

  test('delete confirms with its own copy and calls delete', async () => {
    m.listResult.items = [row()];
    mount();
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await userEvent.click(page.getByRole('button', { name: 'Delete' }));
    await expect.element(page.getByText(DOC_STORE_ACTION_COPY.delete.title)).toBeVisible();
    await userEvent.fill(page.getByTestId('doc-store-report-reason'), 'illegal content');
    await userEvent.click(page.getByTestId('doc-store-report-confirm'));
    await expect
      .poll(() => m.sent)
      .toStrictEqual([['delete', { ...TARGET, revision: 41, reason: 'illegal content' }]]);
  });

  test('a refused action is reported and the queue is re-read', async () => {
    m.listResult.items = [row()];
    m.fail = new Error('document changed since it was read; reload and retry');
    mount();
    await userEvent.click(page.getByRole('button', { name: 'Review' }));
    await act('Hide', 'spam link');
    await expect
      .poll(() => m.errors)
      .toEqual(['document changed since it was read; reload and retry']);
    await expect.poll(() => m.listCalls.length).toBe(2);
  });
});
