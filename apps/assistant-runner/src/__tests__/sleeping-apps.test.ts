import { WakeSeedError } from '@civitai/app-assistant';
import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppAssistantTools,
  appChosenIn,
  readPageState,
  runnerPageTools,
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
  sha256: 'e'.repeat(64),
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
/** How many times a reply read civitai's sleeping-app list (its rate-limited route). */
let listReads: number;

beforeEach(async () => {
  providerOptions = {};
  wakeSeeds = [];
  listReads = 0;
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
      list: async () => {
        listReads++;
        return list;
      },
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
    // R2-2: the archive it was woken from, so a page following this wake records its lineage.
    expect((woke as { sha256?: string }).sha256).toBe(SEED.sha256);
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

describe('the runner never starts a sleeping app UNSEEDED', () => {
  it('a reply’s start of the page’s paused app that was put to sleep meanwhile WAKES it (seeded)', async () => {
    fake.add('my-app', 'suspended');
    // Put to sleep between the runner's list and its start: its sandbox is gone when the open lands.
    fake.deleteBeforeOpen.add('my-app');
    withSleeping([{ ...ASLEEP, app: 'my-app' }]);
    await open();
    expect(wakeSeeds).toEqual(['my-app']);
    const creates = fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sandboxes');
    // Listed, so a plain open first; it had to CREATE (an empty app), which is deleted, then the
    // seeded wake. The user is left with exactly one my-app: the woken one.
    expect(creates).toHaveLength(2);
    // In that order: the plain create, the delete of what it made, then the seeded create.
    const order = fake.requests
      .filter((r) => r.method === 'DELETE' || (r.method === 'POST' && r.path === '/v1/sandboxes'))
      .map((r) => r.method);
    expect(order).toEqual(['POST', 'DELETE', 'POST']);
    expect(fake.sandboxes.filter((s) => s.app === 'my-app')).toHaveLength(1);
    expect(fake.seeds).toEqual([
      {
        app: 'my-app',
        seed: { url: SEED.url, sha256: SEED.sha256, bytes: SEED.bytes, ticket: SEED.ticket },
      },
    ]);
  });

  it('NEGATIVE CONTROL: with no sleeping record, the same start is the plain (unseeded) one', async () => {
    fake.add('my-app', 'suspended');
    withSleeping([]);
    await open();
    expect(wakeSeeds).toEqual([]);
    expect(fake.seeds).toEqual([]);
  });

  it('R2-3: a paused LISTED app with a sleeping record resumes with a PLAIN open: no seed, no wake', async () => {
    fake.add('my-app', 'suspended');
    // Its record is kept after a wake (lineage): it must not route the resume through the wake.
    withSleeping([{ ...ASLEEP, app: 'my-app' }]);
    await open();
    expect(wakeSeeds).toEqual([]);
    expect(fake.seeds).toEqual([]);
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(fake.sandboxes.find((s) => s.app === 'my-app')?.state).not.toBe('suspended');
  });

  it('INVARIANT: a reply reads the sleeping list ONCE, however many apps it starts', async () => {
    fake.add('my-app', 'suspended');
    fake.add('quiz-game', 'suspended');
    withSleeping([{ ...ASLEEP, app: 'my-app' }]);
    const tools = await open();
    await call(tools.tools, 'create_app', { name: 'Quiz game' });
    await call(tools.tools, 'create_app', { name: 'Tip calculator' });
    expect(listReads).toBe(1);
  });
});

describe('R2-3: past the list’s rate limit (`null`), the limit offer fails CLOSED', () => {
  const atSleepingLimit = {
    error: 'sandbox limit (5) reached; delete one first',
    code: 'sleeping_limit',
    limit: { kind: 'apps', limit: 5, used: 5 },
    oldest: { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' },
  };

  it('the sleeping list unread: create_app at the sleeping-app limit offers NO app to delete', async () => {
    fake.add('my-app');
    withSleeping(null);
    const tools = await open();
    fake.createRefusal = atSleepingLimit;
    const out = (await call(tools.tools, 'create_app', { name: 'Quiz night' })) as {
      limitCard?: unknown;
    };
    expect(out.limitCard).toEqual({ kind: 'sleeping', oldest: null });
  });

  it('NEGATIVE CONTROL: with the list read, the same refusal offers the oldest', async () => {
    fake.add('my-app');
    withSleeping([ASLEEP]);
    const tools = await open();
    fake.createRefusal = atSleepingLimit;
    const out = (await call(tools.tools, 'create_app', { name: 'Quiz night' })) as {
      limitCard?: unknown;
    };
    expect(out.limitCard).toEqual({ kind: 'sleeping', oldest: 'old-quiz' });
  });
});

describe('runnerPageTools', () => {
  const all = (omit: string[] = []) =>
    Object.fromEntries(
      [
        'create_app',
        'use_open_app',
        'set_checklist',
        'report_ready',
        'submit_for_review',
        'start_preview',
        'stop_preview',
        'get_review_feedback',
        'get_user_feedback',
        'set_feedback_status',
        'generate_app_cover',
        'app_activity',
        'list_apps',
        'wake_app',
      ]
        .filter((name) => !omit.includes(name))
        .map((name) => [name, { name }])
    );

  it('only the hibernate tools may be missing', () => {
    expect(Object.keys(runnerPageTools(all(['list_apps', 'wake_app'])))).not.toContain('wake_app');
    expect(Object.keys(runnerPageTools(all()))).toContain('wake_app');
  });

  it('any other missing page tool throws, by name', () => {
    expect(() => runnerPageTools(all(['report_ready']))).toThrow(
      'page tool report_ready is missing'
    );
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
