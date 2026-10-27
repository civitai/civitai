import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';
import type * as RequireLoginMod from '~/components/Login/requireLogin';
import type * as ToursProviderMod from '~/components/Tours/ToursProvider';
import { APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT } from '~/server/schema/app-access-request.schema';

/**
 * "Request access" on the `/apps/build` pitch, through the REAL panel, the REAL dialog store and
 * the REAL modal form: the button opens the form, the form validates against the server's own
 * schema before anything is sent, a valid form sends the mutation's input shape, and the viewer
 * sees what became of their request — including that an approval is real: the approved state
 * links to a full load of `/apps/build`, where the assistant is chosen server-side.
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
  request: null as null | Request,
  submitted: [] as unknown[],
  submitPending: false,
  submitError: null as null | { message: string },
  requireLogin: vi.fn(),
  onRequest: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/providers/IsClientProvider', () => ({ useIsClient: () => true }));
vi.mock('~/components/Login/requireLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof RequireLoginMod>()),
  requireLogin: mocks.requireLogin,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProviderMod>()),
  useTourContext: () => ({ running: false, activeTour: null, pauseTour: () => undefined }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'appAccessRequest.getMine': {
      useQuery: () => ({ data: mocks.request, isLoading: false }),
    },
    'appAccessRequest.submit': {
      useMutation: (opts?: { onSuccess?: () => unknown }) => ({
        mutate: (input: unknown) => {
          mocks.submitted.push(input);
          void opts?.onSuccess?.();
        },
        isPending: mocks.submitPending,
        error: mocks.submitError,
      }),
    },
  }),
}));

const { AppAccessRequestPanel } = await import('./AppAccessRequestPanel');
const { DialogProvider } = await import('~/components/Dialog/DialogProvider');
const { dialogStore, useDialogStore } = await import('~/components/Dialog/dialogStore');

const IDEA = 'A sketchbook app that turns my rough line art into a coloured comic panel.';
const PENDING: Request = {
  id: 77,
  status: 'pending',
  whatToBuild: 'A recipe card maker that illustrates each step with a generated image.',
  createdAt: new Date('2026-10-20T09:00:00Z'),
  reviewedAt: null,
};

function render() {
  renderWithProviders(
    <>
      <AppAccessRequestPanel onRequest={mocks.onRequest} />
      <DialogProvider />
    </>
  );
}

const whatToBuild = () => page.getByTestId('app-access-what-to-build');
const submit = () => page.getByTestId('app-access-submit');
/** The dialogs the store holds open. Opening the form pushes onto it synchronously, in the click. */
const openDialogIds = () => useDialogStore.getState().dialogs.map((d) => d.id);

beforeEach(() => {
  dialogStore.closeAll?.();
  mocks.user = { id: 42, username: 'lena_paints', isModerator: false };
  mocks.request = null;
  mocks.submitted = [];
  mocks.submitPending = false;
  mocks.submitError = null;
  mocks.requireLogin.mockReset();
  mocks.onRequest.mockReset();
});

describe('AppAccessRequestPanel — a first request', () => {
  test('the button opens the form, and a valid form sends the text', async () => {
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    expect(mocks.onRequest).toHaveBeenCalledTimes(1);
    // The store read the signed-out case relies on can see an open form.
    expect(openDialogIds()).toEqual(['app-access-request']);
    await expect.element(whatToBuild()).toBeInTheDocument();

    await userEvent.fill(whatToBuild().element() as HTMLElement, IDEA);
    await submit().click();

    await vi.waitFor(() => expect(mocks.submitted).toHaveLength(1));
    expect(mocks.submitted[0]).toEqual({ whatToBuild: IDEA });
  });

  test('🔴 a too-short idea shows the schema’s message and sends nothing', async () => {
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    await expect.element(whatToBuild()).toBeInTheDocument();
    await userEvent.fill(whatToBuild().element() as HTMLElement, 'a game');
    await submit().click();
    await expect.element(page.getByText(APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT)).toBeInTheDocument();
    expect(mocks.submitted).toEqual([]);
  });

  test('while sending, the submit button is busy; a server refusal is shown in the form', async () => {
    mocks.submitPending = true;
    mocks.submitError = { message: 'Your request is waiting for review.' };
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    await expect.element(submit()).toHaveAttribute('data-loading', 'true');
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
  });

  test('declined: says so, and a new request starts from an EMPTY form', async () => {
    mocks.request = {
      ...PENDING,
      status: 'declined',
      reviewedAt: new Date('2026-10-22T10:00:00Z'),
    };
    render();
    await expect.element(page.getByText('Not approved', { exact: true })).toBeInTheDocument();
    await page.getByRole('button', { name: 'Request access again' }).click();
    await expect.element(whatToBuild()).toHaveValue('');
  });
});

describe('AppAccessRequestPanel — signed out', () => {
  test('🔴 the button goes to sign-in first and opens no form', async () => {
    mocks.user = null;
    render();
    await page.getByRole('button', { name: 'Request access' }).click();
    // Positive first: the click reached the sign-in flow, so the click's handlers have run.
    expect(mocks.requireLogin).toHaveBeenCalledTimes(1);
    expect(mocks.requireLogin.mock.calls[0][0]).toMatchObject({ reason: 'perform-action' });
    // The store, not the DOM, is the settled answer: a form opened in the click would already be
    // in it, while its DOM mounts later, behind a lazy import.
    expect(openDialogIds()).toEqual([]);
    expect(whatToBuild().elements()).toHaveLength(0);
  });
});
