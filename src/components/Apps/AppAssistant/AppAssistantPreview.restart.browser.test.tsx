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
}));

vi.mock('~/components/Apps/AppAssistant/previewFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewFrameMod>()),
  fetchPreviewFrame: m.fetchFrame,
}));
vi.mock('~/components/AppBlocks/DevTunnelBlockHost', () => ({
  DevTunnelBlockHost: (props: {
    iframeSrc: string;
    onFallbackChange?: (reason: string | null) => void;
  }) => {
    m.host = props;
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
    const tunnelStatus = vi.fn(async () => ({
      running: true,
      host: 'dev-0f0f0f0f0f0f0f0f.apps.example',
    }));
    await renderShown(tunnelStatus);
    // Asked on the first check after load, with no need for the tab to come back.
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
    const tunnelStatus = vi.fn(async () => null);
    await renderShown(tunnelStatus);
    await tabComesBack();
    await settle();
    // Control: the sandbox was asked.
    expect(tunnelStatus).toHaveBeenCalled();
    expect(page.getByTestId('frame').elements()).toHaveLength(1);
    expect(page.getByText('The live preview isn’t running.').elements()).toHaveLength(0);
  });
});
