import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as WhatIfProviderModule from '~/components/form-graph/generation/WhatIfProvider';
import type * as BuzzModule from '~/components/Buzz/useBuzz';
import type * as ToursModule from '~/components/Tours/ToursProvider';
import type * as GenerationProviderModule from '~/components/ImageGeneration/GenerationProvider';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ResourceDataProviderModule from '~/components/generation_v2/inputs/ResourceDataProvider';

/**
 * Flux 3 Video's provider rejects a source image rated above PG-13, so Generate must refuse one
 * up front and point at an engine that takes it. The store is the real generation graph; only
 * what the footer reads from elsewhere (estimate, balance, flags) is a fixture.
 */

vi.mock('~/components/form-graph/generation/WhatIfProvider', async (orig) => ({
  ...(await orig<typeof WhatIfProviderModule>()),
  useWhatIfContext: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
    refetch: () => undefined,
    canEstimateCost: true,
    gateBlocked: false,
    data: { cost: { base: 37, total: 37 }, ready: true },
  }),
}));

vi.mock('~/components/Buzz/useBuzz', async (orig) => ({
  ...(await orig<typeof BuzzModule>()),
  useQueryBuzz: () => ({
    data: {
      accounts: (['green', 'blue', 'yellow'] as const).map((type) => ({
        type,
        balance: 1_000_000,
      })),
    },
    isLoading: false,
  }),
}));

vi.mock('~/components/Tours/ToursProvider', async (orig) => ({
  ...(await orig<typeof ToursModule>()),
  useTourContext: () => ({
    running: false,
    activeTour: undefined,
    helpers: undefined,
    pauseTour: () => undefined,
    setBlockedTarget: () => undefined,
  }),
}));

vi.mock('~/components/ImageGeneration/GenerationProvider', async (orig) => ({
  ...(await orig<typeof GenerationProviderModule>()),
  useGenerationContext: <T,>(selector: (s: { canGenerate: boolean }) => T) =>
    selector({ canGenerate: true }),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ creatorComp: false, isGreen: true }),
}));

vi.mock('~/components/generation_v2/inputs/ResourceDataProvider', async (orig) => ({
  ...(await orig<typeof ResourceDataProviderModule>()),
  useResourceDataContext: () => ({
    registerResourceId: () => undefined,
    unregisterResourceId: () => undefined,
    getResourceData: () => undefined,
    resources: [],
    isLoading: false,
    isResourceLoading: () => false,
  }),
}));

// eslint-disable-next-line import/first
import { MatureSourceNotice, SubmitButton } from '~/components/form-graph/generation/FormFooter';
// eslint-disable-next-line import/first
import {
  recordSourceRating,
  useFlux3MatureSource,
} from '~/components/form-graph/generation/useFlux3MatureSource';
// eslint-disable-next-line import/first
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
// eslint-disable-next-line import/first
import { flux3VideoVersionIds } from '~/shared/generation/version-ids';
// eslint-disable-next-line import/first
import { useSourceMetadataStore } from '~/store/source-metadata.store';
// eslint-disable-next-line import/first
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const blobUrl = (id: string) =>
  `https://orchestration-new.civitai.com/v2/consumer/blobs/${id}.jpeg?sig=s&exp=2999-01-01T00:00:00Z`;
const FIRST = { url: blobUrl('FIRSTFRAME'), width: 1216, height: 832 };
const KEYFRAME = { url: blobUrl('KEYFRAME'), width: 1216, height: 832 };

const MESSAGE = /can't animate images rated above PG-13/;

function flux3Store(workflow: 'img2vid' | 'img2vid:keyframes') {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow, ecosystem: 'Flux3Video', prompt: 'a cat' });
  store.set({
    model: {
      id: flux3VideoVersionIds[workflow === 'img2vid' ? 'v3.0' : 'v3.0-max'],
    },
  });
  if (workflow === 'img2vid') store.set({ images: [FIRST] });
  else store.set({ keyframes: [{ image: KEYFRAME, frameIndex: 0 }] });
  return store;
}

type Store = ReturnType<typeof flux3Store>;

// The footer's alert slot reduced to this one branch: the rest of it needs the whole form.
function Footer({ store }: { store: Store }) {
  const { blocked, canSwitch } = useFlux3MatureSource(store);
  return (
    <div>
      {blocked && <MatureSourceNotice store={store} canSwitch={canSwitch} />}
      <SubmitButton store={store} />
    </div>
  );
}

const renderFooter = (store: Store) => renderWithProviders(<Footer store={store} />);

const generateButton = () => {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Generate'
  );
  if (!button) throw new Error('Generate button not found');
  return button;
};
const switchButton = () =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Switch to MiniMax H3'
  );
const showsMessage = () => MESSAGE.test(document.body.textContent ?? '');

let ratingLookups: string[][] = [];
let lookupLevel: string | null = null;

beforeEach(() => {
  useSourceMetadataStore.getState().clearAll();
  ratingLookups = [];
  lookupLevel = null;
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/api/orchestrator/blobRatings')) {
      const { blobIds } = JSON.parse(String(init?.body)) as { blobIds: string[] };
      ratingLookups.push(blobIds);
      return Response.json({
        ratings: blobIds.map((blobId) => ({ blobId, nsfwLevel: lookupLevel })),
      });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Flux 3 Video with a source image rated above PG-13', () => {
  test('a generated R output blocks Generate, and the switch clears it', async () => {
    recordSourceRating(FIRST.url, 'r');
    const store = flux3Store('img2vid');
    await renderFooter(store);

    await vi.waitFor(() => expect(showsMessage()).toBe(true));
    expect(generateButton().disabled).toBe(true);

    switchButton()?.click();
    await vi.waitFor(() => expect(showsMessage()).toBe(false));
    expect((store.getSnapshot().state as { ecosystem?: string }).ecosystem).toBe('MiniMaxH3');
    expect(generateButton().disabled).toBe(false);
  });

  test('an upload the orchestrator rated R blocks Generate', async () => {
    lookupLevel = 'x';
    await renderFooter(flux3Store('img2vid'));

    await vi.waitFor(() => expect(showsMessage()).toBe(true));
    expect(generateButton().disabled).toBe(true);
    expect(ratingLookups[0]).toEqual(['FIRSTFRAME.jpeg']);
  });

  test('a seed below the scan does not hide a mature scan', async () => {
    recordSourceRating(FIRST.url, 'pg13');
    lookupLevel = 'x';
    await renderFooter(flux3Store('img2vid'));

    await vi.waitFor(() => expect(showsMessage()).toBe(true));
    expect(generateButton().disabled).toBe(true);
  });

  test('a scan below the seed does not clear a mature seed', async () => {
    recordSourceRating(FIRST.url, 'r');
    lookupLevel = 'pg';
    await renderFooter(flux3Store('img2vid'));

    await vi.waitFor(() => expect(ratingLookups.length).toBeGreaterThan(0));
    expect(showsMessage()).toBe(true);
    expect(generateButton().disabled).toBe(true);
  });

  test('keyframes mode shows the message without a switch that would drop the keyframes', async () => {
    recordSourceRating(KEYFRAME.url, 'xxx');
    await renderFooter(flux3Store('img2vid:keyframes'));

    await vi.waitFor(() => expect(showsMessage()).toBe(true));
    expect(generateButton().disabled).toBe(true);
    expect(switchButton()).toBeUndefined();
  });
});

describe('Flux 3 Video with a source image that may go through', () => {
  test('a PG-13 source submits', async () => {
    recordSourceRating(FIRST.url, 'pg13');
    await renderFooter(flux3Store('img2vid'));

    await vi.waitFor(() => expect(generateButton().disabled).toBe(false));
    expect(showsMessage()).toBe(false);
  });

  test('a source the lookup cannot rate submits', async () => {
    await renderFooter(flux3Store('img2vid'));

    await vi.waitFor(() => expect(ratingLookups.length).toBeGreaterThan(0));
    expect(generateButton().disabled).toBe(false);
    expect(showsMessage()).toBe(false);
  });
});
