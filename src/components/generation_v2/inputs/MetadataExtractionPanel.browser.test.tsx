import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// =============================================================================
// MULTI-QUERY tRPC MOCK + ZUSTAND-STORE MOCK PATTERN
// =============================================================================
//
// MetadataExtractionPanel is the first generation input driven by a zustand
// STORE + TWO tRPC queries (and NO props). It extends the single-query
// VideoInput tRPC template two ways, both established here as reusable
// deliverables for the next store-backed / multi-query test.
//
// SCOPE (be honest): these tests cover the component's STORE<->QUERY WIRING (the
// `enabled` gates, the comfy-strip query arg, the resolved->store sync action)
// and its RENDER BRANCHES (loaders, the Resources card, the JSON dump). They do
// NOT cover the metadata-extraction-from-drop flow: `droppedMedia` is internal
// state set only by a real drop event, so the EXIF-parse effect, the server
// `getGenerationData` path, and the file->dataURL handling are unreachable in a
// bare render and intentionally untested here (would need a simulated drag-drop
// with custom dataTransfer — a separate rung).
//
// -----------------------------------------------------------------------------
// (1) MULTI-QUERY tRPC MOCK
// -----------------------------------------------------------------------------
// Same shape as VideoInput's `vi.mock('~/utils/trpc', ...)`, but the factory
// declares EVERY procedure the component touches, each with its own vi.fn()
// useQuery so the two queries are driven INDEPENDENTLY per test:
//
//   vi.mock('~/utils/trpc', () => ({
//     trpc: { generation: {
//       getGenerationData: { useQuery: vi.fn() },   // server-side (on-site drop) path
//       resolveImageMeta:  { useQuery: vi.fn() },    // client-side EXIF path
//     } },
//   }));
//
// Grep rule (from VideoInput): an uncovered `trpc.*` access is `undefined` here
// but THROWS in the real app. The component accesses exactly these two
// procedures (lines ~240 + ~272) — both covered.
//
// GATE CAVEAT: this stub returns the supplied `data`/`isFetching` REGARDLESS of
// the `enabled` option — unlike production, where a disabled query yields
// `data: undefined`. So a data/render/sync test would still "work" against a
// wrongly-disabled query. The real `enabled` gate is therefore pinned ONLY by
// the dedicated arg-level assertions (the `expect(opts.enabled).toBe(...)`
// checks); when a behavior test relies on a query being enabled, also assert
// `opts.enabled === true` so its positive path proves prod would run it.
//
// Each query's useQuery returns DIFFERENT fields, so they get different stubs:
//   - getGenerationData -> { data: serverData, isFetching }
//   - resolveImageMeta  -> { data: resolved,   isFetching }
// `queryResult()` supplies the union so either can be driven without re-typing.
//
// GATING TEETH: both queries are conditional via `enabled`, asserted from the
// last useQuery call's options arg (render-stable per test, same caveat as
// VideoInput):
//   - getGenerationData.enabled === !!droppedMedia
//   - resolveImageMeta.enabled  === hasMetadata && !droppedMedia
// droppedMedia is internal component state (set only by a drop event), so in a
// bare render it is always undefined => getGenerationData is always disabled and
// resolveImageMeta's gate reduces to `hasMetadata` (store.metadata non-empty).
// That makes store.metadata the lever for resolveImageMeta's enabled flag — the
// store and the query are coupled, which is exactly the data-driven contract
// this rung pins.
//
// -----------------------------------------------------------------------------
// (2) ZUSTAND-STORE MOCK  (the new reusable pattern)
// -----------------------------------------------------------------------------
// The component calls the hook BARE — `const store = useMetadataExtractionStore()`
// (no selector) — and reads the WHOLE state object (store.metadata,
// store.fileUrl, store.isExtracting, store.isResolving, store.resolvedResources)
// plus actions (store.clear/setFileUrl/setMetadata/setResolved/setIsExtracting/
// setIsResolving). It does NOT use `.getState()`/`.setState()` (only the
// separate `metadataExtractionStore` helper does, and the component doesn't
// import that). So the mock is the simplest bare form:
//
//   vi.mock('~/store/metadata-extraction.store', () => ({
//     useMetadataExtractionStore: vi.fn(),
//   }));
//   // per test:
//   vi.mocked(useMetadataExtractionStore).mockReturnValue(makeStore({ metadata: {...} }));
//
// makeStore() returns a FULL controlled state (every field + every action as a
// vi.fn()) so the bare hook is consistent across the component's render. Because
// the hook is called once per render and returns one frozen object, every
// `store.x` in that render reads the same controlled value — no selector to
// apply. (If a future component called it WITH a selector, the mock would
// instead be `vi.fn((sel) => sel(STATE))`; if it used `.getState()`, attach it
// to the fn: `useStore.getState = () => STATE`. Neither is needed here.)
//
// -----------------------------------------------------------------------------
// (3) THIN MOCKS for heavy non-logic deps that block rendering (minimum set):
//   - `~/components/EdgeMedia/EdgeVideo`: heavy edge-url/dialog/scroll-area tree;
//     rendered only on the video-drop preview branch. Stub keeps the test about
//     the panel's own data-driven render. (Same justification as VideoInput.)
//   - `./ResourceItemContent`: pulls in AppProvider context + EdgeMedia2 +
//     CurrencyBadge; rendered only inside the resolvedResources branch. We stub
//     it thin so the "Resources (N)" header/count branch is testable without
//     standing up the whole app-context provider stack. Stub shows the resource
//     id so the per-resource mapping is still observable.
// We do NOT mock Mantine (resolve.dedupe handles dual-React at the scaffold).

// NOTE: vi.mock replaces the WHOLE module, so any OTHER importer of a
// `~/utils/trpc` export in this component's import chain breaks unless mocked.
// `generation-graph.store` (imported transitively for the "add to generation"
// flow) uses `trpcVanilla.generation.getGenerationData.query`, so we stub
// `trpcVanilla` too (and the other named exports for safety). VideoInput didn't
// need this because its chain doesn't reach generation-graph.store.
vi.mock('~/utils/trpc', () => ({
  trpc: {
    generation: {
      getGenerationData: { useQuery: vi.fn() },
      resolveImageMeta: { useQuery: vi.fn() },
    },
  },
  trpcVanilla: {
    generation: {
      getGenerationData: { query: vi.fn() },
    },
  },
  queryClient: {},
  handleTRPCError: vi.fn(),
}));

vi.mock('~/store/metadata-extraction.store', () => ({
  useMetadataExtractionStore: vi.fn(),
}));

vi.mock('~/components/EdgeMedia/EdgeVideo', () => ({
  EdgeVideo: ({ src }: { src: string }) => <div data-testid="edge-video" data-src={src} />,
}));

vi.mock('./ResourceItemContent', () => ({
  ResourceItemContent: ({ resource, actions }: { resource: { id: number }; actions: any }) => (
    <div data-testid="resource-item" data-resource-id={resource.id}>
      {actions}
    </div>
  ),
}));

import { MetadataExtractionPanel } from '~/components/generation_v2/inputs/MetadataExtractionPanel';
import { trpc } from '~/utils/trpc';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';

const getGenerationDataMock = vi.mocked(trpc.generation.getGenerationData.useQuery);
const resolveImageMetaMock = vi.mocked(trpc.generation.resolveImageMeta.useQuery);
const storeMock = vi.mocked(useMetadataExtractionStore);

// tRPC UseQueryResult is large; the component reads only data + isFetching.
const queryResult = (over: Partial<{ data: unknown; isFetching: boolean }> = {}) =>
  ({ data: undefined, isFetching: false, ...over } as any);

// Full controlled store state (every field + action). Override per test.
const makeStore = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    metadata: undefined,
    resolvedResources: [],
    params: undefined,
    fileUrl: undefined,
    isExtracting: false,
    isResolving: false,
    setMetadata: vi.fn(),
    setResolved: vi.fn(),
    setFileUrl: vi.fn(),
    setIsExtracting: vi.fn(),
    setIsResolving: vi.fn(),
    clear: vi.fn(),
    ...over,
  } as any);

describe('MetadataExtractionPanel (store + multi-query / tRPC-backed)', () => {
  beforeEach(() => {
    getGenerationDataMock.mockReset();
    resolveImageMetaMock.mockReset();
    storeMock.mockReset();
    getGenerationDataMock.mockReturnValue(queryResult());
    resolveImageMetaMock.mockReturnValue(queryResult());
    storeMock.mockReturnValue(makeStore());
  });

  test('empty store: renders the dropzone prompt; BOTH queries disabled', async () => {
    renderWithProviders(<MetadataExtractionPanel />);

    // Empty state (no fileUrl) renders the idle dropzone copy.
    await expect
      .element(page.getByText('Drop an image here or click to select'))
      .toBeInTheDocument();

    // Hooks always run, but both are gated off in a bare render:
    //  - getGenerationData: enabled = !!droppedMedia = false
    //  - resolveImageMeta:  enabled = hasMetadata && !droppedMedia = false (no metadata)
    const [, serverOpts] = getGenerationDataMock.mock.calls.at(-1)!;
    const [, resolveOpts] = resolveImageMetaMock.mock.calls.at(-1)!;
    expect((serverOpts as any).enabled).toBe(false);
    expect((resolveOpts as any).enabled).toBe(false);
  });

  test('store.metadata present ENABLES resolveImageMeta and passes the metadata as query arg', async () => {
    const metadata = { prompt: 'a cat', steps: 20 };
    storeMock.mockReturnValue(makeStore({ metadata }));

    renderWithProviders(<MetadataExtractionPanel />);

    // The Prompt card renders from store.metadata.prompt — proves the metadata
    // branch mounted. Use exact match: 'a cat' also appears as a substring in the
    // raw-JSON <pre> dump, so a loose query is a strict-mode collision.
    await expect.element(page.getByText('a cat', { exact: true })).toBeInTheDocument();

    // resolveImageMeta is now enabled (hasMetadata true, no droppedMedia) and
    // receives the store metadata (comfy stripped — none here) as its query arg.
    const [args, opts] = resolveImageMetaMock.mock.calls.at(-1)!;
    expect((opts as any).enabled).toBe(true);
    expect((args as any).metadata).toEqual(metadata);
    // getGenerationData stays disabled (no on-site drop).
    const [, serverOpts] = getGenerationDataMock.mock.calls.at(-1)!;
    expect((serverOpts as any).enabled).toBe(false);
  });

  test('resolveImageMeta query arg strips the large `comfy` field', async () => {
    // The component drops `metadata.comfy` before sending (431 header-size guard).
    storeMock.mockReturnValue(
      makeStore({ metadata: { prompt: 'hi', comfy: { huge: 'graph' } } })
    );

    renderWithProviders(<MetadataExtractionPanel />);
    // Exact match: 'hi' also appears inside the raw-JSON <pre> dump.
    await expect.element(page.getByText('hi', { exact: true })).toBeInTheDocument();

    const [args] = resolveImageMetaMock.mock.calls.at(-1)!;
    expect((args as any).metadata).toEqual({ prompt: 'hi' });
    expect((args as any).metadata.comfy).toBeUndefined();
  });

  test('store.isExtracting drives the "Extracting metadata..." loader', async () => {
    storeMock.mockReturnValue(makeStore({ isExtracting: true }));

    renderWithProviders(<MetadataExtractionPanel />);

    await expect.element(page.getByText('Extracting metadata...', { exact: true })).toBeInTheDocument();
  });

  test('store.resolvedResources render the Resources card', async () => {
    // RENDER branch only: resolvedResources (store-held, normally written by the
    // resolved->store sync effect — that sync is pinned separately below) drive
    // the "Resources (N)" card. We set the store directly so the count +
    // per-resource mapping (via the thin ResourceItemContent) are pinned.
    storeMock.mockReturnValue(
      makeStore({
        metadata: { prompt: 'p' },
        resolvedResources: [
          { id: 101, model: { type: 'Checkpoint' }, baseModel: 'SD1' },
          { id: 202, model: { type: 'LORA' }, baseModel: 'SD1' },
        ],
      })
    );
    resolveImageMetaMock.mockReturnValue(
      queryResult({ data: { resources: [{ id: 101 }, { id: 202 }], params: {} } })
    );

    renderWithProviders(<MetadataExtractionPanel />);

    // Header reflects the store's resolvedResources length.
    await expect.element(page.getByText('Resources (2)')).toBeInTheDocument();
    // Both resources mapped through the (stubbed) ResourceItemContent.
    const items = page.getByTestId('resource-item');
    await expect.element(items.first()).toBeInTheDocument();
    await expect.element(page.getByText('Use selected')).toBeInTheDocument(); // >1 resource
  });

  test('resolveImageMeta `isFetching` drives the "Resolving resources..." loader', async () => {
    // hasMetadata true + isFetching true + client path (no droppedMedia) => the
    // inline resolving loader shows.
    storeMock.mockReturnValue(makeStore({ metadata: { prompt: 'p' } }));
    resolveImageMetaMock.mockReturnValue(queryResult({ isFetching: true }));

    renderWithProviders(<MetadataExtractionPanel />);

    await expect.element(page.getByText('Resolving resources...', { exact: true })).toBeInTheDocument();
  });

  test('resolveImageMeta data syncs into the store via setResolved', async () => {
    // The resolved->store sync EFFECT (not just render): when resolveImageMeta
    // returns data on the client path (no droppedMedia), the component pushes
    // resolved.resources/params into the store via setResolved. We assert the
    // store action fires with the query's resources/params.
    const store = makeStore({ metadata: { prompt: 'p' } }); // non-empty -> query enabled
    storeMock.mockReturnValue(store);
    const resources = [{ id: 101 }, { id: 202 }];
    const params = { steps: 20 };
    resolveImageMetaMock.mockReturnValue(queryResult({ data: { resources, params } }));

    renderWithProviders(<MetadataExtractionPanel />);

    await vi.waitFor(() =>
      expect(store.setResolved).toHaveBeenCalledWith(resources, params)
    );

    // The useQuery mock returns `data` regardless of `enabled`, so the sync
    // above would also fire on a wrongly-disabled query. Pin that the query is
    // actually enabled here (metadata non-empty) so the positive path proves
    // production would run it too.
    const [, opts] = resolveImageMetaMock.mock.calls.at(-1)!;
    expect((opts as any).enabled).toBe(true);
  });

  test('store.metadata renders the raw Extracted Metadata JSON card', async () => {
    storeMock.mockReturnValue(makeStore({ metadata: { prompt: 'a cat', steps: 20 } }));

    renderWithProviders(<MetadataExtractionPanel />);

    await expect.element(page.getByText('Extracted Metadata')).toBeInTheDocument();
    // The JSON dump contains the metadata serialized — pin a key from it.
    await expect.element(page.getByText(/"steps": 20/)).toBeInTheDocument();
  });
});
