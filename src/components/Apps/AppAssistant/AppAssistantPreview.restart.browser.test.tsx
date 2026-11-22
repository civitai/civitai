import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PreviewFrameMod from '~/components/Apps/AppAssistant/previewFrame';
import type { PreviewFrame } from '~/components/Apps/AppAssistant/previewFrame';
import type { SandboxTunnelStatus } from '~/components/Apps/AppAssistant/previewTunnelStatus';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const HOST = 'dev-a1b2c3d4e5f60718.apps.example';
const FRAME: PreviewFrame = {
  appBlockId: 'ephemeral-shop',
  blockId: 'shop',
  appId: 'appblk-shop',
  appName: 'Shop',
  trustTier: 'unverified',
  sandbox: 'allow-scripts',
  scopes: [],
  bootSkeleton: false,
  host: HOST,
  iframeSrc: `https://${HOST}/?dev=entry-token-restart`,
  dnsPending: false,
};
const RUNNER_SESSION = { blockId: 'shop', sessionId: null, host: HOST, view: 1 };
const RATE_LIMITED =
  'Too many previews were started in the last hour. Wait a few minutes, then try again.';

const m = vi.hoisted(() => ({
  fetchFrame: vi.fn(),
  /** What the frame's host reports of its terminal fallback, as the page host would. */
  host: null as null | { onFallbackChange?: (reason: string | null) => void },
  /** The host's entry token failed: it shows the pane's `tokenErrorFallback` instead of the frame. */
  tokenError: false,
}));

vi.mock('~/components/Apps/AppAssistant/previewFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewFrameMod>()),
  fetchPreviewFrame: m.fetchFrame,
}));
vi.mock('~/components/AppBlocks/DevTunnelBlockHost', () => ({
  DevTunnelBlockHost: (props: {
    iframeSrc: string;
    onFallbackChange?: (reason: string | null) => void;
    tokenErrorFallback?: React.ReactNode;
  }) => {
    m.host = props;
    if (m.tokenError) return <>{props.tokenErrorFallback}</>;
    return <div data-testid="frame" data-src={props.iframeSrc} />;
  },
}));
vi.mock('~/components/AppBlocks/DevTunnelDnsGate', () => ({
  DevTunnelDnsGate: () => <div data-testid="dns-gate" />,
}));

const { AppAssistantPreview } = await import('./AppAssistantPreview');
// The real error class (the module mock keeps every export but the fetch).
const { PreviewGoneError } = await import('~/components/Apps/AppAssistant/previewFrame');

const restartButton = () => page.getByRole('button', { name: 'Restart preview' });
const offer = (error: string | null = null, pending = false) => ({
  onRestart: vi.fn(),
  pending,
  error,
});

beforeEach(() => {
  m.host = null;
  m.tokenError = false;
  m.fetchFrame.mockReset();
});

describe('AppAssistantPreview — Restart preview on the server runner', () => {
  test('with no live preview, offers Restart preview, which asks once per click', async () => {
    const restart = offer();
    await renderWithProviders(<AppAssistantPreview canPreview session={null} restart={restart} />);
    await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();
    await restartButton().click();
    expect(restart.onRestart).toHaveBeenCalledTimes(1);
    // Nothing is framed and no frame is fetched without a preview.
    expect(m.fetchFrame).not.toHaveBeenCalled();
  });

  test('says why the last restart failed, in the runner’s own words', async () => {
    await renderWithProviders(
      <AppAssistantPreview canPreview session={null} restart={offer(RATE_LIMITED)} />
    );
    await expect.element(page.getByRole('alert')).toHaveTextContent(RATE_LIMITED);
  });

  test('a frame that falls back (never ready) offers Restart preview; one that recovers takes it away', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    await renderWithProviders(
      <AppAssistantPreview canPreview session={RUNNER_SESSION} restart={offer()} />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    // Control: a frame that loads offers nothing.
    expect(restartButton().query()).toBeNull();

    m.host!.onFallbackChange!('timeout');
    await expect.element(page.getByText('The preview isn’t loading.')).toBeInTheDocument();
    await expect.element(restartButton()).toBeInTheDocument();

    m.host!.onFallbackChange!(null);
    await expect.element(restartButton()).not.toBeInTheDocument();
  });

  test('a listed preview whose frame cannot be had offers Restart preview beside why', async () => {
    m.fetchFrame.mockRejectedValue(new Error('No live preview is running for this app'));
    await renderWithProviders(
      <AppAssistantPreview canPreview session={RUNNER_SESSION} restart={offer()} />
    );
    await expect
      .element(page.getByText('No live preview is running for this app'))
      .toBeInTheDocument();
    await expect.element(restartButton()).toBeInTheDocument();
  });

  test('NEGATIVE CONTROL: replies in the browser are offered no Restart preview', async () => {
    m.fetchFrame.mockResolvedValue(FRAME);
    await renderWithProviders(<AppAssistantPreview canPreview session={RUNNER_SESSION} />);
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    m.host!.onFallbackChange?.('timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restartButton().query()).toBeNull();
  });
});

describe('AppAssistantPreview — a shown preview whose tunnel went', () => {
  const LIVE_CHECK_MS = 40;
  const settle = () => new Promise((resolve) => setTimeout(resolve, LIVE_CHECK_MS * 5));

  test('turns into “The live preview isn’t running.” with Restart preview once civitai has no tunnel', async () => {
    let gone = false;
    m.fetchFrame.mockImplementation(async () => {
      if (gone) throw new PreviewGoneError('No live preview is running for this app');
      return FRAME;
    });
    const restart = offer();
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={restart}
        liveCheckMs={LIVE_CHECK_MS}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    // Control: checked while live, and still shown.
    await settle();
    expect(m.fetchFrame.mock.calls.length).toBeGreaterThan(1);
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);

    gone = true;
    await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();
    expect(page.getByTestId('frame').elements()).toHaveLength(0);
    await restartButton().click();
    expect(restart.onRestart).toHaveBeenCalledTimes(1);
  });

  test('a check that fails for any other reason leaves the preview shown', async () => {
    let failing = false;
    m.fetchFrame.mockImplementation(async () => {
      if (failing) throw new Error('network down');
      return FRAME;
    });
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={offer()}
        liveCheckMs={LIVE_CHECK_MS}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    failing = true;
    const before = m.fetchFrame.mock.calls.length;
    await settle();
    // Control: it was checked meanwhile.
    expect(m.fetchFrame.mock.calls.length).toBeGreaterThan(before);
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
  });
});

describe('AppAssistantPreview — asking the app’s sandbox when the tab comes back', () => {
  const LIVE_CHECK_MS = 40;
  const settle = () => new Promise((resolve) => setTimeout(resolve, LIVE_CHECK_MS * 5));
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  };
  /** The user leaves the tab and comes back to it. */
  const tabComesBack = async () => {
    setVisibility('hidden');
    await settle();
    setVisibility('visible');
  };
  afterEach(() => {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  });

  const renderShown = async (tunnelStatus: () => Promise<SandboxTunnelStatus | null>) => {
    m.fetchFrame.mockImplementation(async () => FRAME);
    const restart = offer();
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={restart}
        liveCheckMs={LIVE_CHECK_MS}
        tunnelStatus={tunnelStatus}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    return restart;
  };

  test('asks the sandbox on the first check, then only when the tab comes back; its “down” stands', async () => {
    let answer: SandboxTunnelStatus = { running: true, host: HOST };
    const tunnelStatus = vi.fn(async () => answer);
    const restart = await renderShown(tunnelStatus);
    await settle();
    // Control: asked once (the first check after load), and not again on the interval — every ask
    // counts as activity for the app's idle clock — while civitai is checked on.
    expect(m.fetchFrame.mock.calls.length).toBeGreaterThan(2);
    expect(tunnelStatus).toHaveBeenCalledTimes(1);
    expect(page.getByTestId('frame').elements()).toHaveLength(1);

    answer = { running: false, host: null };
    await tabComesBack();
    await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();
    expect(tunnelStatus).toHaveBeenCalledTimes(2);
    // civitai still lists the tunnel on every later check: the sandbox's answer stands.
    await settle();
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(1);
    expect(page.getByTestId('frame').elements()).toHaveLength(0);
    await restartButton().click();
    expect(restart.onRestart).toHaveBeenCalledTimes(1);
  });

  test('turns into “isn’t running” when the sandbox’s tunnel runs to another host than civitai’s', async () => {
    let answer: SandboxTunnelStatus = { running: true, host: HOST };
    const tunnelStatus = vi.fn(async () => answer);
    await renderShown(tunnelStatus);
    await vi.waitFor(() => expect(tunnelStatus).toHaveBeenCalledTimes(1));
    answer = { running: true, host: 'dev-0f0f0f0f0f0f0f0f.apps.example' };
    await tabComesBack();
    await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();
    await settle();
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(1);
  });

  test('stays shown when the sandbox runs to the same host', async () => {
    const tunnelStatus = vi.fn(async () => ({ running: true, host: HOST }));
    await renderShown(tunnelStatus);
    await tabComesBack();
    await settle();
    // Control: the sandbox was asked.
    expect(tunnelStatus).toHaveBeenCalled();
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
  });

  test('stays shown when the sandbox cannot be reached: no answer is not “down”', async () => {
    let answer: SandboxTunnelStatus | null = { running: true, host: HOST };
    const tunnelStatus = vi.fn(async () => answer);
    await renderShown(tunnelStatus);
    await vi.waitFor(() => expect(tunnelStatus).toHaveBeenCalledTimes(1));
    answer = null;
    await tabComesBack();
    // Control: the sandbox was asked again, and would not say.
    await vi.waitFor(() => expect(tunnelStatus).toHaveBeenCalledTimes(2));
    await settle();
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
  });
});

/**
 * A direct preview (design R1-1): no tunnel, so the sandbox's `tunnel_status` always says "not
 * running" (there is no ssh child). Asking it would end every direct preview at its first check;
 * the pane asks the sandbox's dev server instead, and civitai's record (with `check=1`) as before.
 */
describe('AppAssistantPreview — a shown direct preview', () => {
  const LIVE_CHECK_MS = 40;
  const settle = () => new Promise((resolve) => setTimeout(resolve, LIVE_CHECK_MS * 5));
  const SESSION_HOST =
    'sckpynuebrbgh2zm2f7vkbrk22akqcaqdaqcwv7vmqcbzawxned4cvl4enkzes.preview.example';
  const DIRECT: PreviewFrame = {
    ...FRAME,
    host: SESSION_HOST,
    iframeSrc: `https://${SESSION_HOST}/`,
    transport: 'direct',
  };
  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  };
  const tabComesBack = async () => {
    setVisibility('hidden');
    await settle();
    setVisibility('visible');
  };
  afterEach(() => {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
  });

  const renderDirect = async (devServerStatus: () => Promise<{ running: boolean } | null>) => {
    m.fetchFrame.mockImplementation(async () => DIRECT);
    // What a direct preview's sandbox says of its (absent) tunnel.
    const tunnelStatus = vi.fn(async () => ({ running: false, host: null }));
    const restart = offer();
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={restart}
        liveCheckMs={LIVE_CHECK_MS}
        tunnelStatus={tunnelStatus}
        devServerStatus={devServerStatus}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    return { restart, tunnelStatus };
  };

  test('🔴 stays shown across many checks while its dev server runs; the tunnel is never asked', async () => {
    const devServerStatus = vi.fn(async () => ({ running: true }));
    const { tunnelStatus } = await renderDirect(devServerStatus);
    await settle();
    await tabComesBack();
    await settle();
    // Control: civitai was checked on the interval, and the sandbox asked on the first check and
    // again when the tab came back.
    expect(m.fetchFrame.mock.calls.length).toBeGreaterThan(3);
    await vi.waitFor(() => expect(devServerStatus).toHaveBeenCalledTimes(2));
    expect(tunnelStatus).not.toHaveBeenCalled();
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByTestId('preview-restart').elements()).toHaveLength(0);
    // Every check after the mount is a liveness check (`check=1`), which moves no idle clock.
    const [mount, ...checks] = m.fetchFrame.mock.calls;
    expect(mount[2]).toBeUndefined();
    expect(checks.every((call) => call[2]?.check === true)).toBe(true);
  });

  test('turns into “isn’t running” with Restart preview once its dev server stops, and that stands', async () => {
    let answer = { running: true };
    const devServerStatus = vi.fn(async () => answer);
    const { restart } = await renderDirect(devServerStatus);
    await vi.waitFor(() => expect(devServerStatus).toHaveBeenCalledTimes(1));
    answer = { running: false };
    await tabComesBack();
    await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();
    await settle();
    expect(page.getByTestId('frame').elements()).toHaveLength(0);
    await restartButton().click();
    expect(restart.onRestart).toHaveBeenCalledTimes(1);
  });

  // A direct preview's session host is a bearer credential: if the session handed to the pane names
  // one (the runner's start_preview output, say), the pane tells the page to drop it.
  test('🔴 reports a direct frame whose session still names a host, once', async () => {
    m.fetchFrame.mockImplementation(async () => DIRECT);
    const onDirectFrame = vi.fn();
    const session = { ...RUNNER_SESSION, host: SESSION_HOST };
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={session}
        restart={offer()}
        onDirectFrame={onDirectFrame}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    await vi.waitFor(() => expect(onDirectFrame).toHaveBeenCalledWith(session));
    await settle();
    expect(onDirectFrame).toHaveBeenCalledTimes(1);
  });

  test('NEGATIVE CONTROL: a tunnel frame is never reported', async () => {
    m.fetchFrame.mockImplementation(async () => FRAME);
    const onDirectFrame = vi.fn();
    await renderWithProviders(
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={offer()}
        onDirectFrame={onDirectFrame}
      />
    );
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    await settle();
    expect(onDirectFrame).not.toHaveBeenCalled();
  });

  /**
   * The assistant restarts the dev server while it builds. A check that lands in that window reads
   * "down"; the dev server coming back up (`devServerUp`) must end it, as there is no tunnel to lose.
   */
  describe('a “down” read while the dev server restarts', () => {
    const shown = (
      status: {
        tunnelStatus?: () => Promise<SandboxTunnelStatus | null>;
        devServerStatus?: () => Promise<{ running: boolean } | null>;
      },
      devServerUp: number,
      restart: ReturnType<typeof offer>
    ) => (
      <AppAssistantPreview
        canPreview
        session={RUNNER_SESSION}
        restart={restart}
        liveCheckMs={LIVE_CHECK_MS}
        devServerUp={devServerUp}
        {...status}
      />
    );

    test('🔴 a direct preview shows again, with no click, once the dev server is back up', async () => {
      m.fetchFrame.mockImplementation(async () => DIRECT);
      let answer = { running: true };
      const status = { devServerStatus: vi.fn(async () => answer) };
      const restart = offer();
      const screen = await renderWithProviders(shown(status, 0, restart));
      await expect.element(page.getByTestId('frame')).toBeInTheDocument();
      await vi.waitFor(() => expect(status.devServerStatus).toHaveBeenCalledTimes(1));
      answer = { running: false };
      await tabComesBack();
      await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();

      answer = { running: true };
      await screen.rerender(shown(status, 1, restart));
      await expect.element(page.getByTestId('frame')).toBeInTheDocument();
      await settle();
      expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
      expect(restart.onRestart).not.toHaveBeenCalled();
    });

    test('NEGATIVE CONTROL: a tunnel’s “down” still stands when the dev server comes back up', async () => {
      m.fetchFrame.mockImplementation(async () => FRAME);
      let answer: SandboxTunnelStatus = { running: true, host: HOST };
      const status = { tunnelStatus: vi.fn(async () => answer) };
      const restart = offer();
      const screen = await renderWithProviders(shown(status, 0, restart));
      await expect.element(page.getByTestId('frame')).toBeInTheDocument();
      await vi.waitFor(() => expect(status.tunnelStatus).toHaveBeenCalledTimes(1));
      answer = { running: false, host: null };
      await tabComesBack();
      await expect.element(page.getByText('The live preview isn’t running.')).toBeInTheDocument();

      await screen.rerender(shown(status, 1, restart));
      await settle();
      expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(1);
      expect(page.getByTestId('frame').elements()).toHaveLength(0);
    });
  });

  test('stays shown when the sandbox would not say: no answer is not “down”', async () => {
    const devServerStatus = vi.fn(async () => null);
    await renderDirect(devServerStatus);
    await vi.waitFor(() => expect(devServerStatus).toHaveBeenCalledTimes(1));
    await settle();
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
  });
});

describe('AppAssistantPreview — a failed frame when the dev server comes back up', () => {
  // The page learns of a restart only through `devServerUp` (counted by the workspace).
  const RELOADED: PreviewFrame = { ...FRAME, iframeSrc: `https://${HOST}/?dev=entry-token-second` };
  const frameSrc = () => page.getByTestId('frame').element().getAttribute('data-src');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const shown = (devServerUp: number) => (
    <AppAssistantPreview
      canPreview
      session={RUNNER_SESSION}
      restart={offer()}
      devServerUp={devServerUp}
    />
  );
  const renderShown = async (devServerUp = 3) => {
    m.fetchFrame.mockResolvedValueOnce(FRAME).mockResolvedValue(RELOADED);
    const screen = await renderWithProviders(shown(devServerUp));
    await expect.element(page.getByTestId('frame')).toBeInTheDocument();
    expect(frameSrc()).toBe(FRAME.iframeSrc);
    return screen;
  };

  test('🔴 a frame in its fallback reloads, as Reload would: a fresh entry URL, a fresh host', async () => {
    const screen = await renderShown();
    m.host!.onFallbackChange!('timeout');
    await expect.element(page.getByText('The preview isn’t loading.')).toBeInTheDocument();

    await screen.rerender(shown(4));
    await vi.waitFor(() => expect(frameSrc()).toBe(RELOADED.iframeSrc));
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
    // The fresh host has not failed: the offer goes.
    await expect.element(page.getByText('The preview isn’t loading.')).not.toBeInTheDocument();
  });

  test('🔴 a frame whose entry token failed reloads too', async () => {
    const screen = await renderShown();
    m.tokenError = true;
    await screen.rerender(shown(3));
    await expect
      .element(page.getByText('The preview couldn’t sign in to your app.', { exact: false }))
      .toBeInTheDocument();

    // The host still shows its failure when the dev server comes back up.
    await screen.rerender(shown(4));
    await vi.waitFor(() => expect(m.fetchFrame).toHaveBeenCalledTimes(2));
    m.tokenError = false;
    await screen.rerender(shown(4));
    await vi.waitFor(() => expect(frameSrc()).toBe(RELOADED.iframeSrc));
  });

  test('NEGATIVE CONTROL: a frame that loads is left alone (a reload resets its saved data)', async () => {
    const screen = await renderShown();
    await screen.rerender(shown(4));
    await settle();
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
    expect(frameSrc()).toBe(FRAME.iframeSrc);

    // Control: the same frame, once failed, reloads on the next one.
    m.host!.onFallbackChange!('timeout');
    await expect.element(page.getByText('The preview isn’t loading.')).toBeInTheDocument();
    await screen.rerender(shown(5));
    await vi.waitFor(() => expect(frameSrc()).toBe(RELOADED.iframeSrc));
  });

  test('NEGATIVE CONTROL: a failed frame re-rendered with no new dev server start stays as it is', async () => {
    const screen = await renderShown();
    m.host!.onFallbackChange!('timeout');
    await expect.element(page.getByText('The preview isn’t loading.')).toBeInTheDocument();
    await screen.rerender(shown(3));
    // A lower count is no new start either.
    await screen.rerender(shown(2));
    await settle();
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);
    expect(frameSrc()).toBe(FRAME.iframeSrc);

    // Control: a higher count, in the same frame, does reload it.
    await screen.rerender(shown(4));
    await vi.waitFor(() => expect(frameSrc()).toBe(RELOADED.iframeSrc));
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
  });
});
