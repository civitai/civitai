import {
  COVER_LISTING_UNREADABLE,
  COVER_NO_LISTING,
  COVER_PRICE_UNREADABLE,
  GENERATE_APP_COVER,
  appCoverWorkflow,
  createCoverArt,
  type CoverListing,
  type CoverOffer,
} from '@civitai/app-assistant';
import { describe, expect, it, vi } from 'vitest';

import {
  COVER_PATH,
  CivitaiCovers,
  CoverRefusedError,
  runnerCoverEstimator,
  runnerCoverTools,
  type CoverListings,
} from '../app-assistant/cover';
import { OrchestrationClient } from '../orchestration';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY placeholders: never real credentials or hosts.
const CIVITAI = 'https://civitai.example';
const SECRET = 'test-only-runner-secret-cover';
const GRANT = 'test-only-grant-cover';
const ORCHESTRATION = 'https://orchestration.example';
// Pairwise distinct: no app key, listing id, price or seed equals another.
const APP = 'tip-calculator';
const LISTING: CoverListing = { listingId: 'apl_31', blockedReason: null, status: 'approved' };
const PRICE = 29;

function setup(listing: CoverListing | null = LISTING) {
  const listings = { listing: vi.fn(async (_app: string, _signal?: AbortSignal) => listing) };
  const estimator = { estimateWorkflow: vi.fn(async () => ({ cost: { total: PRICE } })) };
  const tool = runnerCoverTools({
    currentApp: () => APP,
    listings: listings as CoverListings,
    estimator,
    nextId: () => 'run-1-cover-1',
    seed: () => 31,
  })[GENERATE_APP_COVER]!;
  return {
    tool,
    listings,
    estimator,
    call: (input: Record<string, unknown>) => Promise.resolve(tool.execute(input)),
  };
}

describe('generate_app_cover on the runner: the page’s own tool, offering only', () => {
  it('is the shared tool, with the same description and input', () => {
    const { tool } = setup();
    const shared = createCoverArt({
      currentApp: () => null,
      listing: async () => null,
      price: async () => 0,
      nextId: () => '',
    })[GENERATE_APP_COVER]!;
    expect(tool.description).toBe(shared.description);
    expect(tool.inputSchema).toEqual(shared.inputSchema);
  });

  it('offers the cover with orchestration’s price for the fixed recipe', async () => {
    const { call, estimator } = setup();
    const offer = (await call({ prompt: 'a calculator' })) as CoverOffer;
    expect(estimator.estimateWorkflow).toHaveBeenCalledWith(appCoverWorkflow('a calculator', 31));
    expect(offer).toMatchObject({ coverOffer: 'run-1-cover-1', buzz: PRICE, seed: 31 });
  });

  it('prices nothing, and offers nothing, for an app with no listing', async () => {
    const { call, estimator } = setup(null);
    await expect(call({ prompt: 'a' })).rejects.toThrow(COVER_NO_LISTING);
    expect(estimator.estimateWorkflow).not.toHaveBeenCalled();
  });
});

/** A fetch that answers `status` with `body` and records what it was sent. */
function answering(status: number, body: unknown) {
  const sent: { url: string; init: RequestInit }[] = [];
  const doFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { doFetch, sent };
}

describe('civitai’s cover listing read, as the run’s user', () => {
  const covers = (doFetch: typeof fetch, grant: string | null = GRANT) =>
    new CivitaiCovers({
      civitaiUrl: `${CIVITAI}/`,
      secret: SECRET,
      log: quiet,
      fetch: doFetch,
    }).forRun(async () => grant);

  it('reads the listing with the runner’s secret and the run’s grant', async () => {
    const { doFetch, sent } = answering(200, { listing: LISTING });
    expect(await covers(doFetch).listing(APP)).toEqual(LISTING);
    expect(sent[0]!.url).toBe(`${CIVITAI}/${COVER_PATH}/listing`);
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`
    );
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ grant: GRANT, app: APP });
  });

  it('answers no listing as none, and an odd answer as unreadable', async () => {
    expect(await covers(answering(200, { listing: null }).doFetch).listing(APP)).toBeNull();
    await expect(
      covers(answering(200, { listing: { listingId: 7 } }).doFetch).listing(APP)
    ).rejects.toThrow(COVER_LISTING_UNREADABLE);
  });

  it('passes on civitai’s refusal in its own words', async () => {
    const { doFetch } = answering(403, { error: 'Apps authoring is off.', code: 'FORBIDDEN' });
    const attempt = covers(doFetch).listing(APP);
    await expect(attempt).rejects.toBeInstanceOf(CoverRefusedError);
    await expect(attempt).rejects.toMatchObject({ message: 'Apps authoring is off.', status: 403 });
  });

  it('asks nothing without a live grant', async () => {
    const { doFetch } = answering(200, { listing: LISTING });
    await expect(covers(doFetch, null).listing(APP)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('the cover’s price on the run’s chat token', () => {
  it('asks orchestration’s what-if on the chat token, and submits nothing', async () => {
    const seen: { url: string; method?: string; auth: string | null }[] = [];
    const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        ...(init?.method ? { method: init.method } : {}),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ cost: { total: PRICE } }), { status: 200 });
    }) as typeof fetch;
    const estimator = runnerCoverEstimator(
      new OrchestrationClient(ORCHESTRATION, doFetch),
      async (purpose) => `test-token-${purpose}`
    );
    expect(await estimator.estimateWorkflow(appCoverWorkflow('a', 1))).toEqual({
      cost: { total: PRICE },
    });
    expect(seen).toEqual([
      {
        url: `${ORCHESTRATION}/v2/consumer/workflows?whatif=true`,
        method: 'POST',
        auth: 'Bearer test-token-chat',
      },
    ]);
  });

  it('offers nothing when orchestration will not price it', async () => {
    const doFetch = (async () =>
      new Response(JSON.stringify({ detail: 'nope' }), { status: 400 })) as typeof fetch;
    const { tool } = (() => {
      const listings = { listing: vi.fn(async () => LISTING) };
      return {
        tool: runnerCoverTools({
          currentApp: () => APP,
          listings: listings as unknown as CoverListings,
          estimator: runnerCoverEstimator(
            new OrchestrationClient(ORCHESTRATION, doFetch),
            async () => 'test-token'
          ),
          nextId: () => 'x',
        })[GENERATE_APP_COVER]!,
      };
    })();
    await expect(Promise.resolve(tool.execute({ prompt: 'a' }))).rejects.toThrow(
      COVER_PRICE_UNREADABLE
    );
  });
});
