import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';
import type * as RequireLoginMod from '~/components/Login/requireLogin';
import type * as ToursProviderMod from '~/components/Tours/ToursProvider';

/**
 * "Request access" on the `/apps/build` pitch, through the REAL panel and its REAL inline form:
 * one click sends a request (the answer is optional), the form validates against the server's own
 * schema, a request the server approved on the spot reloads the page into the build surface, and
 * the viewer sees what became of their request — including that an approval is real: the approved
 * state links to a full load of `/apps/build`, where the assistant is chosen server-side.
 */

type Request = {
  id: number;
  status: 'pending' | 'approved' | 'declined';
  whatToBuild: string;
  createdAt: Date;
  reviewedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  user: { id: 42, username: 'lena_paints', isModerator: false } as null | {
    id: number;
    username: string;
    isModerator: boolean;
  },
  /** `undefined` = `getMine` has not answered yet; `null` = never asked. */
  request: null as undefined | null | Request,
  submitted: [] as unknown[],
  /** What the server makes of a submit: pending (manual queue) or approved (auto-approval). */
  submitResult: 'pending' as 'pending' | 'approved',
  invalidated: [] as string[],
  submitPending: false,
  submitError: null as null | { message: string },
  requireLogin: vi.fn(),
  openLoginHere: vi.fn(),
  onRequest: vi.fn(),
  sessionStatus: 'authenticated' as 'authenticated' | 'unauthenticated' | 'loading',
}));

vi.mock('~/providers/SessionProvider', () => ({
  useSession: () => ({ data: undefined, status: mocks.sessionStatus, update: async () => null }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/components/Login/requireLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof RequireLoginMod>()),
  requireLogin: mocks.requireLogin,
  openLoginHere: mocks.openLoginHere,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProviderMod>()),
  useTourContext: () => ({ running: false, activeTour: null, pauseTour: () => undefined }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy(
    {
      'appAccessRequest.getMine': {
        useQuery: () => ({ data: mocks.request, isLoading: false }),
      },
      'appAccessRequest.submit': {
        useMutation: (opts?: { onSuccess?: (row: unknown) => unknown }) => ({
          mutate: (input: unknown) => {
            mocks.submitted.push(input);
            void opts?.onSuccess?.({ id: 501, status: mocks.submitResult });
          },
          isPending: mocks.submitPending,
          error: mocks.submitError,
        }),
      },
    },
    {
      // A stable spy: the proxy's default `useUtils` mints a fresh one per read.
      useUtils: () => ({
        appAccessRequest: {
          getMine: { invalidate: async () => void mocks.invalidated.push('getMine') },
        },
      }),
    }
  ),
}));

const { AppAccessRequestPanel } = await import('./AppAccessRequestPanel');
// The pages-router is stubbed by `test/component-setup` as ONE shared object, and that module-level
// mock wins over a per-file `vi.mock('next/router')` — so the deep-link cases drive that object.
const { useRouter } = await import('next/router');
const router = useRouter() as unknown as {
  query: Record<string, string>;
  asPath: string;
  pathname: string;
  replace: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
};

const IDEA = 'A sketchbook app that turns my rough line art into a coloured comic panel.';
const PENDING: Request = {
  id: 77,
  status: 'pending',
  whatToBuild: 'A recipe card maker that illustrates each step with a generated image.',
  createdAt: new Date('2026-10-20T09:00:00Z'),
  reviewedAt: null,
};

const ui = () => <AppAccessRequestPanel onRequest={mocks.onRequest} />;
const render = () => renderWithProviders(ui());

const whatToBuild = () => page.getByTestId('app-access-what-to-build');
const form = () => page.getByTestId('app-access-request-form');
/** Whether the form's text box holds focus — what the deep link does for an eligible viewer. */
const textBoxFocused = () => document.activeElement?.id === 'app-access-what-to-build';

beforeEach(() => {
  mocks.user = { id: 42, username: 'lena_paints', isModerator: false };
  mocks.request = null;
  mocks.submitted = [];
  mocks.submitResult = 'pending';
  mocks.invalidated = [];
  mocks.submitPending = false;
  mocks.submitError = null;
  mocks.requireLogin.mockReset();
  mocks.openLoginHere.mockReset();
  mocks.onRequest.mockReset();
  router.query = {};
  router.asPath = '/apps/build';
  router.pathname = '/apps/build';
  router.replace.mockClear();
  router.reload.mockClear();
  mocks.sessionStatus = 'authenticated';
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('AppAccessRequestPanel — a first request', () => {
  test('🔴 ONE click sends a request: the answer is optional and an empty box is sent as empty', async () => {
    render();
    await expect.element(whatToBuild()).toHaveValue('');
    await page.getByRole('button', { name: 'Request access' }).click();

    await vi.waitFor(() => expect(mocks.submitted).toHaveLength(1));
    expect(mocks.submitted[0]).toEqual({ whatToBuild: '' });
    expect(mocks.onRequest).toHaveBeenCalledTimes(1);
  });

  test('what the person writes is sent, short answers included', async () => {
    render();
    await expect.element(whatToBuild()).toBeInTheDocument();
    await userEvent.fill(whatToBuild().element() as HTMLElement, IDEA);
    await page.getByRole('button', { name: 'Request access' }).click();
    await vi.waitFor(() => expect(mocks.submitted).toEqual([{ whatToBuild: IDEA }]));

    await userEvent.fill(whatToBuild().element() as HTMLElement, 'a game');
    await page.getByRole('button', { name: 'Request access' }).click();
    await vi.waitFor(() => expect(mocks.submitted).toHaveLength(2));
    expect(mocks.submitted[1]).toEqual({ whatToBuild: 'a game' });
  });

  test('🔴 approved on the spot: the page RELOADS into the build surface', async () => {
    mocks.submitResult = 'approved';
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    await vi.waitFor(() => expect(router.reload).toHaveBeenCalledTimes(1));
  });

  test('🔴 left pending: no reload; the status query is refetched so the panel shows it', async () => {
    mocks.submitResult = 'pending';
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    await vi.waitFor(() => expect(mocks.invalidated).toEqual(['getMine']));
    expect(router.reload).not.toHaveBeenCalled();
  });

  test('while sending, the button is busy; a server refusal is shown in the form', async () => {
    mocks.submitPending = true;
    mocks.submitError = { message: 'Your request is waiting for review.' };
    render();
    await expect
      .element(page.getByTestId('app-access-request-button'))
      .toHaveAttribute('data-loading', 'true');
    await expect
      .element(page.getByTestId('app-access-submit-error'))
      .toHaveTextContent('Your request is waiting for review.');
  });
});

describe('AppAccessRequestPanel — the viewer’s request status', () => {
  test('🔴 pending: shows the status and offers no form — one open request at a time', async () => {
    mocks.request = PENDING;
    render();
    const status = page.getByTestId('app-access-request-status');
    await expect.element(status).toHaveAttribute('data-status', 'pending');
    await expect.element(page.getByText('Pending review', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('A moderator will review your request.'))
      .toBeInTheDocument();
    expect(page.getByRole('button').elements()).toHaveLength(0);
    expect(form().elements()).toHaveLength(0);
  });

  test('🔴 approved: says access is on, and links to a FULL load of /apps/build', async () => {
    mocks.request = {
      ...PENDING,
      status: 'approved',
      reviewedAt: new Date('2026-10-22T10:00:00Z'),
    };
    render();
    await expect.element(page.getByText('Approved', { exact: true })).toBeInTheDocument();
    await expect
      .element(
        page.getByText('You can build apps now. Reload this page and the App Assistant opens here.')
      )
      .toBeInTheDocument();
    const open = page.getByTestId('app-access-request-open-assistant');
    // A plain anchor (a full navigation), not a Next <Link>: the assistant view is decided by
    // getServerSideProps from the refreshed session, which a client transition would not re-run
    // with fresh flags.
    await expect.element(open).toHaveAttribute('href', '/apps/build');
    expect(page.getByRole('button', { name: /Request access/ }).elements()).toHaveLength(0);
    expect(form().elements()).toHaveLength(0);
  });

  test('declined: says so, and a new request starts from an EMPTY form, one click', async () => {
    mocks.request = {
      ...PENDING,
      status: 'declined',
      reviewedAt: new Date('2026-10-22T10:00:00Z'),
    };
    render();
    await expect.element(page.getByText('Not approved', { exact: true })).toBeInTheDocument();
    await expect.element(whatToBuild()).toHaveValue('');
    await page.getByRole('button', { name: 'Request access again' }).click();
    await vi.waitFor(() => expect(mocks.submitted).toEqual([{ whatToBuild: '' }]));
  });
});

describe('AppAccessRequestPanel — signed out', () => {
  test('🔴 the button goes to sign-in first and sends nothing', async () => {
    mocks.user = null;
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    // Positive first: the click reached the sign-in flow, so the click's handlers have run.
    expect(mocks.requireLogin).toHaveBeenCalledTimes(1);
    expect(mocks.requireLogin.mock.calls[0][0]).toMatchObject({ reason: 'perform-action' });
    expect(mocks.submitted).toEqual([]);
    expect(form().elements()).toHaveLength(0);
  });
});

describe('AppAccessRequestPanel — the /apps/build?request-access=1 deep link', () => {
  const withParam = (extra: Record<string, string> = {}) => {
    router.query = { 'request-access': '1', ...extra };
    const qs = new URLSearchParams(router.query).toString();
    router.asPath = `/apps/build?${qs}`;
  };
  /** The param was dropped with a shallow replace that kept every other param. */
  const expectParamDropped = (rest: Record<string, string> = {}) => {
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      { pathname: '/apps/build', query: rest },
      undefined,
      { shallow: true }
    );
  };

  test('🔴 an eligible viewer gets the form focused, and the param is dropped', async () => {
    withParam();
    render();
    await vi.waitFor(() => expect(textBoxFocused()).toBe(true));
    expectParamDropped();
    // Not a click, so nothing is sent and the click's tracking does not fire.
    expect(mocks.submitted).toEqual([]);
    expect(mocks.onRequest).not.toHaveBeenCalled();
  });

  test('other params survive the drop', async () => {
    withParam({ ref: 'cli' });
    render();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expectParamDropped({ ref: 'cli' });
  });

  test('🔴 a PENDING viewer sees their status, no form, and the param is still dropped', async () => {
    mocks.request = PENDING;
    withParam();
    render();
    // Positive control first: the effect ran (it drops the param in the same pass that focuses).
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expectParamDropped();
    await expect
      .element(page.getByTestId('app-access-request-status'))
      .toHaveAttribute('data-status', 'pending');
    expect(form().elements()).toHaveLength(0);
    expect(textBoxFocused()).toBe(false);
  });

  test('an APPROVED viewer gets no form either', async () => {
    mocks.request = {
      ...PENDING,
      status: 'approved',
      reviewedAt: new Date('2026-10-22T10:00:00Z'),
    };
    withParam();
    render();
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalled());
    expect(form().elements()).toHaveLength(0);
  });

  test('a DECLINED viewer may ask again, so the form is focused', async () => {
    mocks.request = {
      ...PENDING,
      status: 'declined',
      reviewedAt: new Date('2026-10-22T10:00:00Z'),
    };
    withParam();
    render();
    await vi.waitFor(() => expect(textBoxFocused()).toBe(true));
    expectParamDropped();
  });

  test('🔴 nothing happens until getMine answers — the param waits for the status', async () => {
    mocks.request = undefined;
    withParam();
    const view = await renderWithProviders(ui());
    await expect.element(page.getByTestId('app-access-request-button')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
    expect(textBoxFocused()).toBe(false);

    // Positive control: once getMine answers "never asked", the same mount acts — so what held it
    // back was the missing answer, not a slow or dead effect.
    mocks.request = null;
    await view.rerender(ui());
    await vi.waitFor(() => expect(textBoxFocused()).toBe(true));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  test('🔴 signed out: sign-in, returning to the URL WITH the param; nothing sent', async () => {
    mocks.user = null;
    mocks.sessionStatus = 'unauthenticated';
    withParam();
    render();
    await vi.waitFor(() => expect(mocks.openLoginHere).toHaveBeenCalledTimes(1));
    expect(mocks.openLoginHere).toHaveBeenCalledWith(
      'perform-action',
      '/apps/build?request-access=1'
    );
    // Dropped BEFORE sign-in opens, so Back from sign-in does not bounce into it again.
    expectParamDropped();
    expect(router.replace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openLoginHere.mock.invocationCallOrder[0]
    );
    expect(mocks.submitted).toEqual([]);
  });

  test('🔴 a still-LOADING session is not a signed-out one: no sign-in, param kept', async () => {
    mocks.user = null;
    mocks.sessionStatus = 'loading';
    withParam();
    render();
    await expect.element(page.getByTestId('app-access-request-button')).toBeInTheDocument();
    expect(mocks.openLoginHere).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test('without the param, nothing is focused and the URL is left alone', async () => {
    render();
    await expect.element(page.getByTestId('app-access-request-button')).toBeInTheDocument();
    expect(textBoxFocused()).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
