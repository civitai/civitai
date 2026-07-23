import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';

// The panel uses a bare Zustand hook and two independently gated tRPC queries.
// Keep those dependencies controlled while exercising both render and local-file paths.
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

vi.mock('~/utils/metadata', () => ({
  ExifParser: vi.fn(),
  VideoMetadataParser: vi.fn(),
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
import { ExifParser, VideoMetadataParser } from '~/utils/metadata';

const getGenerationDataMock = vi.mocked(trpc.generation.getGenerationData.useQuery);
const resolveImageMetaMock = vi.mocked(trpc.generation.resolveImageMeta.useQuery);
const storeMock = vi.mocked(useMetadataExtractionStore);
const exifParserMock = vi.mocked(ExifParser);
const videoMetadataParserMock = vi.mocked(VideoMetadataParser);

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

function makePreviewStore() {
  return makeStore({ fileUrl: 'blob:video-preview' });
}

async function selectFile(file: File) {
  let input: HTMLInputElement | null = null;
  await vi.waitFor(() => {
    input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
  });
  Object.defineProperty(input!, 'files', { configurable: true, value: [file] });
  input!.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('MetadataExtractionPanel (store + multi-query / tRPC-backed)', () => {
  beforeEach(() => {
    getGenerationDataMock.mockReset();
    resolveImageMetaMock.mockReset();
    storeMock.mockReset();
    exifParserMock.mockReset();
    videoMetadataParserMock.mockReset();
    getGenerationDataMock.mockReturnValue(queryResult());
    resolveImageMetaMock.mockReturnValue(queryResult());
    storeMock.mockReturnValue(makeStore());
    exifParserMock.mockResolvedValue({
      parse: vi.fn(() => undefined),
      getMetadata: vi.fn(async () => ({})),
    } as any);
    videoMetadataParserMock.mockResolvedValue({
      parse: vi.fn(() => undefined),
      getMetadata: vi.fn(async () => ({})),
    } as any);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:video-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  test('empty store: renders the dropzone prompt; BOTH queries disabled', async () => {
    renderWithProviders(<MetadataExtractionPanel />);

    // Empty state (no fileUrl) renders the idle dropzone copy.
    await expect
      .element(page.getByText('Drop an image or video here or click to select'))
      .toBeInTheDocument();

    const accept = document.querySelector<HTMLInputElement>('input[type="file"]')?.accept;
    expect(accept).toContain('video/mp4');
    expect(accept).toContain('video/webm');

    // Hooks always run, but both are gated off in a bare render:
    //  - getGenerationData: enabled = !!droppedMedia = false
    //  - resolveImageMeta:  enabled = hasMetadata && !droppedMedia = false (no metadata)
    const [, serverOpts] = getGenerationDataMock.mock.calls.at(-1)!;
    const [, resolveOpts] = resolveImageMetaMock.mock.calls.at(-1)!;
    expect((serverOpts as any).enabled).toBe(false);
    expect((resolveOpts as any).enabled).toBe(false);
  });

  test.each([
    ['MP4', 'video/mp4', 'clip.mp4'],
    ['WebM', 'video/webm', 'clip.webm'],
  ])(
    'accepts a local %s, previews it with an object URL, and stores parsed metadata',
    async (_label, type, name) => {
      const store = makePreviewStore();
      const parsed = { prompt: `${type} prompt`, extra: { workflow: 'txt2vid' } };
      const getMetadata = vi.fn(async () => ({ prompt: `${type} prompt` }));
      videoMetadataParserMock.mockResolvedValue({
        parse: vi.fn(() => parsed),
        getMetadata,
      } as any);
      storeMock.mockReturnValue(store);

      renderWithProviders(<MetadataExtractionPanel />);
      const file = new File([new Uint8Array([1, 2, 3])], name, { type });
      await selectFile(file);

      await vi.waitFor(() => expect(videoMetadataParserMock).toHaveBeenCalledWith(file));
      await vi.waitFor(() =>
        expect(store.setMetadata).toHaveBeenCalledWith({
          prompt: `${type} prompt`,
          workflow: 'txt2vid',
        })
      );
      await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(file));
      await vi.waitFor(() =>
        expect(document.querySelector('video')).toHaveAttribute('src', 'blob:video-preview')
      );
      expect(exifParserMock).not.toHaveBeenCalled();
      const closeButton = document.querySelector<HTMLButtonElement>('button');
      expect(closeButton).not.toBeNull();
      closeButton!.click();
      await vi.waitFor(() =>
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-preview')
      );
    }
  );

  test('missing local video metadata is nonfatal and writes an empty result', async () => {
    const store = makePreviewStore();
    storeMock.mockReturnValue(store);
    renderWithProviders(<MetadataExtractionPanel />);

    const file = new File([new Uint8Array([1])], 'empty.webm', { type: 'video/webm' });
    await selectFile(file);

    await vi.waitFor(() => expect(videoMetadataParserMock).toHaveBeenCalledWith(file));
    await vi.waitFor(() => expect(store.setMetadata).toHaveBeenCalledWith({}));
    expect(store.setIsExtracting).toHaveBeenCalledWith(false);
    await expect
      .element(page.getByText('No generation metadata found in this image or video.'))
      .toBeInTheDocument();
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
    storeMock.mockReturnValue(makeStore({ metadata: { prompt: 'hi', comfy: { huge: 'graph' } } }));

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

    await expect
      .element(page.getByText('Extracting metadata...', { exact: true }))
      .toBeInTheDocument();
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

    await expect
      .element(page.getByText('Resolving resources...', { exact: true }))
      .toBeInTheDocument();
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

    await vi.waitFor(() => expect(store.setResolved).toHaveBeenCalledWith(resources, params));

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
