import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as RoutedDialogLinkModule from '~/components/Dialog/RoutedDialogLink';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The model page discussion's comment counts behind the client flag `commentCountsSingleCall`.
 *
 * OFF: the two `comment.getVisibleCountByModel` calls exactly as before (the hidden view and the
 * plain view, both enabled from the first render), and the new procedure is never enabled.
 * ON: one `comment.getVisibleCountsByModel` call, only once the first page holds comments; when
 * that page has no next page it asks for the hidden count only (`includeVisible: false`) and the
 * label reads the loaded comments, so no visible count runs anywhere.
 */

type QueryCall = { input: Record<string, unknown>; enabled: boolean };

const mocks = vi.hoisted(() => ({
  features: {} as Record<string, boolean>,
  pages: [] as { comments: { id: number }[]; nextCursor?: number }[],
  singleCount: { hidden: 0, visible: 0 },
  counts: { visible: null as number | null, hidden: 0 },
  singleCalls: [] as QueryCall[],
  countsCalls: [] as QueryCall[],
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => mocks.features }));
vi.mock('~/components/ContainerProvider/useContainerSmallerThan', () => ({
  useContainerSmallerThan: () => false,
}));
vi.mock('~/components/Model/ModelDiscussion/CommentMasonryVirtual', () => ({
  CommentMasonryVirtual: ({ comments }: { comments: { id: number }[] }) => (
    <ul>
      {comments.map((comment) => (
        <li key={comment.id}>{`comment ${comment.id}`}</li>
      ))}
    </ul>
  ),
}));
vi.mock('~/components/Dialog/RoutedDialogLink', async (importOriginal) => ({
  ...(await importOriginal<typeof RoutedDialogLinkModule>()),
  RoutedDialogLink: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// A proxy: only the three procedures measured here are overridden; any other path is inert.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'comment.getAll': {
        useInfiniteQuery: () => ({
          data: { pages: mocks.pages },
          isLoading: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
          hasNextPage: mocks.pages.at(-1)?.nextCursor !== undefined,
          isRefetching: false,
        }),
      },
      'comment.getVisibleCountByModel': {
        useQuery: (input: Record<string, unknown>, opts: { enabled?: boolean } = {}) => {
          const enabled = opts.enabled ?? true;
          mocks.singleCalls.push({ input, enabled });
          if (!enabled) return { data: undefined };
          return { data: input.hidden ? mocks.singleCount.hidden : mocks.singleCount.visible };
        },
      },
      'comment.getVisibleCountsByModel': {
        useQuery: (input: Record<string, unknown>, opts: { enabled?: boolean } = {}) => {
          const enabled = opts.enabled ?? true;
          mocks.countsCalls.push({ input, enabled });
          return { data: enabled ? mocks.counts : undefined };
        },
      },
    }),
  };
});

const { ModelDiscussionV2 } = await import('../ModelDiscussionV2');

// Pairwise distinct, and distinct from the comment counts below.
const MODEL = 7301;
const page1 = (nextCursor?: number) => ({ comments: [{ id: 41 }, { id: 42 }], nextCursor });

const enabledCalls = (calls: QueryCall[]) => calls.filter((call) => call.enabled);

beforeEach(() => {
  mocks.features = {};
  mocks.pages = [page1()];
  mocks.singleCount = { hidden: 3, visible: 5 };
  mocks.counts = { visible: 9, hidden: 4 };
  mocks.singleCalls = [];
  mocks.countsCalls = [];
});

describe('ModelDiscussionV2 counts, commentCountsSingleCall OFF', () => {
  test('the two single-count calls run, exactly as before, and the new one never does', async () => {
    mocks.pages = [page1(43)];
    renderWithProviders(<ModelDiscussionV2 modelId={MODEL} />);

    await expect.element(page.getByText('Showing 2 of 5 comments')).toBeInTheDocument();
    await expect.element(page.getByText('See 3 more hidden comments')).toBeInTheDocument();
    // Every render asks for the same two inputs, both enabled.
    const inputs = new Set(mocks.singleCalls.map((call) => JSON.stringify(call)));
    expect([...inputs].sort()).toEqual(
      [
        JSON.stringify({ input: { modelId: MODEL, hidden: true }, enabled: true }),
        JSON.stringify({ input: { modelId: MODEL }, enabled: true }),
      ].sort()
    );
    expect(enabledCalls(mocks.countsCalls)).toEqual([]);
  });

  test('a first page with no next page still runs both calls', async () => {
    renderWithProviders(<ModelDiscussionV2 modelId={MODEL} />);

    await expect.element(page.getByText('See 3 more hidden comments')).toBeInTheDocument();
    expect(enabledCalls(mocks.singleCalls).map((call) => call.input)).toContainEqual({
      modelId: MODEL,
    });
    expect(enabledCalls(mocks.countsCalls)).toEqual([]);
  });
});

describe('ModelDiscussionV2 counts, commentCountsSingleCall ON', () => {
  beforeEach(() => {
    mocks.features = { commentCountsSingleCall: true };
  });

  test('a first page with a next page: one call for both counts', async () => {
    mocks.pages = [page1(43)];
    renderWithProviders(<ModelDiscussionV2 modelId={MODEL} />);

    await expect.element(page.getByText('Showing 2 of 9 comments')).toBeInTheDocument();
    await expect.element(page.getByText('See 4 more hidden comments')).toBeInTheDocument();
    const inputs = new Set(
      enabledCalls(mocks.countsCalls).map((call) => JSON.stringify(call.input))
    );
    expect([...inputs]).toEqual([JSON.stringify({ modelId: MODEL, includeVisible: true })]);
    expect(enabledCalls(mocks.singleCalls)).toEqual([]);
  });

  test('a first page with no next page: the hidden count only, and the label from the list', async () => {
    mocks.counts = { visible: null, hidden: 4 };
    renderWithProviders(<ModelDiscussionV2 modelId={MODEL} />);

    await expect.element(page.getByText('2 comments')).toBeInTheDocument();
    await expect.element(page.getByText('See 4 more hidden comments')).toBeInTheDocument();
    const inputs = new Set(
      enabledCalls(mocks.countsCalls).map((call) => JSON.stringify(call.input))
    );
    expect([...inputs]).toEqual([JSON.stringify({ modelId: MODEL, includeVisible: false })]);
    expect(enabledCalls(mocks.singleCalls)).toEqual([]);
  });

  test('no comments: no count call at all', async () => {
    mocks.pages = [{ comments: [] }];
    renderWithProviders(<ModelDiscussionV2 modelId={MODEL} />);

    await expect
      .element(page.getByText('There are no comments for this model yet.'))
      .toBeInTheDocument();
    expect(enabledCalls(mocks.countsCalls)).toEqual([]);
    expect(enabledCalls(mocks.singleCalls)).toEqual([]);
  });
});
