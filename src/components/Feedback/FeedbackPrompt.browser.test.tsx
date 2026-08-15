import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as CaptureModule from '~/components/Feedback/captureScreenshot';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * FeedbackPrompt — the real click path for image attachments and the opt-in page
 * capture.
 *
 * 🔴 WHAT IS AND IS NOT FAKED, stated up front.
 *
 * `captureConsentedScreenshot` is NOT replaced. The mock below delegates to the
 * REAL implementation and only substitutes its html2canvas LOADER — so the consent
 * guard that decides whether anything is captured executes for real on every click
 * in this file, and `loadHtml2Canvas` is the observable for "did a capture start".
 * Replacing the whole module would have made the consent tests assertions about the
 * mock instead of about the product.
 *
 * `useCFImageUpload` IS replaced, with a stub whose signature was written against
 * the real hook (`uploadToCF(file, metadata?, options?) => Promise<{ url, id,
 * objectUrl, type }>`, plus `files` / `resetFiles` / `removeImage`). The real one
 * does an XHR PUT to a Cloudflare URL fetched from `/api/v1/image-upload`; nothing
 * serves either in the test browser.
 *
 * `trpc` is replaced because the scaffold wires no tRPC transport.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    // Stands in for html2canvas. Called ONLY if the real consent guard lets a
    // capture proceed — this is the load-bearing observable of this file.
    loadHtml2Canvas: vi.fn(),
    html2canvas: vi.fn(),
    uploadToCF: vi.fn(),
    createMutate: vi.fn(),
    showErrorNotification: vi.fn(),
  },
}));

vi.mock('~/components/Feedback/captureScreenshot', async (importOriginal) => {
  const actual = await importOriginal<typeof CaptureModule>();
  return {
    ...actual,
    // Delegate to the REAL capture — only the dependency loader is swapped.
    captureConsentedScreenshot: (args: CaptureModule.CaptureScreenshotArgs) =>
      actual.captureConsentedScreenshot({ ...args, loader: mocks.loadHtml2Canvas }),
  };
});

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      feedback: {
        getArea: { useQuery: () => ({ data: { enabled: true } }) },
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

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'reporter' }),
}));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: mocks.uploadToCF,
    files: [],
    resetFiles: vi.fn(),
    removeImage: vi.fn(),
  }),
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: mocks.showErrorNotification,
  showSuccessNotification: vi.fn(),
}));

const { FeedbackPrompt } = await import('~/components/Feedback/FeedbackPrompt');

/** A canvas stand-in; `toBlob` is callback-style, as in the DOM. */
const canvasYielding = (blob: Blob) =>
  ({
    toBlob: (callback: CanvasBlobCallback) => callback(blob),
  } as unknown as HTMLCanvasElement);

type CanvasBlobCallback = (blob: Blob | null) => void;

const CAPTURED_JPEG = new Blob(['captured-pixels'], { type: 'image/jpeg' });

const imageFile = (name = 'screen.png') => new File(['png-bytes'], name, { type: 'image/png' });

const renderPrompt = () =>
  renderWithProviders(
    <FeedbackPrompt
      area="bitdex-image-feed"
      notice="We're testing a new system behind this feed."
      context={{ path: '/images', reportedSource: 'bitdex' }}
    />
  );

const openPrompt = async () => {
  renderPrompt();
  await userEvent.click(page.getByRole('button', { name: 'Give feedback' }));
  await expect.element(page.getByPlaceholder('What looked wrong?')).toBeInTheDocument();
};

const typeMessage = async (text = 'the feed repeated itself') => {
  await userEvent.fill(page.getByPlaceholder('What looked wrong?'), text);
};

const send = async () => {
  await userEvent.click(page.getByRole('button', { name: 'Send feedback' }));
  await vi.waitFor(() => expect(mocks.createMutate).toHaveBeenCalledTimes(1));
};

const submittedContext = () =>
  (mocks.createMutate.mock.calls[0][0] as { context: Record<string, unknown> }).context;

/** The multi-file input Mantine's FileButton renders for "Attach images". */
const fileInputEl = () =>
  vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    if (!el) throw new Error('file input not found');
    return el;
  });

const consentCheckbox = () =>
  page.getByRole('checkbox', { name: 'Attach a screenshot of this page' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.html2canvas.mockResolvedValue(canvasYielding(CAPTURED_JPEG));
  mocks.loadHtml2Canvas.mockResolvedValue(mocks.html2canvas);
  mocks.uploadToCF.mockImplementation(async (file: File) => ({
    url: `https://cf.example/${file.name}`,
    id: `cf-${file.name}`,
    objectUrl: `blob:${file.name}`,
    type: 'image',
  }));
});

describe('🔴 DOM capture never fires without explicit consent', () => {
  test('nothing is captured merely by opening the prompt', async () => {
    await openPrompt();

    await expect.element(consentCheckbox()).not.toBeChecked();
    expect(mocks.loadHtml2Canvas).not.toHaveBeenCalled();
    expect(mocks.html2canvas).not.toHaveBeenCalled();
  });

  test('a full submit with the checkbox untouched captures and uploads nothing', async () => {
    await openPrompt();
    await typeMessage();
    await send();

    // The three independent observables of "no capture happened": the renderer was
    // never loaded, no upload was attempted, and no id reached the payload.
    expect(mocks.loadHtml2Canvas).not.toHaveBeenCalled();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(submittedContext()).not.toHaveProperty('screenshotId');
  });

  test('typing does not start a capture', async () => {
    await openPrompt();
    await typeMessage('still typing');

    expect(mocks.loadHtml2Canvas).not.toHaveBeenCalled();
  });
});

describe('capture happens on consent, and the user sees it first', () => {
  test('checking the box captures once and shows a preview', async () => {
    await openPrompt();
    await userEvent.click(consentCheckbox());

    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .toBeInTheDocument();
    expect(mocks.loadHtml2Canvas).toHaveBeenCalledTimes(1);
    expect(mocks.html2canvas).toHaveBeenCalledTimes(1);
    // Preview only — the capture must not be uploaded before Send.
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
  });

  test('sending after consent uploads the capture and carries its id', async () => {
    await openPrompt();
    await typeMessage();
    await userEvent.click(consentCheckbox());
    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .toBeInTheDocument();
    await send();

    expect(mocks.uploadToCF).toHaveBeenCalledTimes(1);
    const uploaded = mocks.uploadToCF.mock.calls[0][0] as File;
    expect(uploaded.name).toBe('page-capture.jpg');
    expect(uploaded.type).toBe('image/jpeg');
    expect(submittedContext().screenshotId).toBe('cf-page-capture.jpg');
    // The caller's own context is preserved alongside it.
    expect(submittedContext().path).toBe('/images');
    expect(submittedContext().reportedSource).toBe('bitdex');
  });

  test('🔴 the user can drop the preview and still submit', async () => {
    await openPrompt();
    await typeMessage();
    await userEvent.click(consentCheckbox());
    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Remove the page screenshot' }));

    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .not.toBeInTheDocument();
    // Dropping the preview also clears consent — the control returns to its
    // off state rather than claiming a capture that no longer exists.
    await expect.element(consentCheckbox()).not.toBeChecked();

    await send();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
    expect(submittedContext()).not.toHaveProperty('screenshotId');
  });

  test('unchecking the box discards the capture', async () => {
    await openPrompt();
    await userEvent.click(consentCheckbox());
    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .toBeInTheDocument();

    await userEvent.click(consentCheckbox());

    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .not.toBeInTheDocument();
  });

  test('a failed capture surfaces an error and leaves the box unchecked', async () => {
    mocks.html2canvas.mockRejectedValue(new Error('render failed'));
    await openPrompt();

    await userEvent.click(consentCheckbox());

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1));
    expect(mocks.showErrorNotification.mock.calls[0][0]).toMatchObject({
      title: 'Could not capture the page',
    });
    await expect.element(consentCheckbox()).not.toBeChecked();
  });
});

describe('image attachments', () => {
  test('attaching a file previews it locally without uploading', async () => {
    await openPrompt();
    await userEvent.upload(await fileInputEl(), imageFile('one.png'));

    await expect.element(page.getByAltText('Attached image one.png')).toBeInTheDocument();
    await expect.element(page.getByText('1 of 3 attached')).toBeInTheDocument();
    expect(mocks.uploadToCF).not.toHaveBeenCalled();
  });

  test('sending uploads each attachment and carries the ids in order', async () => {
    await openPrompt();
    await typeMessage();
    await userEvent.upload(await fileInputEl(), [imageFile('one.png'), imageFile('two.png')]);
    await expect.element(page.getByAltText('Attached image two.png')).toBeInTheDocument();

    await send();

    expect(mocks.uploadToCF).toHaveBeenCalledTimes(2);
    expect(submittedContext().images).toEqual(['cf-one.png', 'cf-two.png']);
  });

  test('an attachment can be removed before sending', async () => {
    await openPrompt();
    await typeMessage();
    await userEvent.upload(await fileInputEl(), [imageFile('one.png'), imageFile('two.png')]);
    await expect.element(page.getByAltText('Attached image two.png')).toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Remove attached image one.png' }));
    await expect.element(page.getByAltText('Attached image one.png')).not.toBeInTheDocument();

    await send();
    expect(mocks.uploadToCF).toHaveBeenCalledTimes(1);
    expect(submittedContext().images).toEqual(['cf-two.png']);
  });

  test('the fourth file is refused and the cap is stated out loud', async () => {
    await openPrompt();
    await userEvent.upload(await fileInputEl(), [
      imageFile('one.png'),
      imageFile('two.png'),
      imageFile('three.png'),
      imageFile('four.png'),
    ]);

    await expect.element(page.getByText('3 of 3 attached')).toBeInTheDocument();
    await expect.element(page.getByAltText('Attached image four.png')).not.toBeInTheDocument();
    expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorNotification.mock.calls[0][0]).toMatchObject({
      title: 'Too many images',
    });
  });

  test('attachments and a consented capture travel together', async () => {
    await openPrompt();
    await typeMessage();
    await userEvent.upload(await fileInputEl(), imageFile('one.png'));
    await expect.element(page.getByAltText('Attached image one.png')).toBeInTheDocument();
    await userEvent.click(consentCheckbox());
    await expect
      .element(page.getByAltText('Preview of the page screenshot that will be sent'))
      .toBeInTheDocument();

    await send();

    expect(submittedContext().images).toEqual(['cf-one.png']);
    expect(submittedContext().screenshotId).toBe('cf-page-capture.jpg');
  });
});

describe('submitting without Faro (the dev/test/preview case)', () => {
  test('a submission succeeds and simply omits sessionId', async () => {
    // Faro is never initialised in the component harness, so this is the real
    // absence path rather than a simulated one.
    await openPrompt();
    await typeMessage();
    await send();

    expect(submittedContext()).not.toHaveProperty('sessionId');
    await expect.element(page.getByText(/Got it, thanks/)).toBeInTheDocument();
  });
});
