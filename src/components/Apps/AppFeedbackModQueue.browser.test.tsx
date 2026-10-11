import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useRouter } from 'next/router';
import { renderWithProviders } from '../../../test/component-setup';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/** The `/apps/review` App feedback tab: rows, filters → query input, hide/unhide + conflicts. */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  rows: [] as Row[],
  listInputs: [] as Record<string, unknown>[],
  calls: [] as Record<string, unknown>[],
  invalidated: [] as string[],
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
  const invalidator = (name: string) => ({
    invalidate: (...args: unknown[]) => {
      // Any argument would narrow or soften the refetch; the queue must invalidate plainly.
      m.invalidated.push(args.length ? `${name}:${JSON.stringify(args)}` : name);
      return Promise.resolve();
    },
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'appFeedback.modList': {
          useInfiniteQuery: (input: Record<string, unknown>) => {
            m.listInputs.push(input);
            return {
              data: { pages: [{ items: m.rows, nextCursor: undefined }] },
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
        'appFeedback.modSetHidden': {
          useMutation: (opts: {
            onSuccess?: (d: unknown, v: Record<string, unknown>) => unknown;
            onError?: (e: unknown) => unknown;
          }) => ({
            isPending: false,
            variables: undefined,
            mutate: (vars: Record<string, unknown>) => {
              m.calls.push(vars);
              if (m.fail) void opts.onError?.(m.fail);
              else void opts.onSuccess?.(vars, vars);
            },
          }),
        },
      },
      {
        useUtils: () => ({
          appFeedback: {
            modList: invalidator('modList'),
            modCountFlagged: invalidator('modCountFlagged'),
          },
        }),
      }
    ),
  };
});

const { AppFeedbackModQueue } = await import('./AppFeedbackModQueue');
const { APP_FEEDBACK_HIDE_CONFLICT_MESSAGE } = await import('./appFeedbackModView');

function row(over: Row = {}): Row {
  return {
    id: 501,
    message: 'The generate button does nothing on the model page.',
    createdAt: new Date('2026-10-05T10:00:00Z'),
    status: 'new',
    triageNote: null,
    appListingId: 'apl_live',
    appBlockVersion: '1.4.0',
    appBlockSha: 'abcdef123456',
    ownerStatus: null,
    ownerStatusAt: null,
    ownerStatusById: null,
    ownerStatusByUsername: null,
    ownerFlaggedAt: null,
    hiddenFromOwnerAt: null,
    hiddenByModeratorId: null,
    hiddenByModeratorUsername: null,
    reporterId: 31,
    reporterUsername: 'reporter-r',
    reporterBanned: false,
    reporterMuted: false,
    appName: 'Pose Studio',
    appSlug: 'pose-studio',
    appKind: 'onsite',
    appOwnerId: 12,
    appOwnerUsername: 'owner-o',
    surface: 'slot',
    modelId: 9001,
    ...over,
  };
}

// The global `next/router` mock returns one router object; read it outside React through an
// alias so the hook rule does not mistake this for a component.
const readRouter = useRouter;
const router = readRouter() as unknown as {
  query: Record<string, string>;
  replace: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  m.rows = [];
  m.listInputs = [];
  m.calls = [];
  m.invalidated = [];
  m.fail = null;
  m.errors = [];
  m.successes = [];
  router.query = { tab: 'app-feedback' };
  router.replace.mockClear();
});

describe('AppFeedbackModQueue', () => {
  test('a row shows the moderator view: context, version, reporter, links', async () => {
    m.rows = [row()];
    renderWithProviders(<AppFeedbackModQueue />);
    const r = page.getByTestId('app-feedback-row');
    await expect.element(r).toHaveTextContent('The generate button does nothing');
    await expect.element(r).toHaveTextContent('v1.4.0 · abcdef1');
    await expect.element(r).toHaveTextContent('Model page slot');
    await expect
      .element(r.getByRole('link', { name: 'Model #9001' }))
      .toHaveAttribute('href', '/models/9001');
    await expect
      .element(r.getByRole('link', { name: 'Pose Studio' }))
      .toHaveAttribute('href', '/apps/store-preview/pose-studio');
    await expect
      .element(r.getByRole('link', { name: 'Triage in moderator app' }))
      .toHaveAttribute('href', expect.stringMatching(/\/feedback\/501$/));
    expect(page.getByTestId('app-feedback-reporter-banned').elements()).toHaveLength(0);
  });

  test('a deleted listing and a banned reporter are marked', async () => {
    // Slug and name kept: the link must be withheld because the listing is gone, not because
    // the join happened to return nothing.
    m.rows = [row({ appListingId: null, reporterBanned: true })];
    renderWithProviders(<AppFeedbackModQueue />);
    const r = page.getByTestId('app-feedback-row');
    await expect.element(r.getByText('Listing deleted').first()).toBeVisible();
    await expect.element(page.getByTestId('app-feedback-reporter-banned')).toBeVisible();
    expect(r.getByRole('link', { name: /Listing deleted|Pose Studio/ }).elements()).toHaveLength(0);
  });

  test('deep-linked filters reach the query input; flagged/deleted only as true', async () => {
    router.query = { tab: 'app-feedback', listingDeleted: '1', flagged: '1', hidden: 'hidden' };
    renderWithProviders(<AppFeedbackModQueue />);
    await expect.element(page.getByTestId('app-feedback-mod-queue')).toBeVisible();
    expect(m.listInputs.at(-1)).toStrictEqual({
      limit: 50,
      hidden: 'hidden',
      listingDeleted: true,
      flagged: true,
    });
  });

  test('ticking "Flagged by developer" writes the filter beside ?tab=', async () => {
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByLabelText('Flagged by developer'));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.calls[0][0]).toMatchObject({
      query: { tab: 'app-feedback', flagged: '1' },
    });
  });

  test('ticking "Listing deleted" clears the app filter', async () => {
    router.query = { tab: 'app-feedback', app: 'apl_live' };
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByLabelText('Listing deleted'));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace.mock.calls[0][0].query).toStrictEqual({
      tab: 'app-feedback',
      listingDeleted: '1',
    });
  });

  test('unticking a filter removes its param', async () => {
    router.query = { tab: 'app-feedback', flagged: '1' };
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByLabelText('Flagged by developer'));
    expect(router.replace.mock.calls[0][0].query).toStrictEqual({ tab: 'app-feedback' });
  });

  test('Hide asks first, then sends hidden=true and refetches the list and the badge', async () => {
    m.rows = [row(), row({ id: 502 })];
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide from developer' }).first());
    expect(m.calls).toHaveLength(0);
    expect(m.invalidated).toStrictEqual([]);
    await userEvent.click(page.getByTestId('app-feedback-confirm'));
    expect(m.calls).toStrictEqual([{ id: 501, hidden: true }]);
    expect(m.successes).toStrictEqual(['Hidden from the developer']);
    // A plain refetch is enough: `modList` and `modCountFlagged` read the primary.
    await vi.waitFor(() =>
      expect([...m.invalidated].sort()).toStrictEqual(['modCountFlagged', 'modList'])
    );
  });

  test('a hidden row offers Unhide and says who hid it', async () => {
    m.rows = [
      row({ hiddenFromOwnerAt: new Date('2026-10-06'), hiddenByModeratorUsername: 'mod-m' }),
    ];
    renderWithProviders(<AppFeedbackModQueue />);
    await expect.element(page.getByTestId('app-feedback-hidden')).toHaveTextContent('by mod-m');
    await userEvent.click(page.getByRole('button', { name: 'Unhide' }));
    await userEvent.click(page.getByTestId('app-feedback-confirm'));
    expect(m.calls).toStrictEqual([{ id: 501, hidden: false }]);
    expect(m.successes).toStrictEqual(['Visible to the developer again']);
    await vi.waitFor(() =>
      expect([...m.invalidated].sort()).toStrictEqual(['modCountFlagged', 'modList'])
    );
  });

  test('a conflict shows the conflict copy and refetches', async () => {
    m.rows = [row()];
    m.fail = { message: 'This feedback has changed', data: { code: 'CONFLICT' } };
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide from developer' }));
    await userEvent.click(page.getByTestId('app-feedback-confirm'));
    expect(m.errors).toStrictEqual([APP_FEEDBACK_HIDE_CONFLICT_MESSAGE]);
    await vi.waitFor(() =>
      expect([...m.invalidated].sort()).toStrictEqual(['modCountFlagged', 'modList'])
    );
    expect(m.successes).toStrictEqual([]);
  });

  test('any other failure shows the server message and does not refetch', async () => {
    m.rows = [row()];
    m.fail = { message: 'nope', data: { code: 'FORBIDDEN' } };
    renderWithProviders(<AppFeedbackModQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide from developer' }));
    await userEvent.click(page.getByTestId('app-feedback-confirm'));
    expect(m.errors).toStrictEqual(['nope']);
    expect(m.invalidated).toStrictEqual([]);
  });
});
