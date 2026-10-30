import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppAssistantTools, type AppAssistantToolsOptions } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * `generate_app_cover` on the server runner: offered beside the page tools the runner runs, through
 * the same gate, and with no listing nothing is spent. The cover's own behaviour is `cover.test.ts`.
 */

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const IMAGE_URL = 'https://orchestration.example/blobs/cover-tools.jpeg';

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
    listings: {
      listing: vi.fn(async (_app: string, _signal?: AbortSignal) => listing),
      attach: vi.fn(async (_input: { app: string; listingId: string; url: string }) => ({
        scanPending: false,
      })),
    },
    orchestration: {
      submitWorkflow: vi.fn(async () => ({ id: 'wf_tools', status: 'submitted' })),
      waitForWorkflow: vi.fn(async () => ({
        id: 'wf_tools',
        status: 'succeeded',
        steps: [{ output: { images: [{ url: IMAGE_URL, available: true }] } }],
      })),
      cancelWorkflow: vi.fn(async () => undefined),
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
    expect(tools.hostTools?.sort()).toEqual([
      'create_app',
      'generate_app_cover',
      'report_ready',
      'set_checklist',
      'start_preview',
      'stop_preview',
      'submit_for_review',
      'use_open_app',
    ]);
    expect(Object.keys(tools.tools)).toContain('generate_app_cover');
  });

  it('makes the cover for the open app and puts it on that app’s listing', async () => {
    fake.add('my-app');
    const covers = fakes({ listingId: 'apl_tools', blockedReason: null, status: 'draft' });
    const tools = await open(() => covers);
    const result = await call(tools.tools, 'generate_app_cover', { prompt: 'a tidy calculator' });
    expect(result).toMatchObject({ attached: true });
    expect(covers.listings.listing.mock.calls[0]![0]).toBe('my-app');
    expect(covers.orchestration.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(covers.listings.attach.mock.calls[0]![0]).toEqual({
      app: 'my-app',
      listingId: 'apl_tools',
      url: IMAGE_URL,
    });
  });

  it('spends nothing for an app with no store listing, and says why', async () => {
    fake.add('my-app');
    const covers = fakes(null);
    const tools = await open(() => covers);
    const result = (await call(tools.tools, 'generate_app_cover', { prompt: 'a calculator' })) as {
      error?: string;
    };
    expect(result.error).toBe(
      'This app has no store listing yet. Publish it first, then a cover can be made for its listing.'
    );
    expect(covers.orchestration.submitWorkflow).not.toHaveBeenCalled();
    expect(covers.listings.attach).not.toHaveBeenCalled();
  });

  // Invariant guard (the runner never offered it before this either): no covers set up, no tool.
  it('is not offered when covers are not set up', async () => {
    fake.add('my-app');
    const tools = await open();
    expect(tools.hostTools).not.toContain('generate_app_cover');
    expect(Object.keys(tools.tools)).not.toContain('generate_app_cover');
  });
});
