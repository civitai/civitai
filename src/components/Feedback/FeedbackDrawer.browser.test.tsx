import Router from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * FeedbackDrawer — the panel the support menu's "Report a bug" opens.
 *
 * 🔴 WHAT IS FAKED. `trpc` (no transport in the scaffold), `useCFImageUpload` (the
 * real one PUTs to Cloudflare), `useDialogContext` (the drawer is mounted directly
 * rather than through DialogProvider), and `getFaroSessionId` — that last one
 * DELIBERATELY, and through a mutable holder, because Faro never runs in the test
 * browser. Its real answer is always `undefined`, so an unfaked "no session id" test
 * passes on the environment rather than on the code: the whole `sessionId` read could
 * be deleted and nothing would notice. The holder makes the present case reachable,
 * which turns the absent case into a control instead of a coincidence.
 *
 * The attach/capture controls are NOT re-tested here; they are the same
 * `FeedbackAttachments` + `useFeedbackSubmission` the inline prompt uses, and
 * `FeedbackPrompt.browser.test.tsx` exercises the consent path against the real
 * capture module.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    createMutate: vi.fn(),
    onClose: vi.fn(),
    showErrorNotification: vi.fn(),
    areaEnabled: { value: true },
    faroSessionId: { value: undefined as string | undefined },
    /** When set, `mutate` takes the failure path instead of the success one. */
    mutateError: { value: undefined as string | undefined },
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      feedback: {
        getArea: { useQuery: () => ({ data: { enabled: mocks.areaEnabled.value } }) },
        create: {
          useMutation: (opts?: {
            onSuccess?: () => void;
            onError?: (error: { message: string }) => void;
          }) => ({
            mutate: (input: unknown) => {
              mocks.createMutate(input);
              if (mocks.mutateError.value) opts?.onError?.({ message: mocks.mutateError.value });
              else opts?.onSuccess?.();
            },
            isPending: false,
          }),
        },
      },
    },
  };
});

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose }),
}));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: vi.fn(),
    files: [],
    resetFiles: vi.fn(),
    removeImage: vi.fn(),
  }),
}));

vi.mock('~/utils/faro/getFaroSessionId', () => ({
  getFaroSessionId: () => mocks.faroSessionId.value,
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: mocks.showErrorNotification,
  showSuccessNotification: vi.fn(),
}));

const FeedbackDrawer = (await import('~/components/Feedback/FeedbackDrawer')).default;

const messageBox = () => page.getByPlaceholder('What were you doing, and what happened instead?');

const openDrawer = async () => {
  renderWithProviders(<FeedbackDrawer />);
  await expect.element(messageBox()).toBeInTheDocument();
};

const fileReport = async (text = 'the generate button does nothing') => {
  await openDrawer();
  await userEvent.fill(messageBox(), text);
  await userEvent.click(page.getByRole('button', { name: 'Send report' }));
};

const sent = async () => {
  await vi.waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));
  return mocks.createMutate.mock.calls[0][0] as Record<string, unknown>;
};

const context = async () => (await sent()).context as Record<string, unknown>;

/**
 * The scaffold's router mock is ONE shared object and `useRouter()` returns it, so the
 * default import is the same instance the component reads — mutated here rather than
 * called as a hook, which is a lint error outside a component. `beforeEach` puts it
 * back, because a route left set would leak into every later test in the file.
 */
const setRoute = (asPath: string) => {
  (Router as unknown as { asPath: string }).asPath = asPath;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.areaEnabled.value = true;
  mocks.faroSessionId.value = undefined;
  mocks.mutateError.value = undefined;
  setRoute('/');
});

describe('a report from the support menu', () => {
  test('files against the site-wide area', async () => {
    await fileReport();

    // The slug is the whole point of a site-wide entry point: a report filed under
    // `apps-marketplace` would be gated by, and triaged as, the apps store.
    expect((await sent()).area).toBe('site-bug-report');
    expect((await sent()).message).toBe('the generate button does nothing');
  });

  test('Send is unavailable until something has been typed', async () => {
    await openDrawer();
    await expect.element(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
    await userEvent.fill(messageBox(), 'x');
    await expect.element(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  });
});

/**
 * 🔴 THE DECISION THIS BLOCK PINS, addressed to whoever is about to "simplify"
 * `split(/[?#]/)[0]` back to a plain `router.asPath`: the query string must NEVER
 * reach `Feedback.context`.
 *
 * This entry point is in the footer on every route, and some routes carry a secret in
 * the URL — `/redeem-code?code=…`, `/payment/coinbase?key=…`. `context` is a JSONB
 * column read by triage and kept indefinitely, and the reporter is never shown what
 * the URL contained. Storing `asPath` whole writes a live redeemable code into it.
 * `path: z.string().max(300)` in the schema is a storage bound; it filters nothing.
 */
describe('🔴 the reported path carries the route and not the query string', () => {
  test('a secret in the URL is cut off, and the route survives', async () => {
    setRoute('/redeem-code?code=SUPER-SECRET-CODE#claimed');
    await fileReport('the code would not redeem');

    expect(await context()).toMatchObject({ path: '/redeem-code' });
    expect(JSON.stringify(await context())).not.toContain('SUPER-SECRET-CODE');
  });

  test('an ordinary route is reported in full', async () => {
    setRoute('/models/1234/some-model');
    await fileReport();

    // The control for the test above: the clip removes the query, not the path — an
    // implementation that reported `router.pathname` or a bare `/` would pass there
    // and fail here.
    expect(await context()).toMatchObject({ path: '/models/1234/some-model' });
  });
});

/**
 * 🔴 The Faro session id is the entire reason this panel beats a support ticket — it
 * is what turns "it broke" into a session with the console errors in it. Both
 * directions are asserted because Faro never runs in the test browser: an absence
 * test alone would pass with the `getFaroSessionId()` call deleted.
 */
describe('🔴 the Grafana Faro session travels with the report', () => {
  test('the session id is attached when Faro is running', async () => {
    mocks.faroSessionId.value = 'faro-session-abc123';
    await fileReport();

    expect(await context()).toMatchObject({ sessionId: 'faro-session-abc123' });
  });

  test('and the report still sends when Faro is not running', async () => {
    await fileReport('no faro in the test browser');

    expect(await sent()).toBeTruthy();
    expect(await context()).not.toHaveProperty('sessionId');
  });
});

describe('when the server refuses the report', () => {
  test('the reporter is told, and the form is not cleared', async () => {
    mocks.mutateError.value = 'You have submitted a lot of feedback — give it a little while.';
    await fileReport('rate limited');

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    // Still the form, not the "Got it, thanks" panel — a rejected report must not
    // read as a delivered one.
    await expect.element(messageBox()).toBeInTheDocument();
  });
});

/**
 * 🔴 The drawer must not appear in the screenshot the drawer collects.
 * `captureConsentedScreenshot` draws `document.body`, and this Drawer portals into
 * it, so without the ignore attribute the capture is this form plus the page dimmed
 * behind the overlay. The assertion goes through `closest()` from the rendered
 * content rather than reading the prop, because the question is whether Mantine
 * actually puts the attribute on an ancestor of BOTH the panel and the overlay — a
 * prop Mantine dropped would be invisible and silently restore the bug.
 */
describe('🔴 the panel excludes itself from the page capture', () => {
  test('an ancestor of the drawer content carries the html2canvas ignore attribute', async () => {
    await openDrawer();

    const ignored = messageBox().element().closest('[data-html2canvas-ignore]');
    expect(
      ignored,
      'Mantine dropped the attribute — the panel would be in its own capture'
    ).not.toBeNull();

    // The overlay is the other half: it is a sibling of the panel, so an attribute
    // that landed on the panel alone would dim the page in every capture.
    const overlay = document.querySelector('.mantine-Drawer-overlay');
    expect(overlay, 'no overlay rendered — this assertion would prove nothing').not.toBeNull();
    expect(ignored?.contains(overlay!)).toBe(true);
  });
});

describe('when the area stopped collecting between the click and the render', () => {
  test('the form is gone and the ticket portal is offered instead', async () => {
    mocks.areaEnabled.value = false;
    renderWithProviders(<FeedbackDrawer />);

    await expect
      .element(page.getByRole('link', { name: 'Support Portal' }))
      .toHaveAttribute('href', '/support-portal');
    // Present-then-absent would be a race; this state never arrives at all, so a
    // synchronous read after the awaited assertion above is safe.
    expect(document.querySelector('textarea')).toBeNull();
  });
});
