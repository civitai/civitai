import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppAssistantTools, type AppAssistantToolsOptions } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * `generate_app_cover` on the server runner: offered beside the page tools the runner runs, through
 * the same gate. It OFFERS a cover with its price and never generates one: the page's card does, on
 * the user's press. The runner has nothing that could generate (no submit), and a call here only
 * reads the listing and prices the cover.
 */

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PRICE = 41;

let fake: FakeSandboxService;
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

function fakes(
  listing: { listingId: string; blockedReason: string | null; status: string } | null
) {
  return {
    listings: { listing: vi.fn(async (_app: string, _signal?: AbortSignal) => listing) },
    // Everything an orchestration client could be asked: only the what-if may be.
    estimator: {
      estimateWorkflow: vi.fn(async () => ({ cost: { total: PRICE } })),
      submitWorkflow: vi.fn(async () => ({ id: 'wf_never', status: 'submitted' })),
      waitForWorkflow: vi.fn(),
      cancelWorkflow: vi.fn(),
    },
  };
}

async function open(covers?: AppAssistantToolsOptions['covers']) {
  const tools = await new AppAssistantTools({
    sandboxUrl: fake.url,
    tokens: () => async (purpose) => `test-token-${purpose}`,
    log: quiet,
    ...(covers ? { covers } : {}),
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
  }).open({
    userId: 'u-1',
    runId: 'run-cover',
    conversationId: 'conv-cover',
    page: { app: 'my-app' },
    history: chosenApp('my-app'),
    signal: new AbortController().signal,
  });
  opened.push(tools);
  return tools;
}

let callId = 0;
function call(tools: ToolSet, name: string, input: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: `c-${++callId}`, messages: [] } as never)
  );
}

describe('generate_app_cover on the runner', () => {
  it('is offered beside the page tools the runner runs', async () => {
    fake.add('my-app');
    const covers = fakes({ listingId: 'apl_tools', blockedReason: null, status: 'draft' });
    const tools = await open(() => covers);
    expect(tools.hostTools).toContain('generate_app_cover');
    expect(Object.keys(tools.tools)).toContain('generate_app_cover');
  });

  it('generates nothing: it offers the open app’s cover with its price', async () => {
    fake.add('my-app');
    const covers = fakes({ listingId: 'apl_tools', blockedReason: null, status: 'draft' });
    const tools = await open(() => covers);
    const result = await call(tools.tools, 'generate_app_cover', { prompt: 'a tidy calculator' });
    expect(covers.estimator.submitWorkflow).not.toHaveBeenCalled();
    expect(covers.estimator.waitForWorkflow).not.toHaveBeenCalled();
    expect(covers.estimator.estimateWorkflow).toHaveBeenCalledTimes(1);
    expect(covers.listings.listing.mock.calls[0]![0]).toBe('my-app');
    expect(result).toMatchObject({
      awaitsUser: true,
      coverOffer: expect.stringMatching(/^run-cover-cover-/),
      app: 'my-app',
      listingId: 'apl_tools',
      prompt: 'a tidy calculator',
      buzz: PRICE,
    });
  });

  it('names every offer of a run uniquely, across the tool sets a reply opens', async () => {
    // The runner opens the same provider again for the same run when a result asks for new tools
    // (`reopenTools`, an app switch mid-reply). An id that restarts with each open would name a
    // second offer as the first, and the page would show (and press) the first one's card.
    fake.add('my-app');
    const covers = fakes({ listingId: 'apl_tools', blockedReason: null, status: 'draft' });
    const provider = new AppAssistantTools({
      sandboxUrl: fake.url,
      tokens: () => async (purpose) => `test-token-${purpose}`,
      log: quiet,
      covers: () => covers,
      wakePollMs: 5,
      wakeTimeoutMs: 5_000,
    });
    const ids: string[] = [];
    for (const prompt of ['a tidy calculator', 'a sunny desk']) {
      const tools = await provider.open({
        userId: 'u-1',
        runId: 'run-cover',
        conversationId: 'conv-cover',
        page: { app: 'my-app' },
        history: chosenApp('my-app'),
        signal: new AbortController().signal,
      });
      opened.push(tools);
      const offer = (await call(tools.tools, 'generate_app_cover', { prompt })) as {
        coverOffer?: string;
      };
      ids.push(String(offer.coverOffer));
    }
    expect(ids[0]).toMatch(/^run-cover-cover-/);
    expect(ids[1]).toMatch(/^run-cover-cover-/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('offers nothing, and prices nothing, for an app with no store listing', async () => {
    fake.add('my-app');
    const covers = fakes(null);
    const tools = await open(() => covers);
    const result = (await call(tools.tools, 'generate_app_cover', { prompt: 'a calculator' })) as {
      error?: string;
    };
    expect(result.error).toBe(
      'This app has no store listing yet. Publish it first, then a cover can be made for its listing.'
    );
    expect(covers.estimator.estimateWorkflow).not.toHaveBeenCalled();
    expect(covers.estimator.submitWorkflow).not.toHaveBeenCalled();
  });

  it('says covers are not set up where they are not, and offers nothing', async () => {
    fake.add('my-app');
    const tools = await open();
    expect(tools.hostTools).toContain('generate_app_cover');
    const result = (await call(tools.tools, 'generate_app_cover', { prompt: 'a calculator' })) as {
      error?: string;
    };
    expect(result.error).toBe('Covers cannot be made here.');
  });
});
