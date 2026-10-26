import { describe, expect, it, vi } from 'vitest';
import type {
  AppCoverWorkflow,
  CoverArtDeps,
  CoverListing,
  CoverListingApi,
  CoverOrchestration,
  ListingForCover,
} from '~/components/Apps/AppAssistant/coverArt';
import {
  APP_COVER_HEIGHT,
  APP_COVER_MODEL,
  APP_COVER_WIDTH,
  COVER_LISTING_UNREADABLE,
  COVER_NO_APP,
  COVER_NO_LISTING,
  COVER_NO_PROMPT,
  COVER_NOT_GENERATED,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  coverNotAttached,
  createBrowserCoverArtDeps,
  createCoverArt,
} from '~/components/Apps/AppAssistant/coverArt';
import { validateListingImage } from '~/server/schema/blocks/app-listing.schema';

const LISTING: CoverListing = { listingId: 'apl_1', blockedReason: null };
const IMAGE_URL = 'https://orchestration.example/blobs/cover.jpeg';

function setup(overrides: Partial<CoverArtDeps> = {}) {
  let app: string | null = 'tip-calculator';
  let ids = 0;
  const deps = {
    currentApp: () => app,
    listing: vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING),
    generate: vi.fn(async (_w: AppCoverWorkflow, _s?: AbortSignal) => IMAGE_URL),
    attach: vi.fn(async (_id: string, _url: string) => ({ scanPending: true })),
    newId: () => `c${++ids}`,
    seed: () => 4242,
    ...overrides,
  };
  const tool = createCoverArt(deps)[GENERATE_APP_COVER]!;
  const call = (input: Record<string, unknown>) => Promise.resolve(tool.execute(input));
  return { deps, call, setApp: (next: string | null) => (app = next) };
}

describe('generate_app_cover: the one recipe it can run', () => {
  it('generates the fixed cover recipe, whatever else the call asks for', async () => {
    const { deps, call } = setup();
    await call({
      prompt: '  a calculator on a sunny desk  ',
      model: 'urn:air:other',
      width: 64,
      steps: [{ $type: 'videoGen' }],
      externalId: 'model-chosen',
    });
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.generate.mock.calls[0]![0]).toEqual({
      steps: [
        {
          $type: 'textToImage',
          input: {
            model: APP_COVER_MODEL,
            prompt: 'a calculator on a sunny desk',
            negativePrompt: expect.any(String),
            width: APP_COVER_WIDTH,
            height: APP_COVER_HEIGHT,
            steps: 25,
            cfgScale: 7,
            seed: 4242,
            quantity: 1,
            outputFormat: 'jpeg',
          },
        },
      ],
      externalId: 'app-cover-c1',
    });
  });

  it('gives every call its own idempotency key', async () => {
    const { deps, call } = setup();
    await call({ prompt: 'a calculator' });
    await call({ prompt: 'a calculator' });
    expect(deps.generate.mock.calls.map(([w]) => w.externalId)).toEqual([
      'app-cover-c1',
      'app-cover-c2',
    ]);
  });

  it('generates, then attaches the result to the listing', async () => {
    const { deps, call } = setup();
    const done = await call({ prompt: 'a calculator' });
    expect(done).toMatchObject({ attached: true });
    expect(deps.attach).toHaveBeenCalledWith('apl_1', IMAGE_URL);
  });

  // `setCover` runs `validateListingImage` on what was generated, so the recipe must pass it.
  it('makes an image the cover check accepts', () => {
    expect(
      validateListingImage(
        { type: 'image', width: APP_COVER_WIDTH, height: APP_COVER_HEIGHT, mimeType: 'image/jpeg' },
        'cover'
      )
    ).toEqual({ ok: true });
  });
});

describe('generate_app_cover: nothing is spent when there is nothing to put it on', () => {
  it('generates nothing with no app open, or no prompt', async () => {
    const noApp = setup();
    noApp.setApp(null);
    await expect(noApp.call({ prompt: 'a calculator' })).rejects.toThrow(COVER_NO_APP);
    expect(noApp.deps.generate).not.toHaveBeenCalled();

    const noPrompt = setup();
    await expect(noPrompt.call({ prompt: '   ' })).rejects.toThrow(COVER_NO_PROMPT);
    expect(noPrompt.deps.generate).not.toHaveBeenCalled();
  });

  it('generates nothing for an app with no listing, or one whose media cannot be edited', async () => {
    const none = setup({ listing: vi.fn(async () => null) });
    await expect(none.call({ prompt: 'a calculator' })).rejects.toThrow(COVER_NO_LISTING);
    expect(none.deps.generate).not.toHaveBeenCalled();

    const blocked = setup({
      listing: vi.fn(async () => ({ ...LISTING, blockedReason: 'This listing was removed.' })),
    });
    await expect(blocked.call({ prompt: 'a calculator' })).rejects.toThrow(
      'This listing was removed.'
    );
    expect(blocked.deps.generate).not.toHaveBeenCalled();
  });
});

function api(overrides: Partial<CoverListingApi> = {}) {
  return {
    getMyListingForApp: vi.fn(
      async (_: { slug: string }): Promise<ListingForCover> => ({
        appListingId: 'apl_1',
        editBlockedReason: null,
      })
    ),
    ingestAssetFromUrl: vi.fn(async (_: { url: string; kind: 'cover' }) => ({ imageId: 77 })),
    setCover: vi.fn(
      async (_: {
        listingId: string;
        imageId: number;
      }): Promise<{ status: 'attached'; scanPending?: boolean }> => ({
        status: 'attached',
        scanPending: true,
      })
    ),
    ...overrides,
  };
}

function orchestration(overrides: Partial<CoverOrchestration> = {}): CoverOrchestration {
  return {
    submitWorkflow: vi.fn(async () => ({ id: 'wf_1', status: 'scheduled' })),
    waitForWorkflow: vi.fn(async () => ({
      id: 'wf_1',
      status: 'succeeded',
      steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }],
    })),
    ...overrides,
  };
}

const browserDeps = (
  listingApi: CoverListingApi,
  client: CoverOrchestration = orchestration(),
  onAttached = vi.fn()
) =>
  createBrowserCoverArtDeps({
    currentApp: () => 'tip-calculator',
    api: listingApi,
    orchestration: async () => client,
    onAttached,
  });

describe('the page’s cover: attached through the listing editor’s own procedures', () => {
  it('ingests the generated image as a cover upload, then sets it as the listing’s cover', async () => {
    const listingApi = api();
    const onAttached = vi.fn();
    const result = await browserDeps(listingApi, orchestration(), onAttached).attach(
      'apl_1',
      IMAGE_URL
    );
    expect(listingApi.ingestAssetFromUrl).toHaveBeenCalledWith({ url: IMAGE_URL, kind: 'cover' });
    expect(listingApi.setCover).toHaveBeenCalledWith({ listingId: 'apl_1', imageId: 77 });
    expect(result).toEqual({ scanPending: true });
    expect(onAttached).toHaveBeenCalledTimes(1);
  });

  it('reports the cover check’s refusal and does not claim it attached', async () => {
    const reason = 'cover must be landscape (aspect 1.00 outside 1.3–2.4)';
    const listingApi = api({ setCover: vi.fn(async () => Promise.reject(new Error(reason))) });
    const onAttached = vi.fn();
    await expect(
      browserDeps(listingApi, orchestration(), onAttached).attach('apl_1', IMAGE_URL)
    ).rejects.toThrow(coverNotAttached(reason));
    expect(onAttached).not.toHaveBeenCalled();
  });

  it('reads the user’s listing, no listing as none, and any other failure as unreadable', async () => {
    const ok = api({
      getMyListingForApp: vi.fn(async () => ({
        appListingId: 'apl_9',
        editBlockedReason: 'Under review.',
      })),
    });
    expect(await browserDeps(ok).listing('tip-calculator')).toEqual({
      listingId: 'apl_9',
      blockedReason: 'Under review.',
    });
    expect(ok.getMyListingForApp).toHaveBeenCalledWith({ slug: 'tip-calculator' });

    const coded = (code: string) => Object.assign(new Error('x'), { data: { code } });
    for (const code of ['NOT_FOUND', 'FORBIDDEN']) {
      const listingApi = api({
        getMyListingForApp: vi.fn(async () => Promise.reject(coded(code))),
      });
      expect(await browserDeps(listingApi).listing('tip-calculator')).toBeNull();
    }
    const listingApi = api({
      getMyListingForApp: vi.fn(async () => Promise.reject(coded('INTERNAL_SERVER_ERROR'))),
    });
    await expect(browserDeps(listingApi).listing('tip-calculator')).rejects.toThrow(
      COVER_LISTING_UNREADABLE
    );
  });

  it('submits the workflow it was given, and returns the generated image', async () => {
    const client = orchestration();
    const workflow = { ...appCoverWorkflow('a', 1), externalId: 'app-cover-x' };
    expect(await browserDeps(api(), client).generate(workflow)).toBe(IMAGE_URL);
    expect(client.submitWorkflow).toHaveBeenCalledWith(workflow);
  });

  it('fails without a generated image, and attaches nothing', async () => {
    for (const done of [
      // Failed, though it reports an image: the status alone must refuse it.
      {
        status: 'failed',
        steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }],
      },
      {
        status: 'succeeded',
        steps: [{ output: { images: [{ url: IMAGE_URL, available: false }] } }],
      },
      { status: 'succeeded', steps: [{ output: { images: [] } }] },
    ]) {
      const listingApi = api();
      const deps = browserDeps(
        listingApi,
        orchestration({ waitForWorkflow: vi.fn(async () => done) })
      );
      const tool = createCoverArt(deps)[GENERATE_APP_COVER]!;
      await expect(Promise.resolve(tool.execute({ prompt: 'a' }))).rejects.toThrow(
        COVER_NOT_GENERATED
      );
      expect(listingApi.ingestAssetFromUrl).not.toHaveBeenCalled();
      expect(listingApi.setCover).not.toHaveBeenCalled();
    }
  });
});
