import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * FeedbackDrawer — the panel the support menu's "Report a bug" opens.
 *
 * 🔴 WHAT IS FAKED. `trpc` (no transport in the scaffold), `useCFImageUpload` (the
 * real one PUTs to Cloudflare) and `useDialogContext` (the drawer is mounted
 * directly rather than through DialogProvider). `getFaroSessionId` is NOT faked:
 * Faro does not run in the test browser, so its real answer is `undefined` — which
 * is the ordinary dev/preview case and the one worth proving does not block a send.
 *
 * The attach/capture controls are NOT re-tested here; they are the same
 * `FeedbackAttachments` + `useFeedbackSubmission` the inline prompt uses, and
 * `FeedbackPrompt.browser.test.tsx` exercises the consent path against the real
 * capture module. What is only true HERE is the area slug and the reported path.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    createMutate: vi.fn(),
    onClose: vi.fn(),
    areaEnabled: { value: true },
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
          useMutation: (opts?: { onSuccess?: () => void }) => ({
            mutate: (input: unknown) => {
              mocks.createMutate(input);
              opts?.onSuccess?.();
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

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

const FeedbackDrawer = (await import('~/components/Feedback/FeedbackDrawer')).default;

const messageBox = () => page.getByPlaceholder('What were you doing, and what happened instead?');

const openDrawer = async () => {
  renderWithProviders(<FeedbackDrawer />);
  await expect.element(messageBox()).toBeInTheDocument();
};

const submitted = () => mocks.createMutate.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.areaEnabled.value = true;
});

describe('a report from the support menu', () => {
  test('files against the site-wide area and names the route it came from', async () => {
    await openDrawer();
    await userEvent.fill(messageBox(), 'the generate button does nothing');
    await userEvent.click(page.getByRole('button', { name: 'Send report' }));
    await vi.waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));

    // The slug is the whole point of a site-wide entry point: a report filed under
    // `apps-marketplace` would be gated by, and triaged as, the apps store.
    expect(submitted().area).toBe('site-bug-report');
    expect(submitted().message).toBe('the generate button does nothing');
    // `next/router` is mocked by the scaffold; whatever it reports is what a report
    // has to carry, because nothing else in the payload says where the user was.
    expect((submitted().context as { path?: string }).path).toBeTruthy();
  });

  test('sends with no Faro session rather than refusing to send', async () => {
    await openDrawer();
    await userEvent.fill(messageBox(), 'no faro in the test browser');
    await userEvent.click(page.getByRole('button', { name: 'Send report' }));
    await vi.waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));

    expect((submitted().context as { sessionId?: string }).sessionId).toBeUndefined();
  });

  test('Send is unavailable until something has been typed', async () => {
    await openDrawer();
    await expect.element(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
    await userEvent.fill(messageBox(), 'x');
    await expect.element(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
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
