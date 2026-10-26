import { describe, expect, it, vi } from 'vitest';
import type { AppCoverWorkflow, CoverArtDeps, CoverListing } from '@civitai/app-assistant';
import {
  APP_COVER_MODEL,
  COVER_NO_LISTING,
  COVER_NOT_CONFIRMED,
  COVER_OTHER_APP,
  COVER_UNKNOWN_QUOTE,
  COVER_UNPRICED,
  OFFER_COVER,
} from '@civitai/app-assistant';
import {
  APP_ASSISTANT_EXCLUDED_TOOLS,
  APP_ASSISTANT_MCP,
} from '~/components/Apps/AppAssistant/assistantChatConfig';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';
import type {
  CoverListingApi,
  CoverOrchestration,
  ListingForCover,
} from '~/components/Apps/AppAssistant/coverArt';
import {
  APP_COVER_HEIGHT,
  APP_COVER_WIDTH,
  COVER_LISTING_UNREADABLE,
  COVER_NOT_GENERATED,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  coverNotAttached,
  coverStateOf,
  createBrowserCoverArtDeps,
  createCoverArt,
} from '~/components/Apps/AppAssistant/coverArt';
import { validateListingImage } from '~/server/schema/blocks/app-listing.schema';

const LISTING: CoverListing = { listingId: 'apl_1', cover: 'none', blockedReason: null };
const IMAGE_URL = 'https://orchestration.example/blobs/cover.jpeg';

function setup(overrides: Partial<CoverArtDeps> = {}) {
  let app: string | null = 'tip-calculator';
  let ids = 0;
  const deps = {
    currentApp: () => app,
    listing: vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING),
    estimate: vi.fn(async (_w: AppCoverWorkflow): Promise<number | null> => 12),
    generate: vi.fn(async (_w: AppCoverWorkflow, _s?: AbortSignal) => IMAGE_URL),
    attach: vi.fn(async (_id: string, _url: string) => ({ scanPending: true })),
    newId: () => `q${++ids}`,
    seed: () => 4242,
    ...overrides,
  };
  const cover = createCoverArt(deps);
  const tool = cover.tools[GENERATE_APP_COVER]!;
  const call = (input: Record<string, unknown>) => Promise.resolve(tool.execute(input));
  return { deps, cover, call, setApp: (next: string | null) => (app = next) };
}

describe('generate_app_cover: the one recipe it can run', () => {
  it('prices the fixed cover recipe, whatever else the call asks for', async () => {
    const { deps, call } = setup();
    await call({
      prompt: 'a calculator on a sunny desk',
      model: 'urn:air:other',
      width: 64,
      steps: [{ $type: 'videoGen' }],
    });
    expect(deps.estimate).toHaveBeenCalledWith({
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
    });
  });

  it('generates the quoted prompt, not one passed with the confirmation', async () => {
    const { deps, cover, call } = setup();
    const priced = (await call({ prompt: 'a calculator' })) as { quote: string };
    cover.userMessage();
    await call({ quote: priced.quote, prompt: 'something else entirely' });
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.generate.mock.calls[0]![0]).toEqual({
      ...appCoverWorkflow('a calculator', 4242),
      externalId: `app-cover-${priced.quote}`,
    });
  });

  // The page offers no general generation: the chat's own run_step and run_workflow stay out.
  it('leaves the chat’s general generation tools excluded', () => {
    const exclude = APP_ASSISTANT_MCP?.orchestration?.exclude ?? [];
    expect(exclude).toEqual(expect.arrayContaining(['run_step', 'run_workflow']));
    expect(APP_ASSISTANT_EXCLUDED_TOOLS).not.toContain(GENERATE_APP_COVER);
  });
});

describe('generate_app_cover: price first, spend only after the user answers', () => {
  it('a first call only prices it: nothing is generated or attached', async () => {
    const { deps, call } = setup();
    const priced = await call({ prompt: 'a calculator' });
    expect(priced).toMatchObject({ quote: 'q1', cost: 12, currentCover: 'none' });
    expect((priced as { note: string }).note).toContain('12 Buzz');
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('refuses to spend in the same reply the price was given, before the user has answered', async () => {
    const { deps, call } = setup();
    const { quote } = (await call({ prompt: 'a calculator' })) as { quote: string };
    await expect(call({ quote })).rejects.toThrow(COVER_NOT_CONFIRMED);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('generates once the user has sent a message, and attaches the result to the listing', async () => {
    const { deps, cover, call } = setup();
    const { quote } = (await call({ prompt: 'a calculator' })) as { quote: string };
    cover.userMessage();
    const done = await call({ quote });
    expect(done).toMatchObject({ attached: true, cost: 12 });
    expect(deps.attach).toHaveBeenCalledWith('apl_1', IMAGE_URL);
  });

  it('spends a quote once, even when two calls name it in one step', async () => {
    const { deps, cover, call } = setup();
    const { quote } = (await call({ prompt: 'a calculator' })) as { quote: string };
    cover.userMessage();
    const both = await Promise.allSettled([call({ quote }), call({ quote })]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(call({ quote })).rejects.toThrow(COVER_UNKNOWN_QUOTE);
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it('refuses a quote it never gave', async () => {
    const { deps, cover, call } = setup();
    cover.userMessage();
    await expect(call({ quote: 'made-up' })).rejects.toThrow(COVER_UNKNOWN_QUOTE);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('refuses a quote given for another app, and any quote after reset', async () => {
    const { deps, cover, call, setApp } = setup();
    const first = (await call({ prompt: 'a calculator' })) as { quote: string };
    const second = (await call({ prompt: 'a calculator' })) as { quote: string };
    cover.userMessage();
    setApp('another-app');
    await expect(call({ quote: first.quote })).rejects.toThrow(COVER_OTHER_APP);
    setApp('tip-calculator');
    cover.reset();
    await expect(call({ quote: second.quote })).rejects.toThrow(COVER_UNKNOWN_QUOTE);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('gives no quote for a cover that cannot be priced', async () => {
    const { deps, call } = setup({ estimate: vi.fn(async () => null) });
    await expect(call({ prompt: 'a calculator' })).rejects.toThrow(COVER_UNPRICED);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('prices nothing for an app with no listing, or one whose media cannot be edited', async () => {
    const none = setup({ listing: vi.fn(async () => null) });
    await expect(none.call({ prompt: 'a calculator' })).rejects.toThrow(COVER_NO_LISTING);
    expect(none.deps.estimate).not.toHaveBeenCalled();

    const blocked = setup({
      listing: vi.fn(async () => ({ ...LISTING, blockedReason: 'This listing was removed.' })),
    });
    await expect(blocked.call({ prompt: 'a calculator' })).rejects.toThrow(
      'This listing was removed.'
    );
    expect(blocked.deps.estimate).not.toHaveBeenCalled();
  });
});

describe('the cover recipe and the listing’s cover checks', () => {
  // `setCover` runs `validateListingImage` on what was generated, so the recipe must pass it.
  it('makes an image the cover check accepts', () => {
    expect(
      validateListingImage(
        { type: 'image', width: APP_COVER_WIDTH, height: APP_COVER_HEIGHT, mimeType: 'image/jpeg' },
        'cover'
      )
    ).toEqual({ ok: true });
  });

  it('the cover check refuses a wrong size or type, which the attach then reports', () => {
    expect(
      validateListingImage(
        { type: 'image', width: 1024, height: 1024, mimeType: 'image/jpeg' },
        'cover'
      )
    ).toMatchObject({ ok: false });
    expect(
      validateListingImage(
        { type: 'image', width: APP_COVER_WIDTH, height: APP_COVER_HEIGHT, mimeType: 'image/gif' },
        'cover'
      )
    ).toMatchObject({ ok: false });
  });
});

function api(overrides: Partial<CoverListingApi> = {}) {
  return {
    getMyListingForApp: vi.fn(
      async (_: { slug: string }): Promise<ListingForCover> => ({
        appListingId: 'apl_1',
        editBlockedReason: null,
        assets: { cover: { imageId: null } },
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
    estimateWorkflow: vi.fn(async () => ({ status: 'pending', cost: { total: 12 } })),
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

  it('reads the listing’s cover as none, the generated placeholder, or the author’s own', async () => {
    const withCover = (cover: ListingForCover['assets']['cover']): ListingForCover => ({
      appListingId: 'apl_1',
      editBlockedReason: null,
      assets: { cover },
    });
    expect(coverStateOf(withCover({ imageId: null }))).toBe('none');
    expect(coverStateOf(withCover({ imageId: 5, autogenerated: true }))).toBe('placeholder');
    expect(coverStateOf(withCover({ imageId: 5 }))).toBe('custom');

    const listingApi = api({
      getMyListingForApp: vi.fn(async () => withCover({ imageId: 5, autogenerated: true })),
    });
    expect(await browserDeps(listingApi).listing('tip-calculator')).toEqual({
      listingId: 'apl_1',
      cover: 'placeholder',
      blockedReason: null,
    });
    expect(listingApi.getMyListingForApp).toHaveBeenCalledWith({ slug: 'tip-calculator' });
  });

  it('reads no listing as none, and any other failure as unreadable', async () => {
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

  it('prices an estimate as the SDK does: not failed, and 0 is a price', async () => {
    const priced = (estimate: Awaited<ReturnType<CoverOrchestration['estimateWorkflow']>>) =>
      browserDeps(api(), orchestration({ estimateWorkflow: vi.fn(async () => estimate) })).estimate(
        appCoverWorkflow('a', 1)
      );
    expect(await priced({ status: 'pending', cost: { total: 0 } })).toBe(0);
    expect(await priced({ status: 'failed', cost: { total: 12 } })).toBeNull();
    expect(await priced({ status: 'pending' })).toBeNull();
  });

  it('returns the generated image, and fails without one', async () => {
    const workflow = appCoverWorkflow('a', 1);
    expect(await browserDeps(api()).generate(workflow)).toBe(IMAGE_URL);
    for (const done of [
      { status: 'failed', steps: [] },
      {
        status: 'succeeded',
        steps: [{ output: { images: [{ url: IMAGE_URL, available: false }] } }],
      },
      { status: 'succeeded', steps: [{ output: { images: [] } }] },
    ]) {
      const client = orchestration({ waitForWorkflow: vi.fn(async () => done) });
      await expect(browserDeps(api(), client).generate(workflow)).rejects.toThrow(
        COVER_NOT_GENERATED
      );
    }
  });
});

describe('the offer to make a cover', () => {
  const sandbox = { name: 'sbx-1', app: 'tip-calculator', state: 'running' as const };
  const instructions = (
    extra: Parameters<typeof buildAssistantInstructions>[0] extends infer T ? Partial<T> : never
  ) =>
    buildAssistantInstructions({
      sandbox,
      apps: [],
      canPreview: true,
      previewHost: null,
      ...extra,
    });

  it('is made while the listing has no cover, or only the generated placeholder', () => {
    expect(instructions({ listingCover: 'none' })).toContain(OFFER_COVER);
    expect(instructions({ listingCover: 'placeholder' })).toContain(OFFER_COVER);
  });

  it('is not made for the author’s own cover, with no listing, or on the server runner', () => {
    expect(instructions({ listingCover: 'custom' })).not.toContain(OFFER_COVER);
    expect(instructions({ listingCover: null })).not.toContain(OFFER_COVER);
    expect(instructions({ listingCover: 'none', runner: 'remote' })).not.toContain(OFFER_COVER);
  });
});
