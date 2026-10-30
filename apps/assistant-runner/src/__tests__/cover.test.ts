import {
  APP_COVER_MODEL,
  COVER_LISTING_UNREADABLE,
  COVER_NO_APP,
  COVER_NO_LISTING,
  COVER_NOT_GENERATED,
  COVER_ON_DRAFT,
  COVER_ON_LISTING_IN_REVIEW,
  COVER_SCAN_PENDING,
  GENERATE_APP_COVER,
  coverNotAttached,
  createCoverArt,
  type CoverListing,
} from '@civitai/app-assistant';
import { describe, expect, it, vi } from 'vitest';

import {
  COVER_PATH,
  CivitaiCovers,
  CoverRefusedError,
  runnerCoverOrchestration,
  runnerCoverTools,
  type CoverListings,
} from '../app-assistant/cover';
import { OrchestrationClient } from '../orchestration';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY placeholders: never real credentials or hosts.
const CIVITAI = 'https://civitai.example';
const SECRET = 'test-only-runner-secret-cover';
const GRANT = 'test-only-grant-cover';
const IMAGE_URL = 'https://orchestration.example/blobs/cover-unit.jpeg';
// Pairwise distinct: no app key, listing id or status equals another.
const APP = 'tip-calculator';
const LISTING: CoverListing = { listingId: 'apl_31', blockedReason: null, status: 'approved' };

/** Each one a mock, overridden or not, so a test reads its calls. */
function listings(overrides: Partial<Record<keyof CoverListings, ReturnType<typeof vi.fn>>> = {}) {
  return {
    listing: vi.fn(
      async (_app: string, _signal?: AbortSignal): Promise<CoverListing | null> => LISTING
    ),
    attach: vi.fn(async (_input: { app: string; listingId: string; url: string }) => ({
      scanPending: true,
    })),
    ...overrides,
  };
}

function orchestration(
  overrides: Partial<{
    submitWorkflow: ReturnType<typeof vi.fn>;
    waitForWorkflow: ReturnType<typeof vi.fn>;
    cancelWorkflow: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    submitWorkflow: vi.fn(async () => ({ id: 'wf_31', status: 'submitted' })),
    waitForWorkflow: vi.fn(async () => ({
      id: 'wf_31',
      status: 'succeeded',
      steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }],
    })),
    cancelWorkflow: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup({
  app = APP as string | null,
  listing = listings(),
  client = orchestration(),
}: {
  app?: string | null;
  listing?: ReturnType<typeof listings>;
  client?: ReturnType<typeof orchestration>;
} = {}) {
  const tool = runnerCoverTools({
    currentApp: () => app,
    listings: listing,
    orchestration: client,
    newId: () => 'n31',
    seed: () => 31,
  })[GENERATE_APP_COVER]!;
  const call = (input: Record<string, unknown>, signal?: AbortSignal) =>
    Promise.resolve(
      (tool.execute as (i: Record<string, unknown>, c?: { signal?: AbortSignal }) => unknown)(
        input,
        signal ? { signal } : undefined
      )
    );
  return { tool, call, listing, client };
}

describe('generate_app_cover on the runner: the page’s own tool', () => {
  it('is the shared tool, with the same description and input', () => {
    const { tool } = setup();
    const shared = createCoverArt({
      currentApp: () => null,
      listing: async () => null,
      generate: async () => '',
      attach: async () => ({ scanPending: false }),
    })[GENERATE_APP_COVER]!;
    expect(tool.description).toBe(shared.description);
    expect(tool.inputSchema).toEqual(shared.inputSchema);
    expect(tool.activity).toBe(shared.activity);
  });

  it('reads the listing, generates the fixed recipe, and attaches it to that listing', async () => {
    const { call, listing, client } = setup();
    const result = await call({ prompt: 'a calculator on a desk', model: 'urn:air:other' });
    expect(listing.listing.mock.calls[0]![0]).toBe(APP);
    const workflow = client.submitWorkflow.mock.calls[0]![0] as {
      steps: { input: { model: string; prompt: string; seed: number } }[];
      externalId: string;
    };
    expect(workflow.steps[0]!.input).toMatchObject({
      model: APP_COVER_MODEL,
      prompt: 'a calculator on a desk',
      seed: 31,
    });
    expect(workflow.externalId).toBe('app-cover-n31');
    expect(listing.attach.mock.calls[0]![0]).toEqual({
      app: APP,
      listingId: LISTING.listingId,
      url: IMAGE_URL,
    });
    expect(result).toEqual({ attached: true, note: `${COVER_ON_DRAFT} ${COVER_SCAN_PENDING}` });
  });

  it('says a listing under review shows it once approved', async () => {
    const { call } = setup({
      listing: listings({
        listing: vi.fn(async () => ({ ...LISTING, status: 'pending' })),
        attach: vi.fn(async () => ({ scanPending: false })),
      }),
    });
    expect(await call({ prompt: 'a' })).toEqual({
      attached: true,
      note: COVER_ON_LISTING_IN_REVIEW,
    });
  });
});

describe('generate_app_cover on the runner: nothing is spent when there is nothing to put it on', () => {
  it('generates nothing for an app with no listing, and says so', async () => {
    const { call, client, listing } = setup({
      listing: listings({ listing: vi.fn(async () => null) }),
    });
    await expect(call({ prompt: 'a' })).rejects.toThrow(COVER_NO_LISTING);
    expect(client.submitWorkflow).not.toHaveBeenCalled();
    expect(listing.attach).not.toHaveBeenCalled();
  });

  it('generates nothing for a listing whose media cannot be edited, saying why', async () => {
    const reason = 'This listing is locked while a moderator reviews it.';
    const { call, client } = setup({
      listing: listings({ listing: vi.fn(async () => ({ ...LISTING, blockedReason: reason })) }),
    });
    await expect(call({ prompt: 'a' })).rejects.toThrow(reason);
    expect(client.submitWorkflow).not.toHaveBeenCalled();
  });

  it('generates nothing with no app open, or an app key that is no listing slug', async () => {
    for (const app of [null, 'Not A Slug']) {
      const { call, client, listing } = setup({ app });
      await expect(call({ prompt: 'a' })).rejects.toThrow(COVER_NO_APP);
      expect(listing.listing).not.toHaveBeenCalled();
      expect(client.submitWorkflow).not.toHaveBeenCalled();
    }
  });

  it('generates nothing when the listing cannot be read', async () => {
    const { call, client } = setup({
      listing: listings({
        listing: vi.fn(async () => {
          throw new CoverRefusedError(COVER_LISTING_UNREADABLE, 503, 'unavailable');
        }),
      }),
    });
    await expect(call({ prompt: 'a' })).rejects.toThrow(COVER_LISTING_UNREADABLE);
    expect(client.submitWorkflow).not.toHaveBeenCalled();
  });

  it('stops the run, and attaches nothing, when the user stops the reply while it generates', async () => {
    const stop = new AbortController();
    const stopped = new DOMException('Aborted', 'AbortError');
    const client = orchestration({
      waitForWorkflow: vi.fn(async () => {
        stop.abort();
        throw stopped;
      }),
    });
    const { call, listing } = setup({ client });
    await expect(call({ prompt: 'a' }, stop.signal)).rejects.toBe(stopped);
    expect(client.cancelWorkflow).toHaveBeenCalledWith('wf_31');
    expect(listing.attach).not.toHaveBeenCalled();
  });

  it('names the paid-for image when civitai refuses to attach it', async () => {
    const reason = 'cover must be landscape';
    const { call } = setup({
      listing: listings({
        attach: vi.fn(async () => {
          throw new CoverRefusedError(reason, 422, 'not_attached');
        }),
      }),
    });
    await expect(call({ prompt: 'a' })).rejects.toThrow(coverNotAttached(reason, IMAGE_URL));
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

describe('civitai’s cover endpoints, as the run’s user', () => {
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

  it('attaches to the listing it names for the app, and reports the scan', async () => {
    const { doFetch, sent } = answering(200, { scanPending: true });
    const input = { app: APP, listingId: LISTING.listingId, url: IMAGE_URL };
    expect(await covers(doFetch).attach(input)).toEqual({ scanPending: true });
    expect(sent[0]!.url).toBe(`${CIVITAI}/${COVER_PATH}/attach`);
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({ grant: GRANT, ...input });
  });

  it('passes on civitai’s refusal in its own words', async () => {
    const { doFetch } = answering(404, { error: COVER_NO_LISTING, code: 'NOT_FOUND' });
    const attempt = covers(doFetch).attach({ app: APP, listingId: 'apl_other', url: IMAGE_URL });
    await expect(attempt).rejects.toBeInstanceOf(CoverRefusedError);
    await expect(attempt).rejects.toMatchObject({
      message: COVER_NO_LISTING,
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('asks nothing without a live grant', async () => {
    const { doFetch } = answering(200, { listing: LISTING });
    await expect(covers(doFetch, null).listing(APP)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('the cover’s orchestration on the run’s chat token', () => {
  it('submits on the chat token and says what orchestration refused it with', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ detail: 'Not enough Buzz for this.' }), { status: 400 });
    }) as typeof fetch;
    const client = runnerCoverOrchestration(
      new OrchestrationClient('https://orchestration.example', doFetch),
      async (purpose) => `test-token-${purpose}`
    );
    const workflow = { steps: [] as never, externalId: 'app-cover-x' };
    await expect(client.submitWorkflow(workflow as never)).rejects.toThrow(
      'Not enough Buzz for this.'
    );
    expect(seen[0]!.url).toBe('https://orchestration.example/v2/consumer/workflows');
    expect(seen[0]!.auth).toBe('Bearer test-token-chat');
  });

  it('waits until the workflow ends', async () => {
    const reads = [
      { status: 'processing' },
      { status: 'processing' },
      { status: 'succeeded', steps: [] },
    ];
    const getWorkflow = vi.fn(async () => reads.shift()!);
    const client = runnerCoverOrchestration(
      { submitWorkflow: vi.fn(), getWorkflow, cancelWorkflow: vi.fn() } as never,
      async () => 'test-token',
      { pollMs: 1 }
    );
    expect(await client.waitForWorkflow('wf_31')).toMatchObject({ status: 'succeeded' });
    expect(getWorkflow).toHaveBeenCalledTimes(3);
  });

  it('gives up, and cancels the run, once it has waited too long', async () => {
    const cancelWorkflow = vi.fn(async () => undefined);
    const client = runnerCoverOrchestration(
      {
        submitWorkflow: vi.fn(),
        getWorkflow: vi.fn(async () => ({ status: 'processing' })),
        cancelWorkflow,
      } as never,
      async () => 'test-token',
      { maxWaitMs: 5, pollMs: 2 }
    );
    await expect(client.waitForWorkflow('wf_slow')).rejects.toThrow(COVER_NOT_GENERATED);
    expect(cancelWorkflow).toHaveBeenCalledWith(expect.any(Function), 'wf_slow');
  });
});
