import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../test/component-setup';
import { DownloadImage } from '~/components/Image/DownloadImage';

/**
 * `DownloadImage`'s failure surface.
 *
 * The download XHR only resolved its blob promise on `readyState===4 && status===200`
 * and its outer handler was an empty `catch {}` — so EVERY transport fault read the
 * same silent way to the user: a hung spinner (completed non-200 never settled the
 * promise) or a dead button with no message (network/CORS rejections were swallowed).
 * Four support tickets in four days (72545/72611/72615/72684), all "I click download,
 * spinner, then nothing".
 *
 * Those four had a single ROOT CAUSE, fixed separately at the storage layer and not
 * here: `image.civitai.com` 301s to `blobs-b2.civitai.com`, a CROSS-ORIGIN redirect,
 * so the browser sends `Origin: null` on the second hop, and B2's rules on that bucket
 * matched any real https origin but not the literal `null` — no `Access-Control-Allow-
 * Origin`, request blocked. This file does NOT test that; it tests that whatever the
 * transport does, the user is told. The two are independent: the CORS fault is gone,
 * and the next transport fault will still find this surface.
 *
 * These tests pin: a completed non-200 REJECTS and toasts (no infinite spinner), a
 * network error TOASTS instead of vanishing into the empty catch, and the success
 * path stays silent (guard against over-toasting). The XHR is stubbed because the
 * fault modes are transport states a test cannot produce against a real endpoint.
 */

const mocks = vi.hoisted(() => ({
  status: 200,
  networkError: false,
  showErrorNotification: vi.fn(),
}));

const DOWNLOAD_URL = 'https://example.com/file/test-file.png';

vi.mock(
  '~/utils/notifications',
  async (importOriginal) =>
    ({
      ...(await importOriginal<Record<string, unknown>>()),
      showErrorNotification: mocks.showErrorNotification,
    } as Record<string, unknown>)
);

vi.mock('~/client-utils/cf-images-utils', () => ({
  useEdgeUrl: () => ({ url: DOWNLOAD_URL }),
}));

/**
 * Minimal XHR stand-in: records listeners, then plays the scripted transport outcome
 * on `send()` — a network error event, or a completed (`readyState 4`) response with
 * the mocked status. `response` is always a Blob, which is what `responseType='blob'`
 * yields on a real 200.
 */
class FakeXhr {
  readyState = 0;
  status = 0;
  response = new Blob(['file-data'], { type: 'image/png' });
  responseType = '';
  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  open() {
    this.readyState = 1;
  }

  send() {
    this.readyState = 4;
    if (mocks.networkError) {
      this.dispatch('error', new Event('error'));
      return;
    }
    this.status = mocks.status;
    this.dispatch('progress', { loaded: 100, total: 100 });
    this.dispatch('loadend', new Event('loadend'));
  }

  private dispatch(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function renderDownload() {
  return renderWithProviders(
    <DownloadImage src={LOADABLE_IMAGE_DATA_URI} name="test-file.png">
      {({ onClick, isLoading }) => (
        <button onClick={onClick} disabled={isLoading}>
          {isLoading ? 'downloading' : 'download'}
        </button>
      )}
    </DownloadImage>
  );
}

// `exact: true` — locator name-matching is substring, so the bare name would also
// match the "downloading" state and every reset assertion below would pass vacuously.
const downloadButton = () => page.getByRole('button', { name: 'download', exact: true });

const loadingButton = () => page.getByRole('button', { name: 'downloading' });

describe('DownloadImage failure surface', () => {
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.status = 200;
    mocks.networkError = false;
    mocks.showErrorNotification.mockClear();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    // The success path creates a blob: anchor and clicks it — intercept the click so
    // the test does not navigate, and so the success arm can assert it fired.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  test('a completed non-200 response toasts an error and stops the spinner', async () => {
    mocks.status = 403;
    renderDownload();
    await userEvent.click(downloadButton());

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    // Loading reset — the pre-fix behavior was a promise that never settled, so this
    // never reached the reset timeout and the spinner hung forever.
    await expect.element(downloadButton(), { timeout: 3000 }).toBeInTheDocument();
    await vi.waitFor(() => expect(loadingButton().query()).toBeNull(), { timeout: 3000 });
  });

  test('a network error toasts instead of being swallowed by the empty catch', async () => {
    mocks.networkError = true;
    renderDownload();
    await userEvent.click(downloadButton());

    await vi.waitFor(() => expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await expect.element(downloadButton(), { timeout: 3000 }).toBeInTheDocument();
    await vi.waitFor(() => expect(loadingButton().query()).toBeNull(), { timeout: 3000 });
  });

  test('a successful download stays silent and still triggers the anchor click', async () => {
    renderDownload();
    await userEvent.click(downloadButton());

    await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mocks.showErrorNotification).not.toHaveBeenCalled();
    await expect.element(downloadButton(), { timeout: 3000 }).toBeInTheDocument();
  });
});
