import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PreviewFrameMod from '~/components/Apps/AppAssistant/previewFrame';
import type { PreviewFrame } from '~/components/Apps/AppAssistant/previewFrame';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const HOST = 'dev-0123456789abcdef.apps.example';
const FRAME: PreviewFrame = {
  appBlockId: 'ephemeral-my-app',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  appName: 'My App',
  trustTier: 'unverified',
  sandbox: 'allow-scripts',
  scopes: [],
  bootSkeleton: false,
  host: HOST,
  iframeSrc: `https://${HOST}/?dev=entry-token`,
  dnsPending: false,
};
const SESSION = { blockId: 'my-app', sessionId: 'bki_1', host: HOST };

const m = vi.hoisted(() => ({
  fetchFrame: vi.fn(),
  fetchEntryUrl: vi.fn(),
  gate: null as null | { blockId: string; onSettled: () => void },
  /** The mounted frame host's reload callback (latest render). */
  onGuestReloaded: null as null | (() => void),
  /** The mounted frame host's Retry URL source (latest render). */
  refreshEntryUrl: null as null | (() => Promise<string>),
  /** Times a DevTunnelBlockHost MOUNTED — a remount is what resets the page host's handshake. */
  frameMounts: 0,
}));

vi.mock('~/components/Apps/AppAssistant/previewFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewFrameMod>()),
  fetchPreviewFrame: m.fetchFrame,
  fetchPreviewEntryUrl: m.fetchEntryUrl,
}));
vi.mock('~/components/AppBlocks/DevTunnelBlockHost', async () => {
  const { useEffect } = await import('react');
  return {
    DevTunnelBlockHost: ({
      iframeSrc,
      onGuestReloaded,
      refreshEntryUrl,
    }: {
      iframeSrc: string;
      onGuestReloaded?: () => void;
      refreshEntryUrl?: () => Promise<string>;
    }) => {
      m.onGuestReloaded = onGuestReloaded ?? null;
      m.refreshEntryUrl = refreshEntryUrl ?? null;
      useEffect(() => {
        m.frameMounts += 1;
      }, []);
      return <div data-testid="frame" data-src={iframeSrc} />;
    },
  };
});
vi.mock('~/components/AppBlocks/DevTunnelDnsGate', () => ({
  DevTunnelDnsGate: (props: NonNullable<typeof m.gate>) => {
    m.gate = props;
    return <div data-testid="dns-gate" />;
  },
}));

const { AppAssistantPreview } = await import('./AppAssistantPreview');

beforeEach(() => {
  m.gate = null;
  m.onGuestReloaded = null;
  m.refreshEntryUrl = null;
  m.frameMounts = 0;
  m.fetchFrame.mockReset();
  m.fetchEntryUrl.mockReset();
});

describe('AppAssistantPreview — a preview whose host is not resolvable yet', () => {
  test('shows the gate for the session’s app and mounts no frame', async () => {
    m.fetchFrame.mockResolvedValue({ preparing: true });
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);

    // Wait for whichever of the two rendered, so a framed app fails on the line that names it.
    const gate = page.getByTestId('dns-gate');
    const frame = page.getByTestId('frame');
    await vi.waitFor(() => expect(gate.query() ?? frame.query()).not.toBeNull());
    expect(frame.query(), 'the app was framed before its host resolved').toBeNull();
    await expect.element(gate).toBeInTheDocument();
    expect(m.gate!.blockId).toBe('my-app');
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
  });

  test('mounts the frame, with a freshly fetched entry URL, once the gate settles', async () => {
    m.fetchFrame.mockResolvedValueOnce({ preparing: true }).mockResolvedValue(FRAME);
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();

    m.gate!.onSettled();
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(page.getByTestId('dns-gate').query()).toBeNull();
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
  });

  test('keeps the gate, and still no frame, when the server is not ready after all', async () => {
    m.fetchFrame.mockResolvedValue({ preparing: true });
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();

    m.gate!.onSettled();
    await vi.waitFor(() => expect(m.fetchFrame).toHaveBeenCalledTimes(2));
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    expect(page.getByTestId('frame').query()).toBeNull();
  });

  test('CONTROL: a resolvable preview mounts its frame straight away, with no gate', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.gate).toBeNull();
  });
});

describe('AppAssistantPreview — a preview the server runner started', () => {
  const RUNNER = { blockId: 'my-app', sessionId: null, host: HOST, view: 1 };

  test('fetches the block’s frame with no tunnel id, and a fresh one for each new start', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    const screen = await renderWithProviders(<AppAssistantPreview canPreview session={RUNNER} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
    expect(m.fetchFrame).toHaveBeenLastCalledWith('my-app');

    const fresh = { ...FRAME, iframeSrc: `https://${HOST}/?dev=entry-token-2` };
    m.fetchFrame.mockResolvedValue(fresh);
    screen.rerender(<AppAssistantPreview canPreview session={{ ...RUNNER, view: 2 }} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', fresh.iframeSrc);
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
  });

  test('CONTROL: the same start rendered again fetches nothing new', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    const screen = await renderWithProviders(<AppAssistantPreview canPreview session={RUNNER} />);
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    screen.rerender(<AppAssistantPreview canPreview session={{ ...RUNNER }} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
  });
});

/**
 * The preview's `app.storage` lives only in that tab (the SDK's local-preview store), so
 * whatever the app saves there is gone on any reload. The pane says so beside its caption,
 * and only while a preview is shown. The whole sentence is pinned on purpose: a reword
 * should fail here and be reviewed.
 */
describe('AppAssistantPreview — the note that preview data resets on reload', () => {
  const NOTE = 'Data saved in the preview resets when it reloads.';

  test('shows the note beside the caption while a preview is shown', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    await expect.element(page.getByText(NOTE, { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('New previews can take a minute to appear.', { exact: true }))
      .toBeInTheDocument();
  });

  test('shows no note when no preview is live on the server runner', async () => {
    const restart = { onRestart: () => undefined, pending: false, error: null };
    await renderWithProviders(<AppAssistantPreview canPreview session={null} restart={restart} />);
    await expect.element(page.getByTestId('preview-restart')).toBeInTheDocument();
    expect(page.getByText(NOTE).query()).toBeNull();
  });

  test('shows no note when live preview is not enabled for the account', async () => {
    await renderWithProviders(<AppAssistantPreview canPreview={false} session={SESSION} />);
    await expect
      .element(page.getByText('Live preview isn’t enabled for your account yet.', { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText(NOTE).query()).toBeNull();
  });
});

/**
 * 🔴 REGRESSION (live reload). Vite reloads the app INSIDE the frame on an edit. The
 * page host reports that (`onGuestReloaded`, dev-tunnel only — see PageBlockHost) and
 * the preview answers with the manual Reload's own path: fetch a fresh entry URL, whose
 * new `iframeSrc` key remounts the host. Before the fix the preview passed no callback,
 * so the first test below is red.
 */
describe('AppAssistantPreview — the app reloaded itself in the frame', () => {
  const FRESH = { ...FRAME, iframeSrc: `https://${HOST}/?dev=entry-token-2` };

  async function mountReady() {
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.frameMounts).toBe(1);
    expect(m.onGuestReloaded, 'the preview gave the host no way to report a reload').toBeTypeOf(
      'function'
    );
  }

  test('fetches one fresh entry URL and remounts the frame host with it', async () => {
    m.fetchFrame.mockResolvedValueOnce(FRAME).mockResolvedValueOnce(FRESH);
    await mountReady();

    m.onGuestReloaded!();
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRESH.iframeSrc);
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
    expect(m.frameMounts).toBe(2);
  });

  test('a burst of reload reports fetches once', async () => {
    let resolveFresh: (v: unknown) => void = () => undefined;
    m.fetchFrame
      .mockResolvedValueOnce(FRAME)
      .mockReturnValueOnce(new Promise((r) => (resolveFresh = r)))
      .mockResolvedValue(FRAME);
    await mountReady();

    const report = m.onGuestReloaded!;
    report();
    report();
    report();
    resolveFresh(FRESH);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRESH.iframeSrc);
    await new Promise((r) => setTimeout(r, 50));
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
    expect(m.frameMounts).toBe(2);
  });

  test('a failed fresh mint shows the existing error, mounts no frame, and does not retry', async () => {
    m.fetchFrame
      .mockResolvedValueOnce(FRAME)
      .mockRejectedValueOnce(new Error('The preview is unavailable right now'));
    await mountReady();

    m.onGuestReloaded!();
    await expect
      .element(page.getByText('The preview is unavailable right now'))
      .toBeInTheDocument();
    expect(page.getByTestId('frame').query()).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
  });
});

/**
 * The frame's own Retry (a load that timed out or failed) needs a fresh entry URL too: the one the
 * pane fetched expires minutes later, and the edge refuses it after that. Unlike a reload it must
 * NOT remount the host — the host's bounded auto-retry budget lives in that mount — so the pane
 * hands the host a fetcher instead of refetching its own query. Before the fix the pane passed
 * none, so the first test below is red.
 */
describe('AppAssistantPreview — the frame retries a failed load', () => {
  const FRESH_SRC = `https://${HOST}/?dev=entry-token-retry`;

  test('gives the host a fetcher for a fresh entry URL of the session’s app', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    m.fetchEntryUrl.mockResolvedValue(FRESH_SRC);
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.refreshEntryUrl, 'the preview gave the host no fresh URL for a Retry').toBeTypeOf(
      'function'
    );

    await expect(m.refreshEntryUrl!()).resolves.toBe(FRESH_SRC);
    expect(m.fetchEntryUrl).toHaveBeenCalledTimes(1);
    expect(m.fetchEntryUrl).toHaveBeenLastCalledWith('my-app');
  });

  test('fetching it neither refetches the pane’s frame nor remounts the host', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    m.fetchEntryUrl.mockResolvedValue(FRESH_SRC);
    await renderWithProviders(<AppAssistantPreview canPreview session={SESSION} />);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.frameMounts).toBe(1);

    await m.refreshEntryUrl?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
    expect(m.frameMounts).toBe(1);
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
  });
});
