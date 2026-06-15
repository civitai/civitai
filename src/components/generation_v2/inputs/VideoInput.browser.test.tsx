import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// tRPC MOCK PATTERN — the reusable template for data-driven component tests
// =============================================================================
//
// VideoInput is the FIRST data-driven (tRPC-backed) generation input we test.
// The component-setup scaffold deliberately does NOT wire a tRPC provider; a
// real `trpc.*.useQuery` would try to reach a QueryClient/transport that isn't
// there. Instead we replace the `trpc` proxy module with a vi.fn()-backed stub
// and drive each test's loading / success / error / gated state by hand.
//
// HOW TO COPY THIS FOR THE NEXT DATA-DRIVEN INPUT:
//   1. vi.mock('~/utils/trpc', ...) with EVERY `trpc.*` the component-under-test
//      accesses — procedures AND `useUtils()`/`useContext()`/`.useMutation()`.
//      An uncovered access is silently `undefined` here but THROWS in the real
//      app, so grep the component for `trpc.` and cover all of it. Keep it
//      minimal — VideoInput calls exactly `trpc.orchestrator.getVideoMetadata.useQuery`.
//   2. vi.mock must be HOISTED above imports (Vitest hoists vi.mock calls, but
//      the factory must be self-contained — it may NOT reference outer-scope
//      vars that aren't hoisted, hence we build the object inline).
//   3. Import the mocked `trpc` AFTER the vi.mock call, then per-test:
//        vi.mocked(trpc.orchestrator.getVideoMetadata.useQuery)
//          .mockReturnValue({ data, isLoading, error } as any)
//      The `as any` keeps us from re-declaring tRPC's full UseQueryResult.
//   4. Reset mocks in beforeEach so call-arg assertions (the `enabled` gating
//      checks below) see only the current render's calls. NOTE: `useQuery` is
//      called multiple times per render (re-renders), so reading `.mock.calls
//      .at(-1)` is only safe when the asserted option is render-STABLE (here
//      `enabled` derives from the url, so it's identical across calls). If a
//      component's query options change across re-renders, assert across all
//      calls instead of the last.
//   5. Feed `data` shaped like the procedure's REAL output (don't under-specify
//      — the `as any` won't catch a missing/typo'd field). See `queryResult`.
//
// We also mock two NON-tRPC modules that would otherwise block rendering in
// browser mode (each justified inline):
//   - `~/utils/media-preprocessors` (getVideoData): the real impl creates a
//     <video> element and waits on loadeddata/loadedmetadata that never fire in
//     test (no real media) -> a 10s timeout reject. We stub it to resolve fast
//     with deterministic dimensions so the success-path effect can run.
//   - `~/components/EdgeMedia/EdgeVideo` (EdgeVideo): heavy dep tree (scroll-area
//     context, dialog store, edge-url, scss). When a video URL is present the
//     preview renders it; a thin stub keeps the test about VideoInput's own
//     data-driven render (the FPS/dimension/error overlays), not EdgeVideo.
// isOrchestratorUrl is a PURE url-regex util (no deps) — we drive it with real
// orchestrator vs non-orchestrator URLs rather than mocking it, so the
// enabled-gating teeth exercise the actual gate.
//
// NOTE: we do NOT mock Mantine here. The no-video branch renders a real
// @mantine/dropzone — which used to crash in browser mode via a second React
// copy on a cold optimizeDeps cache. That's fixed at the scaffold level by
// `resolve.dedupe: ['react','react-dom']` (vitest.config.mts, component
// project), so future data-driven tests don't need to stub Mantine components.

vi.mock('~/utils/trpc', () => ({
  trpc: {
    orchestrator: {
      getVideoMetadata: {
        useQuery: vi.fn(),
      },
    },
  },
}));

vi.mock('~/utils/media-preprocessors', () => ({
  getVideoData: vi.fn(async () => ({ videoWidth: 1280, videoHeight: 720 })),
}));

vi.mock('~/components/EdgeMedia/EdgeVideo', () => ({
  EdgeVideo: ({ src }: { src: string }) => <div data-testid="edge-video" data-src={src} />,
}));

import { VideoInput } from '~/components/generation_v2/inputs/VideoInput';
import { trpc } from '~/utils/trpc';

const useQueryMock = vi.mocked(trpc.orchestrator.getVideoMetadata.useQuery);

// Convenience: tRPC's UseQueryResult is large; tests only read data/isLoading/error.
const queryResult = (over: Partial<{ data: unknown; isLoading: boolean; error: unknown }> = {}) =>
  ({ data: undefined, isLoading: false, error: null, ...over } as any);

const ORCH_URL = 'https://orchestration.civitai.com/v1/blob/abc.mp4';
const NON_ORCH_URL = 'https://example.com/some-video.mp4';

describe('VideoInput (data-driven / tRPC-backed)', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue(queryResult());
  });

  test('query is DISABLED (enabled:false) when no video is selected', async () => {
    renderWithProviders(<VideoInput value={undefined} onChange={vi.fn()} />);

    // Dropzone (empty state) renders, proving we mounted the no-video branch.
    await expect.element(page.getByText('Drag a video here or click to select')).toBeInTheDocument();

    // The hook is still CALLED (hooks can't be conditional) but gated off.
    expect(useQueryMock).toHaveBeenCalled();
    const [, opts] = useQueryMock.mock.calls.at(-1)!;
    expect((opts as any).enabled).toBe(false);
  });

  test('query is DISABLED for a non-orchestrator URL (isOrchestratorUrl gate)', async () => {
    renderWithProviders(
      <VideoInput value={{ url: NON_ORCH_URL }} onChange={vi.fn()} />
    );

    // Video preview branch mounted (our EdgeVideo stub).
    await expect.element(page.getByTestId('edge-video')).toBeInTheDocument();

    const [args, opts] = useQueryMock.mock.calls.at(-1)!;
    expect((args as any).videoUrl).toBe(NON_ORCH_URL);
    expect((opts as any).enabled).toBe(false);
    // ...and the "From Generation" badge (isFromOrchestrator) must NOT show.
    await expect.element(page.getByText('From Generation')).not.toBeInTheDocument();
  });

  test('query is ENABLED for an orchestrator URL', async () => {
    renderWithProviders(
      <VideoInput value={{ url: ORCH_URL }} onChange={vi.fn()} />
    );

    // Await a render-committed assertion before reading mock.calls (render is
    // async-committed in browser mode; reading calls eagerly races the mount).
    // isFromOrchestrator true -> the "From Generation" badge renders.
    await expect.element(page.getByText('From Generation')).toBeInTheDocument();

    const [args, opts] = useQueryMock.mock.calls.at(-1)!;
    expect((args as any).videoUrl).toBe(ORCH_URL);
    expect((opts as any).enabled).toBe(true);
  });

  test('success: serverMetadata.fps drives the FPS badge', async () => {
    useQueryMock.mockReturnValue(queryResult({ data: { fps: 24, duration: 'PT2S' } }));

    renderWithProviders(
      <VideoInput value={{ url: ORCH_URL }} onChange={vi.fn()} />
    );

    // Case-sensitive regex so the literal "FPS" label is genuinely pinned
    // (a plain string query normalizes loosely and would pass on "24 fps").
    await expect.element(page.getByText(/24 FPS/)).toBeInTheDocument();
  });

  test('no FPS badge when serverMetadata is absent', async () => {
    useQueryMock.mockReturnValue(queryResult({ data: undefined }));

    renderWithProviders(
      <VideoInput value={{ url: ORCH_URL }} onChange={vi.fn()} />
    );

    // Preview is up (orchestrator badge present) but no FPS overlay.
    await expect.element(page.getByText('From Generation')).toBeInTheDocument();
    await expect.element(page.getByText(/FPS/)).not.toBeInTheDocument();
  });

  test('error: metadataError renders the failure Alert', async () => {
    useQueryMock.mockReturnValue(
      queryResult({ error: { message: 'boom' } })
    );

    renderWithProviders(
      <VideoInput value={{ url: ORCH_URL }} onChange={vi.fn()} />
    );

    await expect
      .element(page.getByText('Failed to load video metadata: boom'))
      .toBeInTheDocument();
  });

  test('success: fetched metadata + video dimensions propagate to onChange', async () => {
    // The data-driven CONTRACT (the reason this is a tRPC-backed input): the
    // fetched fps + duration plus the <video>'s real dimensions flow back into
    // the form value via onChange. width/height come from getVideoData (the
    // mocked video element, 1280x720), NOT from serverMetadata's width/height —
    // so we feed a faithful full shape but assert dimensions resolve from the
    // element. duration runs through the REAL `@civitai/client` TimeSpan (it is
    // NOT mocked in the component project — the @civitai/client mock lives only
    // in the unit setup). TimeSpan parses .NET `HH:MM:SS.ticks`, so '00:00:02.0'
    // -> totalSeconds 2; note a tick-less '00:00:02' parses to 0, so the real
    // wire format must carry fractional ticks for this branch to be non-zero.
    useQueryMock.mockReturnValue(
      queryResult({ data: { fps: 24, width: 1920, height: 1080, duration: '00:00:02.0' } })
    );
    const onChange = vi.fn();

    renderWithProviders(<VideoInput value={{ url: ORCH_URL }} onChange={onChange} />);

    // The effect fires only after getVideoData resolves videoDimensions (async),
    // so poll rather than asserting eagerly.
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        url: ORCH_URL,
        metadata: { fps: 24, width: 1280, height: 720, duration: 2 },
      })
    );
  });
});
