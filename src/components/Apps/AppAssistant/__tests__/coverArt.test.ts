import { describe, expect, it, vi } from 'vitest';
import type {
  AppCoverWorkflow,
  CoverArtDeps,
  CoverListing,
  CoverListingApi,
  CoverOffer,
  CoverPressDeps,
  ListingForCover,
  PageCoverOrchestration,
} from '~/components/Apps/AppAssistant/coverArt';
import {
  APP_COVER_HEIGHT,
  APP_COVER_MODEL,
  APP_COVER_PROMPT_MAX,
  APP_COVER_WIDTH,
  COVER_LISTING_CHANGED,
  COVER_LISTING_UNREADABLE,
  COVER_NO_APP,
  COVER_NO_LISTING,
  COVER_NO_PROMPT,
  COVER_NOT_GENERATED,
  COVER_ON_DRAFT,
  COVER_ON_LISTING_IN_REVIEW,
  COVER_PRICE_UNCHECKED,
  COVER_PRICE_UNREADABLE,
  COVER_SCAN_PENDING,
  CoverPriceRoseError,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  coverMaybeNotAttached,
  coverNotAttached,
  coverOfferOf,
  coverPriceRose,
  coverWorkflowFor,
  createBrowserCoverDeps,
  createCoverArt,
  makeOfferedCover,
} from '~/components/Apps/AppAssistant/coverArt';
import { validateListingImage } from '~/server/schema/blocks/app-listing.schema';

/**
 * `generate_app_cover` OFFERS a cover with its price and spends nothing; only a press on its card
 * (`makeOfferedCover`) generates and attaches, as the user.
 */

const LISTING: CoverListing = { listingId: 'apl_1', blockedReason: null, status: 'approved' };
const IMAGE_URL = 'https://orchestration.example/blobs/cover.jpeg';
// Pairwise distinct: no price equals a seed, an id or a count used here.
const PRICE = 37;
const SEED = 4242;

function setup(overrides: Partial<CoverArtDeps> = {}) {
  let app: string | null = 'tip-calculator';
  let ids = 0;
  // A generate the tool must never reach: it is not one of its deps, and a call here is a spend.
  const generate = vi.fn(async (_w: AppCoverWorkflow) => IMAGE_URL);
  const deps = {
    currentApp: () => app,
    listing: vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING),
    price: vi.fn(async (_w: AppCoverWorkflow) => PRICE),
    nextId: () => `o${++ids}`,
    seed: () => SEED,
    ...overrides,
  };
  const tool = createCoverArt({ ...deps, generate } as CoverArtDeps)[GENERATE_APP_COVER]!;
  const call = (input: Record<string, unknown>) => Promise.resolve(tool.execute(input));
  return { deps, call, generate, setApp: (next: string | null) => (app = next) };
}

describe('generate_app_cover: an offer, never a spend', () => {
  it('generates nothing: it reads the listing, prices the cover and offers it', async () => {
    const { deps, call, generate } = setup();
    const offer = (await call({ prompt: '  a calculator on a sunny desk  ' })) as CoverOffer;
    expect(generate).not.toHaveBeenCalled();
    expect(deps.listing).toHaveBeenCalledWith('tip-calculator', undefined);
    expect(deps.price).toHaveBeenCalledTimes(1);
    expect(offer).toMatchObject({
      awaitsUser: true,
      coverOffer: 'o1',
      app: 'tip-calculator',
      listingId: 'apl_1',
      listingStatus: 'approved',
      prompt: 'a calculator on a sunny desk',
      seed: SEED,
      buzz: PRICE,
    });
    expect(offer.note).toContain(`about ${PRICE} Buzz`);
    expect(offer.note).toContain('Nothing is generated or spent until they press it');
  });

  it('prices the fixed recipe, whatever else the call asks for', async () => {
    const { deps, call } = setup();
    await call({
      prompt: 'a calculator',
      model: 'urn:air:other',
      width: 64,
      steps: [{ $type: 'videoGen' }],
    });
    // Pinned literally, not from `appCoverWorkflow`: a recipe change has to change this test.
    const priced = deps.price.mock.calls[0]![0];
    expect(priced).toEqual({
      steps: [
        {
          $type: 'textToImage',
          input: {
            model: APP_COVER_MODEL,
            prompt: 'a calculator',
            negativePrompt: 'text, words, letters, watermark, logo, signature, blurry, lowres',
            width: 1344,
            height: 768,
            steps: 25,
            cfgScale: 7,
            seed: SEED,
            quantity: 1,
            outputFormat: 'jpeg',
          },
        },
      ],
    });
    // None of the call's own model, width or steps reached the priced workflow.
    expect(priced.steps).toHaveLength(1);
    expect(priced.steps[0].input.model).not.toBe('urn:air:other');
    expect(priced.steps[0].input.width).not.toBe(64);
    expect(priced.steps[0].$type).not.toBe('videoGen');
  });

  it('cuts the prompt to its cap', async () => {
    const { call } = setup();
    const offer = (await call({ prompt: 'x'.repeat(APP_COVER_PROMPT_MAX + 50) })) as CoverOffer;
    expect(offer.prompt).toHaveLength(APP_COVER_PROMPT_MAX);
  });

  it('gives every offer its own id', async () => {
    const { call } = setup();
    const a = (await call({ prompt: 'a' })) as CoverOffer;
    const b = (await call({ prompt: 'a' })) as CoverOffer;
    expect([a.coverOffer, b.coverOffer]).toEqual(['o1', 'o2']);
  });

  it('makes an image the cover check accepts', () => {
    expect(appCoverWorkflow('a', 1).steps[0].input).toMatchObject({
      model: APP_COVER_MODEL,
      width: APP_COVER_WIDTH,
      height: APP_COVER_HEIGHT,
    });
    expect(
      validateListingImage(
        { type: 'image', width: APP_COVER_WIDTH, height: APP_COVER_HEIGHT, mimeType: 'image/jpeg' },
        'cover'
      )
    ).toEqual({ ok: true });
  });
});

describe('generate_app_cover: no offer when there is nothing to put it on, or no price', () => {
  it('offers nothing with no app open, or no prompt', async () => {
    const s = setup();
    s.setApp(null);
    await expect(s.call({ prompt: 'a' })).rejects.toThrow(COVER_NO_APP);
    s.setApp('tip-calculator');
    await expect(s.call({ prompt: '   ' })).rejects.toThrow(COVER_NO_PROMPT);
    expect(s.deps.listing).not.toHaveBeenCalled();
    expect(s.deps.price).not.toHaveBeenCalled();
  });

  it('offers nothing, and prices nothing, for an app with no listing or a locked one', async () => {
    const none = setup({ listing: vi.fn(async () => null) });
    await expect(none.call({ prompt: 'a' })).rejects.toThrow(COVER_NO_LISTING);
    expect(none.deps.price).not.toHaveBeenCalled();
    const reason = 'This listing is locked while it is reviewed.';
    const locked = setup({ listing: vi.fn(async () => ({ ...LISTING, blockedReason: reason })) });
    await expect(locked.call({ prompt: 'a' })).rejects.toThrow(reason);
    expect(locked.deps.price).not.toHaveBeenCalled();
  });

  it('offers nothing when the price cannot be read', async () => {
    for (const price of [
      vi.fn(async () => Promise.reject(new Error('orchestration answered 500'))),
      vi.fn(async () => Number.NaN),
    ]) {
      const { call } = setup({ price });
      await expect(call({ prompt: 'a' })).rejects.toThrow(COVER_PRICE_UNREADABLE);
    }
  });
});

const OFFER: CoverOffer = {
  awaitsUser: true,
  coverOffer: 'o9',
  app: 'tip-calculator',
  listingId: 'apl_1',
  listingStatus: 'approved',
  prompt: 'a calculator',
  seed: SEED,
  buzz: PRICE,
  note: 'n',
};

describe('the offer a call made', () => {
  const result = (output: unknown, extra: Record<string, unknown> = {}) => ({
    name: GENERATE_APP_COVER,
    input: {},
    output,
    isError: false,
    ...extra,
  });

  it('reads a live offer, and nothing a subagent, a refusal or a failure made', () => {
    expect(coverOfferOf(result(OFFER))).toEqual(OFFER);
    expect(coverOfferOf(result(OFFER, { subagent: 'd1' }))).toBeNull();
    expect(coverOfferOf(result(OFFER, { refused: 'no' }))).toBeNull();
    expect(coverOfferOf(result(OFFER, { isError: true }))).toBeNull();
    expect(coverOfferOf({ ...result(OFFER), name: 'other' })).toBeNull();
  });

  it('reads no offer whose fields are not the tool’s', () => {
    for (const bad of [
      { ...OFFER, awaitsUser: false },
      { ...OFFER, app: 'Not A Slug' },
      { ...OFFER, prompt: 'x'.repeat(APP_COVER_PROMPT_MAX + 1) },
      { ...OFFER, seed: -1 },
      { ...OFFER, buzz: Number.NaN },
      { ...OFFER, coverOffer: '' },
    ])
      expect(coverOfferOf(result(bad))).toBeNull();
  });
});

function press(overrides: Partial<CoverPressDeps> = {}) {
  return {
    listing: vi.fn(async (_app: string): Promise<CoverListing | null> => LISTING),
    // The re-quote at the press: the offered price unless a case says otherwise.
    price: vi.fn(async (_w: AppCoverWorkflow, _s?: AbortSignal) => PRICE),
    generate: vi.fn(async (_w: AppCoverWorkflow, _s?: AbortSignal) => IMAGE_URL),
    attach: vi.fn(async (_id: string, _url: string, _app: string) => ({ scanPending: true })),
    ...overrides,
  };
}

describe('the press: the user makes the offered cover', () => {
  it('generates exactly the offered recipe, under one id per offer, and attaches it', async () => {
    const deps = press();
    const said = await makeOfferedCover(deps, OFFER);
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.generate.mock.calls[0]![0]).toEqual({
      ...appCoverWorkflow('a calculator', SEED),
      externalId: 'app-cover-o9',
    });
    expect(coverWorkflowFor(OFFER).externalId).toBe('app-cover-o9');
    expect(deps.attach).toHaveBeenCalledWith('apl_1', IMAGE_URL, 'tip-calculator');
    expect(said).toBe(`${COVER_ON_DRAFT} ${COVER_SCAN_PENDING}`);
  });

  it('says a listing under review shows it once approved', async () => {
    const deps = press({
      listing: vi.fn(async () => ({ ...LISTING, status: 'pending' })),
      attach: vi.fn(async () => ({ scanPending: false })),
    });
    expect(await makeOfferedCover(deps, OFFER)).toBe(COVER_ON_LISTING_IN_REVIEW);
  });

  it('spends nothing when the listing is gone, another one, or locked since the offer', async () => {
    for (const listing of [null, { ...LISTING, listingId: 'apl_other' }]) {
      const deps = press({ listing: vi.fn(async () => listing) });
      await expect(makeOfferedCover(deps, OFFER)).rejects.toThrow(COVER_LISTING_CHANGED);
      expect(deps.generate).not.toHaveBeenCalled();
    }
    const reason = 'Locked for review.';
    const deps = press({ listing: vi.fn(async () => ({ ...LISTING, blockedReason: reason })) });
    await expect(makeOfferedCover(deps, OFFER)).rejects.toThrow(reason);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it('prices the offered recipe again at the press, as the offer did', async () => {
    const deps = press();
    await makeOfferedCover(deps, OFFER);
    expect(deps.price).toHaveBeenCalledTimes(1);
    expect(deps.price.mock.calls[0]![0]).toEqual(appCoverWorkflow('a calculator', SEED));
  });

  it('generates nothing when the price rose since the offer, and names the new price', async () => {
    const risen = PRICE + 6;
    const deps = press({ price: vi.fn(async () => risen) });
    const pressed = makeOfferedCover(deps, OFFER);
    await expect(pressed).rejects.toBeInstanceOf(CoverPriceRoseError);
    await expect(makeOfferedCover(deps, OFFER)).rejects.toMatchObject({ buzz: risen });
    await expect(makeOfferedCover(deps, OFFER)).rejects.toThrow(coverPriceRose(risen));
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.attach).not.toHaveBeenCalled();
  });

  it('generates at the press when the price is the same or lower', async () => {
    for (const now of [PRICE, PRICE - 9]) {
      const deps = press({ price: vi.fn(async () => now) });
      await makeOfferedCover(deps, OFFER);
      expect(deps.generate).toHaveBeenCalledTimes(1);
    }
  });

  it('generates nothing when the price cannot be checked at the press', async () => {
    for (const price of [
      vi.fn(async () => Promise.reject(new Error('orchestration down'))),
      vi.fn(async () => Number.NaN),
    ]) {
      const deps = press({ price });
      await expect(makeOfferedCover(deps, OFFER)).rejects.toThrow(COVER_PRICE_UNCHECKED);
      expect(deps.generate).not.toHaveBeenCalled();
    }
  });
});

const IMAGE_ID = 77;
function api(overrides: Partial<CoverListingApi> = {}) {
  return {
    getMyListingForApp: vi.fn(
      async (): Promise<ListingForCover> => ({
        appListingId: 'apl_1',
        status: 'approved',
        editBlockedReason: null,
      })
    ),
    ingestAssetFromUrl: vi.fn(async () => ({ imageId: IMAGE_ID })),
    setCover: vi.fn(async () => ({ status: 'ok', scanPending: true })),
    ...overrides,
  };
}

function orchestration(overrides: Partial<Record<keyof PageCoverOrchestration, unknown>> = {}) {
  return {
    submitWorkflow: vi.fn(async () => ({ id: 'wf_1', status: 'submitted' })),
    waitForWorkflow: vi.fn(async () => ({
      id: 'wf_1',
      status: 'succeeded',
      steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }],
    })),
    cancelWorkflow: vi.fn(async () => undefined),
    estimateWorkflow: vi.fn(async () => ({ cost: { total: 36.2 } })),
    ...overrides,
  } as unknown as PageCoverOrchestration & Record<string, ReturnType<typeof vi.fn>>;
}

function browserDeps(listingApi = api(), client = orchestration(), onAttached?: () => void) {
  return createBrowserCoverDeps({
    currentApp: () => 'tip-calculator',
    api: listingApi,
    orchestration: async () => client,
    ...(onAttached ? { onAttached } : {}),
  });
}

describe('the page’s cover: priced and made on the user’s own token and procedures', () => {
  it('prices with the what-if, rounded up, and submits nothing', async () => {
    const client = orchestration();
    const workflow = appCoverWorkflow('a', 1);
    expect(await browserDeps(api(), client).offer.price(workflow)).toBe(37);
    expect(client.estimateWorkflow).toHaveBeenCalledWith(workflow);
    expect(client.submitWorkflow).not.toHaveBeenCalled();
  });

  it('reads no price from a quote without one', async () => {
    const client = orchestration({ estimateWorkflow: vi.fn(async () => ({})) });
    await expect(browserDeps(api(), client).offer.price(appCoverWorkflow('a', 1))).rejects.toThrow(
      COVER_PRICE_UNREADABLE
    );
  });

  it('reads the user’s listing, no listing as none, and any other failure as unreadable', async () => {
    const coded = (code: string) => Object.assign(new Error('x'), { data: { code } });
    const reason = 'This listing is locked while it is reviewed.';
    const locked = api({
      getMyListingForApp: vi.fn(async () => ({
        appListingId: 'apl_locked_3',
        status: 'pending',
        editBlockedReason: reason,
      })),
    });
    expect(await browserDeps(locked).offer.listing('tip-calculator')).toEqual({
      listingId: 'apl_locked_3',
      blockedReason: reason,
      status: 'pending',
    });
    expect(locked.getMyListingForApp).toHaveBeenCalledWith({ slug: 'tip-calculator' });
    for (const code of ['NOT_FOUND', 'FORBIDDEN']) {
      const listingApi = api({
        getMyListingForApp: vi.fn(async () => Promise.reject(coded(code))),
      });
      expect(await browserDeps(listingApi).offer.listing('tip-calculator')).toBeNull();
    }
    const listingApi = api({
      getMyListingForApp: vi.fn(async () => Promise.reject(coded('INTERNAL_SERVER_ERROR'))),
    });
    await expect(browserDeps(listingApi).offer.listing('tip-calculator')).rejects.toThrow(
      COVER_LISTING_UNREADABLE
    );
  });

  it('refuses the offer for a locked listing on the page path, and prices nothing', async () => {
    const reason = 'This listing is locked while it is reviewed.';
    const client = orchestration();
    const deps = browserDeps(
      api({
        getMyListingForApp: vi.fn(async () => ({
          appListingId: 'apl_locked_3',
          status: 'pending',
          editBlockedReason: reason,
        })),
      }),
      client
    );
    const tool = createCoverArt({ ...deps.offer, nextId: () => 'o1' })[GENERATE_APP_COVER]!;
    await expect(Promise.resolve(tool.execute({ prompt: 'a calculator' }))).rejects.toThrow(reason);
    expect(client.estimateWorkflow).not.toHaveBeenCalled();
  });

  it('re-prices at the press with the same what-if the offer used', async () => {
    const client = orchestration();
    expect(await browserDeps(api(), client).press.price(appCoverWorkflow('a', 1))).toBe(37);
    expect(client.estimateWorkflow).toHaveBeenCalledTimes(1);
    expect(client.submitWorkflow).not.toHaveBeenCalled();
  });

  it('ingests the generated image as a cover upload, then sets it as the listing’s cover', async () => {
    const listingApi = api();
    const onAttached = vi.fn();
    const result = await browserDeps(listingApi, orchestration(), onAttached).press.attach(
      'apl_1',
      IMAGE_URL,
      'tip-calculator'
    );
    expect(listingApi.ingestAssetFromUrl).toHaveBeenCalledWith({ url: IMAGE_URL, kind: 'cover' });
    expect(listingApi.setCover).toHaveBeenCalledWith({ listingId: 'apl_1', imageId: IMAGE_ID });
    expect(result).toEqual({ scanPending: true });
    expect(onAttached).toHaveBeenCalledTimes(1);
  });

  it('names the paid-for image: refused for sure, or maybe attached when civitai did not answer', async () => {
    const reason = 'cover must be landscape';
    const refused = api({
      setCover: vi.fn(async () =>
        Promise.reject(Object.assign(new Error(reason), { data: { code: 'BAD_REQUEST' } }))
      ),
    });
    await expect(
      browserDeps(refused).press.attach('apl_1', IMAGE_URL, 'tip-calculator')
    ).rejects.toThrow(coverNotAttached(reason, IMAGE_URL));
    const silent = api({
      setCover: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(
      browserDeps(silent).press.attach('apl_1', IMAGE_URL, 'tip-calculator')
    ).rejects.toThrow(coverMaybeNotAttached(IMAGE_URL));
  });

  it('cancels the run when the user leaves while it is generating', async () => {
    const controller = new AbortController();
    const stopped = new DOMException('Aborted', 'AbortError');
    const client = orchestration({
      waitForWorkflow: vi.fn(async () => {
        controller.abort();
        throw stopped;
      }),
    });
    const workflow = coverWorkflowFor(OFFER);
    await expect(
      browserDeps(api(), client).press.generate(workflow, controller.signal)
    ).rejects.toBe(stopped);
    expect(client.cancelWorkflow).toHaveBeenCalledWith('wf_1');
  });

  // Once submitted it is paid for as it runs: a wait that fails for any reason cancels it.
  it('cancels the paid run, and says it was not made, when the wait fails on its own', async () => {
    const client = orchestration({
      waitForWorkflow: vi.fn(async () => Promise.reject(new Error('network'))),
    });
    await expect(
      browserDeps(api(), client).press.generate(
        coverWorkflowFor(OFFER),
        new AbortController().signal
      )
    ).rejects.toThrow(COVER_NOT_GENERATED);
    expect(client.cancelWorkflow).toHaveBeenCalledWith('wf_1');
  });

  it('fails without a generated image, and attaches nothing', async () => {
    for (const done of [
      // Failed, though it reports an image: the status alone must refuse it.
      { status: 'failed', steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }] },
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
      await expect(makeOfferedCover(deps.press, OFFER)).rejects.toThrow(COVER_NOT_GENERATED);
      expect(listingApi.ingestAssetFromUrl).not.toHaveBeenCalled();
      expect(listingApi.setCover).not.toHaveBeenCalled();
    }
  });
});
