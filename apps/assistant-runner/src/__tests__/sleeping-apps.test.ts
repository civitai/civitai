import { WakeSeedError } from '@civitai/app-assistant';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppAssistantTools,
  appChosenIn,
  readPageState,
  type AppAssistantToolsOptions,
} from '../app-assistant/provider';
import {
  CivitaiSleepingApps,
  SLEEPING_APPS_PATH,
  WAKE_SEED_PATH,
} from '../app-assistant/sleeping-apps';
import type { OpenTools, ToolContext } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * APP HIBERNATE on the server runner: the user's sleeping apps (civitai's list, by the run grant)
 * turn on `list_apps` and `wake_app`; with civitai listing nothing (the flag off) the reply's tools
 * and instructions are exactly what they were without the feature.
 */

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

const ASLEEP = {
  app: 'garden-log',
  bytes: 2_048,
  lastActivityAt: '2026-10-01T09:00:00.000Z',
  hibernatedAt: '2026-10-15T00:00:00.000Z',
};
// A pairwise-distinct seed: a test can tell each field it was sent.
const SEED = {
  app: 'garden-log',
  url: 'https://archive.example/archives/1/garden-log/a.kept.zip?X-Amz-Signature=abc',
  sha256: 'c'.repeat(64),
  bytes: 2_049,
  ticket: 'wake-ticket-0123456789abcdef',
  expiresAt: '2026-11-13T12:10:00.000Z',
};

let fake: FakeSandboxService;
let opened: OpenTools[];
let providerOptions: Partial<AppAssistantToolsOptions>;
let wakeSeeds: string[];

beforeEach(async () => {
  providerOptions = {};
  wakeSeeds = [];
  fake = new FakeSandboxService();
  await fake.start();
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

function withSleeping(list: (typeof ASLEEP)[] | null) {
  providerOptions = {
    sleepingApps: () => ({
      list: async () => list,
      wakeSeed: async (app) => {
        wakeSeeds.push(app);
        return SEED;
      },
    }),
  };
}

async function open(overrides: Partial<ToolContext> = {}) {
  const tools = await new AppAssistantTools({
    sandboxUrl: fake.url,
    tokens: () => async (purpose) => `test-token-${purpose}`,
    log: quiet,
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
    ...providerOptions,
  }).open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    history: chosenApp('my-app'),
    signal: new AbortController().signal,
    report: () => undefined,
    endReply: () => undefined,
    ...overrides,
  });
  opened.push(tools);
  return tools;
}

let callId = 0;
function call(tools: ToolSet, name: string, input: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: `t-${++callId}`, messages: [] } as never)
  );
}

const opensApps = () =>
  fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sandboxes').length;

describe('app hibernate on the runner', () => {
  it('flag off (civitai lists nothing): tools, page tools and instructions exactly as without it', async () => {
    fake.add('my-app');
    const without = await open();
    withSleeping(null);
    const off = await open();
    expect(Object.keys(off.tools).sort()).toEqual(Object.keys(without.tools).sort());
    expect([...(off.hostTools ?? [])].sort()).toEqual([...(without.hostTools ?? [])].sort());
    expect(off.hostTools).not.toContain('wake_app');
    expect(off.hostTools).not.toContain('list_apps');
    expect(off.instructions).toBe(without.instructions);
  });

  it('flag on: offers list_apps and wake_app and names the sleeping apps', async () => {
    fake.add('my-app');
    withSleeping([ASLEEP]);
    const tools = await open();
    expect(tools.hostTools).toEqual(expect.arrayContaining(['list_apps', 'wake_app']));
    expect(tools.instructions).toContain('sleeping apps: garden-log');
    expect(await call(tools.tools, 'list_apps')).toEqual({
      apps: [
        { app: 'my-app', state: 'running', lastUsed: null },
        {
          app: 'garden-log',
          state: 'sleeping',
          lastUsed: '2026-10-01T09:00:00.000Z',
          asleepSince: '2026-10-15T00:00:00.000Z',
        },
      ],
    });
  });

  it('wake_app: a seeded create carrying civitai’s ticket, then a note to reinstall first', async () => {
    fake.add('my-app');
    withSleeping([ASLEEP]);
    const tools = await open();
    const woke = (await call(tools.tools, 'wake_app', { app: 'garden-log' })) as {
      app: string;
      note: string;
    };
    expect(wakeSeeds).toEqual(['garden-log']);
    // Only the seed's own fields reach the sandbox service, the ticket among them.
    expect(fake.seeds).toEqual([
      {
        app: 'garden-log',
        seed: { url: SEED.url, sha256: SEED.sha256, bytes: SEED.bytes, ticket: SEED.ticket },
      },
    ]);
    expect(woke.app).toBe('garden-log');
    expect(woke.note).toContain('npm install');
    // A rebuild of the reply's tools opens the app it woke (the gate's own rule).
    expect(appChosenIn([{ name: 'wake_app', input: {}, output: woke, isError: false }])).toBe(
      'garden-log'
    );
  });

  it('wake_app of an app woken elsewhere meanwhile opens it as it is', async () => {
    fake.add('my-app');
    withSleeping([ASLEEP]);
    const tools = await open();
    // Woken in another tab after this reply listed the apps: the seeded create is `already_exists`.
    fake.add('garden-log', 'suspended');
    const woke = (await call(tools.tools, 'wake_app', { app: 'garden-log' })) as {
      note: string;
    };
    expect(woke.note).toMatch(/already been woken elsewhere/);
  });

  it('create_app naming a sleeping app makes no new app and suggests waking it', async () => {
    fake.add('my-app');
    withSleeping([ASLEEP]);
    const tools = await open();
    const before = opensApps();
    const made = await call(tools.tools, 'create_app', { name: 'Garden log' });
    expect(made).toMatchObject({ app: 'garden-log', existed: true, state: 'sleeping' });
    expect(opensApps()).toBe(before);
  });

  it('the page’s woken hint reaches the instructions only for the app open now', async () => {
    fake.add('my-app');
    withSleeping([]);
    const hinted = await open({ page: { app: 'my-app', woken: true } });
    expect(hinted.instructions).toMatch(/my-app was just woken from sleep/);
    const unhinted = await open();
    expect(unhinted.instructions).not.toMatch(/woken from sleep/);
    expect(readPageState({ app: 'my-app', woken: true })).toEqual({ app: 'my-app', woken: true });
    expect(readPageState({ app: 'my-app', woken: 'yes' })).toEqual({ app: 'my-app' });
    expect(readPageState({ app: null, woken: true })).toEqual({ app: null });
  });
});

describe('CivitaiSleepingApps (the runner’s civitai client)', () => {
  function client(status: number, body: unknown) {
    const sent: { url: string; body: unknown; auth: string | null }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return new Response(JSON.stringify(body), { status });
    });
    const civitai = new CivitaiSleepingApps({
      civitaiUrl: 'https://civitai.example/',
      secret: 'test-only-runner-secret',
      log: quiet,
      fetch: fetch as never,
    });
    return { run: civitai.forRun(async () => 'grant-token'), sent };
  }

  it('lists with the run’s grant; 404 disabled is no feature (null)', async () => {
    const on = client(200, { apps: [ASLEEP, { app: 7 }] });
    expect(await on.run.list()).toEqual([ASLEEP]);
    expect(on.sent).toEqual([
      {
        url: `https://civitai.example/${SLEEPING_APPS_PATH}`,
        body: { grant: 'grant-token' },
        auth: 'Bearer test-only-runner-secret',
      },
    ]);
    expect(await client(404, { code: 'disabled' }).run.list()).toBeNull();
    expect(await client(503, { code: 'unavailable' }).run.list()).toBeNull();
  });

  it('a wake seed for the app; civitai’s refusals become WakeSeedErrors by code', async () => {
    const ok = client(200, SEED);
    expect(await ok.run.wakeSeed('garden-log')).toEqual(SEED);
    expect(ok.sent[0]).toMatchObject({
      url: `https://civitai.example/${WAKE_SEED_PATH}`,
      body: { grant: 'grant-token', app: 'garden-log' },
    });
    for (const [status, code, expected] of [
      [404, 'NOT_FOUND', 'not_found'],
      [409, 'changed', 'changed'],
      [404, 'disabled', 'unavailable'],
      [503, 'not_configured', 'unavailable'],
    ] as const) {
      const error = await client(status, { code })
        .run.wakeSeed('garden-log')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WakeSeedError);
      expect((error as WakeSeedError).code).toBe(expected);
    }
  });
});
