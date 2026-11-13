import { describe, expect, it, vi } from 'vitest';
import {
  CREATE_APP,
  KEEP_LIMIT,
  LIST_APPS,
  USE_OPEN_APP,
  WAKE_APP,
  WAKE_ATTEMPTS,
  WAKE_CHANGING,
  WAKE_NOT_FOUND,
  WAKE_RESTORE_FAILED,
  WAKE_SECRETS_UNAVAILABLE,
  WAKE_UNAVAILABLE,
  WakeSeedError,
  appOpenFailure,
  buildAssistantInstructions,
  chosenAppOf,
  createAppTools,
  createSandboxClient,
  keptAppsMessage,
  limitCardOf,
  safeOldest,
  SLEEPING_FULL,
  sleepingLimitMessage,
  sleepingNotLive,
  wakeOnlyFailure,
  wakeSleepingApp,
  type Sandbox,
  type SandboxClient,
  type SleepingApp,
  type WakeResult,
  type WakeSeed,
} from '@civitai/app-assistant';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

/**
 * APP HIBERNATE's shared logic, as both runners and the page run it: the wake (seed, ticket,
 * retries), what the user reads when it fails, the assistant's `list_apps` / `wake_app`, and
 * `create_app` keeping clear of sleeping apps' names. And with the feature off (no sleeping
 * options), every surface is exactly what it was.
 */

const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };

const sandbox = (
  app: string,
  state: Sandbox['state'] = 'running',
  name = `sbx-${app}`
): Sandbox => ({
  name,
  app,
  state,
  mcpUrl: `https://sandbox.example/s/${name}/mcp`,
  createdAt: null,
  lastActivityAt: '2026-11-10T10:00:00.000Z',
  expiresAt: null,
});

const asleep = (
  app: string,
  lastActivityAt: string | null = '2026-10-01T09:00:00.000Z'
): SleepingApp => ({
  app,
  sha256: `${app}-sha`.padEnd(64, '0'),
  bytes: 4_096,
  lastActivityAt,
  hibernatedAt: '2026-10-15T00:00:00.000Z',
});

// Pairwise-distinct seeds: each field differs, so a test can tell which one was sent.
const seedN = (n: number): WakeSeed & { app: string; expiresAt: string } => ({
  app: 'garden-log',
  url: `https://archive.example/archives/1/garden-log/${n}.kept.zip?X-Amz-Signature=s${n}`,
  sha256: String(n).repeat(64).slice(0, 64),
  bytes: 1_000 + n,
  ticket: `ticket-${n}-${'x'.repeat(20)}`,
  expiresAt: '2026-11-13T12:10:00.000Z',
});

const refusal = (
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>
) =>
  new SandboxApiError(
    message,
    status,
    status === 409 && /limit \(\d+\) reached/.test(message)
      ? 'limit'
      : status === 409
      ? 'conflict'
      : status === 400
      ? 'bad_request'
      : 'unavailable',
    code,
    details ?? null
  );

function fakeClient(answers: Array<() => unknown>) {
  const opened: { app: string; seed: unknown }[] = [];
  const client = {
    open: vi.fn(async (app: string, seed?: unknown) => {
      opened.push({ app, seed });
      const next = answers.shift();
      if (!next) throw new Error('no more answers');
      return next();
    }),
    list: vi.fn(async () => [sandbox('other-app', 'running')]),
    suspend: vi.fn(async (name: string) => sandbox(name, 'suspended')),
  } as unknown as SandboxClient;
  return { client, opened };
}
const woke = (app = 'garden-log') => ({
  sandbox: sandbox(app, 'starting', 'sbx-new'),
  created: true,
  seed: { files: 12, skipped: [] },
});
const fail = (error: unknown) => () => {
  throw error;
};

describe('wakeSleepingApp', () => {
  it('sends ONLY the seed’s own four fields, the ticket among them', async () => {
    const { client, opened } = fakeClient([woke]);
    const result = await wakeSleepingApp(client, 'garden-log', async () => seedN(1));
    const { url, sha256, bytes, ticket } = seedN(1);
    expect(opened).toEqual([{ app: 'garden-log', seed: { url, sha256, bytes, ticket } }]);
    expect(result).toMatchObject({
      created: true,
      alreadyAwake: false,
      sandbox: { name: 'sbx-new' },
    });
  });

  it.each(['stale_record', 'ticket_invalid'])(
    '%s: a NEW seed and ticket, then again',
    async (code) => {
      const { client, opened } = fakeClient([fail(refusal(409, 'changed', code)), woke]);
      let n = 0;
      const getSeed = vi.fn(async () => seedN(++n));
      await wakeSleepingApp(client, 'garden-log', getSeed);
      expect(getSeed).toHaveBeenCalledTimes(2);
      expect(opened.map((o) => (o.seed as WakeSeed).ticket)).toEqual([
        seedN(1).ticket,
        seedN(2).ticket,
      ]);
    }
  );

  it('secrets_unavailable is thrown once, with no retry: the user tries again', async () => {
    const unavailable = refusal(503, 'later', 'secrets_unavailable');
    const { client } = fakeClient([fail(unavailable), woke]);
    const getSeed = vi.fn(async () => seedN(7));
    await expect(wakeSleepingApp(client, 'garden-log', getSeed)).rejects.toBe(unavailable);
    expect(getSeed).toHaveBeenCalledTimes(1);
    expect(client.open).toHaveBeenCalledTimes(1);
  });

  it('already_exists: woken elsewhere, so it is opened as it is, without a seed', async () => {
    const { client, opened } = fakeClient([
      fail(refusal(409, 'a sandbox for this app already exists', 'already_exists')),
      () => ({ sandbox: sandbox('garden-log', 'suspended'), created: false }),
    ]);
    const result = await wakeSleepingApp(client, 'garden-log', async () => seedN(1));
    expect(opened[1]).toEqual({ app: 'garden-log', seed: undefined });
    expect(result).toMatchObject({ alreadyAwake: true, created: false });
  });

  it('a cap refusal is thrown at once: no retry, no second seed', async () => {
    const limit = refusal(409, 'sandbox limit (3) reached; delete one first', 'sleeping_limit', {
      limit: { kind: 'apps', limit: 5, used: 5 },
      oldest: { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' },
    });
    const { client } = fakeClient([fail(limit), woke]);
    const getSeed = vi.fn(async () => seedN(1));
    await expect(wakeSleepingApp(client, 'garden-log', getSeed)).rejects.toBe(limit);
    expect(getSeed).toHaveBeenCalledTimes(1);
    expect(client.open).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${WAKE_ATTEMPTS} creates with the last refusal`, async () => {
    const stale = refusal(409, 'changed', 'stale_record');
    const { client } = fakeClient([fail(stale), fail(stale), fail(stale), woke]);
    await expect(wakeSleepingApp(client, 'garden-log', async () => seedN(1))).rejects.toBe(stale);
    expect(client.open).toHaveBeenCalledTimes(WAKE_ATTEMPTS);
  });

  it('at the running cap the others are paused and the same seed is sent again (its ticket unspent)', async () => {
    const running = refusal(
      409,
      'running-sandbox limit (1) reached: x is running; suspend it first',
      ''
    );
    const { client, opened } = fakeClient([fail(running), woke]);
    await wakeSleepingApp(client, 'garden-log', async () => seedN(3));
    expect(client.suspend).toHaveBeenCalledWith('sbx-other-app');
    expect(opened.map((o) => (o.seed as WakeSeed).ticket)).toEqual([
      seedN(3).ticket,
      seedN(3).ticket,
    ]);
  });
});

describe('what the user reads when a wake fails', () => {
  it.each([
    [new WakeSeedError('x', 'not_found'), WAKE_NOT_FOUND],
    [new WakeSeedError('x', 'changed'), WAKE_CHANGING],
    [new WakeSeedError('x', 'unavailable'), WAKE_UNAVAILABLE],
    [refusal(409, 'x', 'stale_record'), WAKE_CHANGING],
    [refusal(409, 'x', 'ticket_invalid'), WAKE_CHANGING],
    [refusal(503, 'x', 'secrets_unavailable'), WAKE_SECRETS_UNAVAILABLE],
    [refusal(503, 'x', 'civitai_auth'), WAKE_UNAVAILABLE],
    [refusal(400, 'x', 'ticket_required'), WAKE_UNAVAILABLE],
    [refusal(409, 'x', 'secrets_refused'), WAKE_UNAVAILABLE],
    [refusal(400, 'x', 'seed_sha256_mismatch'), WAKE_RESTORE_FAILED],
  ])('%s', (error, expected) => {
    expect(wakeOnlyFailure(error)).toBe(expected);
    expect(expected).not.toMatch(/sandbox|ticket|seed|civitai_|wake_app|__/i);
  });

  it('leaves an ordinary open failure to appOpenFailure', () => {
    expect(
      wakeOnlyFailure(refusal(409, 'sandbox limit (3) reached; delete one first', ''))
    ).toBeNull();
    expect(wakeOnlyFailure(new Error('network'))).toBeNull();
  });

  it('names the oldest sleeping app at the sleeping-app limit, and the kept apps that cannot sleep', () => {
    const atLimit = refusal(409, 'sandbox limit (3) reached; delete one first', 'sleeping_limit', {
      oldest: { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(appOpenFailure(atLimit)).toBe(sleepingLimitMessage('old-quiz'));
    const kept = refusal(409, 'sandbox limit (3) reached; delete one first', 'kept_apps', {
      kept: [
        { name: 'sbx-a', app: 'big-app', reason: 'archive_too_large' },
        { name: 'sbx-b', app: 'odd-app', reason: 'something_new' },
      ],
    });
    expect(appOpenFailure(kept)).toBe(
      keptAppsMessage([
        { app: 'big-app', reason: 'archive_too_large' },
        { app: 'odd-app', reason: 'something_new' },
      ])
    );
    expect(appOpenFailure(kept)).toContain('big-app (too large to put to sleep)');
    // Without those codes (a service without hibernation), exactly as before.
    expect(appOpenFailure(refusal(409, 'sandbox limit (3) reached; delete one first', ''))).toBe(
      KEEP_LIMIT
    );
  });

  it('the page’s card is read from the result’s structured limitCard, never from its wording', async () => {
    const atLimit = refusal(409, 'sandbox limit (3) reached; delete one first', 'sleeping_limit', {
      oldest: { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' },
    });
    const kept = refusal(409, 'sandbox limit (3) reached; delete one first', 'kept_apps', {
      kept: [{ name: 'sbx-a', app: 'big-app', reason: 'archive_too_large' }],
    });
    // create_app and wake_app at either refusal RETURN { error, limitCard } (a failed result).
    const createAt = async (error: unknown) =>
      tools({
        wake: async () => {
          throw error;
        },
        open: async () => {
          throw error;
        },
      }).tools[CREATE_APP].execute({ name: 'Quiz night' }, ctx);
    const wakeAt = async (error: unknown) =>
      tools({
        sleeping: [asleep('garden-log')],
        wake: async () => {
          throw error;
        },
      }).tools[WAKE_APP].execute({ app: 'garden-log' }, ctx);
    for (const [name, run] of [
      [CREATE_APP, createAt],
      [WAKE_APP, wakeAt],
    ] as const) {
      const output = (await run(atLimit)) as { error: string; limitCard: unknown };
      expect(output).toEqual({
        error: sleepingLimitMessage('old-quiz'),
        limitCard: { kind: 'sleeping', oldest: 'old-quiz' },
      });
      expect(limitCardOf({ name, output, isError: true })).toEqual({
        kind: 'sleeping',
        oldest: 'old-quiz',
      });
      // Reworded text changes nothing: the card comes from the field.
      expect(
        limitCardOf({ name, output: { ...output, error: 'Anything at all.' }, isError: true })
      ).toEqual({ kind: 'sleeping', oldest: 'old-quiz' });
      const keptOut = (await run(kept)) as { error: string };
      expect(keptOut.error).toBe(
        keptAppsMessage([{ app: 'big-app', reason: 'archive_too_large' }])
      );
      expect(limitCardOf({ name, output: keptOut, isError: true })).toEqual({ kind: 'keep' });
    }
    // The text alone (no field) is not a sleeping-limit card.
    expect(
      limitCardOf({
        name: CREATE_APP,
        output: { error: sleepingLimitMessage('old-quiz') },
        isError: true,
      })
    ).toBeNull();
    const err = (name: string, error: string) => ({ name, output: { error }, isError: true });
    expect(limitCardOf(err(WAKE_APP, KEEP_LIMIT))).toEqual({ kind: 'keep' });
    expect(limitCardOf(err(CREATE_APP, KEEP_LIMIT))).toEqual({ kind: 'keep' });
    expect(
      limitCardOf({
        name: USE_OPEN_APP,
        output: { error: 'x', limitCard: { kind: 'sleeping', oldest: 'old-quiz' } },
        isError: true,
      })
    ).toBeNull();
    expect(limitCardOf({ name: WAKE_APP, output: { app: 'x' }, isError: false })).toBeNull();
  });

  it('flag off: a plain kept-app cap still THROWS KEEP_LIMIT from create_app, as before', async () => {
    const t = tools({
      open: async () => {
        throw refusal(409, 'sandbox limit (3) reached; delete one first', '');
      },
    });
    await expect(
      Promise.resolve(t.tools[CREATE_APP].execute({ name: 'Quiz night' }, ctx))
    ).rejects.toThrow(KEEP_LIMIT);
  });
});

describe('🔴 the limit offer never names the app being opened or woken, nor a live app', () => {
  const atLimit = (oldest: string) =>
    refusal(409, 'sandbox limit (3) reached; delete one first', 'sleeping_limit', {
      oldest: { app: oldest, hibernatedAt: '2026-09-01T00:00:00.000Z' },
    });

  it('safeOldest drops the app in hand and every live app', () => {
    expect(safeOldest('old-quiz', { app: 'garden-log', live: ['quiz-game'] })).toBe('old-quiz');
    expect(safeOldest('garden-log', { app: 'garden-log', live: [] })).toBeNull();
    expect(safeOldest('quiz-game', { app: 'garden-log', live: ['quiz-game'] })).toBeNull();
    expect(safeOldest(null)).toBeNull();
  });

  it('wake_app: oldest === the app being woken → no oldest offered, the plain message', async () => {
    const t = tools({
      sleeping: [asleep('garden-log')],
      wake: async () => {
        throw atLimit('garden-log');
      },
    });
    const out = await t.tools[WAKE_APP].execute({ app: 'garden-log' }, ctx);
    expect(out).toEqual({ error: SLEEPING_FULL, limitCard: { kind: 'sleeping', oldest: null } });
    expect(limitCardOf({ name: WAKE_APP, output: out, isError: true })).toEqual({
      kind: 'sleeping',
      oldest: null,
    });
  });

  it('create_app: oldest === a live app → no oldest offered', async () => {
    const t = tools({
      apps: [sandbox('quiz-game', 'suspended')],
      wake: async () => {
        throw new Error('unused');
      },
      open: async () => {
        throw atLimit('quiz-game');
      },
    });
    const out = await t.tools[CREATE_APP].execute({ name: 'Garden log' }, ctx);
    expect(out).toEqual({ error: SLEEPING_FULL, limitCard: { kind: 'sleeping', oldest: null } });
  });

  it('NEGATIVE CONTROL: an oldest that is neither is offered', async () => {
    const t = tools({
      apps: [sandbox('quiz-game', 'suspended')],
      sleeping: [asleep('garden-log')],
      wake: async () => {
        throw atLimit('old-quiz');
      },
    });
    expect(await t.tools[WAKE_APP].execute({ app: 'garden-log' }, ctx)).toMatchObject({
      limitCard: { kind: 'sleeping', oldest: 'old-quiz' },
    });
  });
});

describe('sleepingNotLive', () => {
  it('a live sandbox wins over a record of the same app', () => {
    expect(
      sleepingNotLive([sandbox('garden-log')], [asleep('garden-log'), asleep('old-quiz')]).map(
        (s) => s.app
      )
    ).toEqual(['old-quiz']);
  });
});

function tools(opts: {
  apps?: Sandbox[];
  sleeping?: SleepingApp[];
  wake?: (app: string) => Promise<WakeResult>;
  open?: (app: string) => Promise<{ sandbox: Sandbox; created: boolean }>;
  toolsReady?: (app: string) => Promise<boolean>;
}) {
  return createAppTools({
    apps: () => opts.apps ?? [],
    current: () => null,
    open: opts.open ?? (async (app) => ({ sandbox: sandbox(app, 'starting'), created: true })),
    ...(opts.toolsReady ? { toolsReady: opts.toolsReady } : {}),
    ...(opts.wake ? { sleeping: () => opts.sleeping ?? [], wake: opts.wake } : {}),
  });
}

describe('the assistant’s tools with the feature OFF are exactly as before', () => {
  it('only create_app and use_open_app, and create_app ignores nothing it did not before', async () => {
    const t = tools({ apps: [sandbox('tip-calculator', 'suspended')] });
    expect(Object.keys(t.tools)).toEqual([CREATE_APP, USE_OPEN_APP]);
    expect(t.refusal(WAKE_APP)).toBeNull();
    const result = (await t.tools[CREATE_APP].execute({ name: 'Tip calculator' }, ctx)) as {
      app: string;
    };
    expect(result.app).toBe('tip-calculator-2');
  });

  it('the instructions are byte-identical without the sleeping fields', () => {
    const base = {
      sandbox: { name: 'sbx-a', app: 'tip-calculator', state: 'running' as const },
      apps: ['tip-calculator', 'quiz-game'],
      canPreview: true,
      previewHost: null,
    };
    const before = buildAssistantInstructions(base);
    expect(buildAssistantInstructions({ ...base, sleeping: undefined, woken: false })).toBe(before);
    expect(buildAssistantInstructions({ ...base, sleeping: [] })).toBe(before);
    expect(before).not.toMatch(/sleep|wake_app|list_apps/);
  });
});

describe('the assistant’s tools with the feature ON', () => {
  const wakeOk = vi.fn(
    async (app: string): Promise<WakeResult> => ({
      sandbox: sandbox(app, 'starting', 'sbx-woken'),
      created: true,
      alreadyAwake: false,
    })
  );

  it('adds list_apps and wake_app', () => {
    expect(Object.keys(tools({ wake: wakeOk }).tools)).toEqual([
      CREATE_APP,
      USE_OPEN_APP,
      LIST_APPS,
      WAKE_APP,
    ]);
  });

  it('create_app keeps clear of sleeping apps’ names', async () => {
    const open = vi.fn(async (app: string) => ({
      sandbox: sandbox(app, 'starting'),
      created: true,
    }));
    const t = tools({
      apps: [sandbox('tip-calculator', 'suspended')],
      sleeping: [asleep('tip-calculator-2')],
      wake: wakeOk,
      open,
    });
    await t.tools[CREATE_APP].execute({ name: 'Tip calculator' }, ctx);
    expect(open).toHaveBeenCalledWith('tip-calculator-3');
  });

  it('create_app naming a sleeping app makes nothing and suggests waking it', async () => {
    const open = vi.fn();
    const t = tools({ sleeping: [asleep('garden-log')], wake: wakeOk, open: open as never });
    const result = (await t.tools[CREATE_APP].execute({ name: 'Garden log' }, ctx)) as {
      app: string;
      existed?: true;
      note: string;
    };
    expect(open).not.toHaveBeenCalled();
    expect(result).toMatchObject({ app: 'garden-log', existed: true, state: 'sleeping' });
    expect(result.note).toMatch(/wake_app/);
    // It chose nothing for the chat.
    expect(chosenAppOf({ name: CREATE_APP, input: {}, output: result, isError: false })).toBeNull();
  });

  it('wake_app wakes it, says to reinstall dependencies first, and chooses it for the chat', async () => {
    const t = tools({
      sleeping: [asleep('garden-log')],
      wake: wakeOk,
      toolsReady: async () => true,
    });
    const result = (await t.tools[WAKE_APP].execute({ app: 'garden-log' }, ctx)) as {
      note: string;
      reopenTools?: true;
    };
    expect(wakeOk).toHaveBeenCalledWith('garden-log');
    expect(result.note).toContain('npm install');
    expect(result.note).toMatch(/node_modules/);
    expect(result.reopenTools).toBe(true);
    expect(chosenAppOf({ name: WAKE_APP, input: {}, output: result, isError: false })).toBe(
      'garden-log'
    );
  });

  it('wake_app whose tools are not ready yet ends the reply for the user', async () => {
    const t = tools({ sleeping: [asleep('garden-log')], wake: wakeOk });
    const result = (await t.tools[WAKE_APP].execute({ app: 'garden-log' }, ctx)) as {
      awaitsUser?: true;
      note: string;
    };
    expect(result.awaitsUser).toBe(true);
    expect(result.note).toContain('npm install');
  });

  it('wake_app refuses an app that is not asleep, and an awake one chooses nothing', async () => {
    const t = tools({ apps: [sandbox('quiz-game')], sleeping: [], wake: wakeOk });
    await expect(
      Promise.resolve(t.tools[WAKE_APP].execute({ app: 'none-such' }, ctx))
    ).rejects.toThrow(/no sleeping app called none-such/);
    const awake = await t.tools[WAKE_APP].execute({ app: 'quiz-game' }, ctx);
    expect(chosenAppOf({ name: WAKE_APP, input: {}, output: awake, isError: false })).toBeNull();
  });

  it('a wake at the limit is told in the user’s words, and refuses another try in that reply', async () => {
    const t = tools({
      sleeping: [asleep('garden-log')],
      wake: async () => {
        throw refusal(409, 'sandbox limit (3) reached; delete one first', 'sleeping_limit', {
          oldest: { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' },
        });
      },
    });
    expect(await t.tools[WAKE_APP].execute({ app: 'garden-log' }, ctx)).toMatchObject({
      error: sleepingLimitMessage('old-quiz'),
    });
    expect(t.refusal(WAKE_APP)).toBe(sleepingLimitMessage('old-quiz'));
    expect(t.refusal(CREATE_APP)).toBe(sleepingLimitMessage('old-quiz'));
    expect(t.refusal(USE_OPEN_APP)).not.toBeNull();
    t.newReply();
    expect(t.refusal(WAKE_APP)).toBeNull();
  });

  it('list_apps lists kept and sleeping apps with their state and when they were last used', async () => {
    const t = tools({
      apps: [sandbox('quiz-game', 'suspended')],
      sleeping: [asleep('garden-log'), asleep('quiz-game')],
      wake: wakeOk,
    });
    expect(await t.tools[LIST_APPS].execute({}, ctx)).toEqual({
      apps: [
        { app: 'quiz-game', state: 'paused', lastUsed: '2026-11-10T10:00:00.000Z' },
        {
          app: 'garden-log',
          state: 'sleeping',
          lastUsed: '2026-10-01T09:00:00.000Z',
          asleepSince: '2026-10-15T00:00:00.000Z',
        },
      ],
    });
  });

  it('the instructions name the sleeping apps, and a woken app’s reinstall', () => {
    const text = buildAssistantInstructions({
      sandbox: { name: 'sbx-a', app: 'garden-log', state: 'running' },
      apps: ['garden-log'],
      canPreview: false,
      previewHost: null,
      sleeping: ['old-quiz'],
      woken: true,
    });
    expect(text).toContain('sleeping apps: old-quiz');
    expect(text).toMatch(/garden-log was just woken from sleep.*npm install/);
  });
});

describe('the sandbox client’s hibernate pieces', () => {
  function fetchOnce(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    });
    const client = createSandboxClient({
      baseUrl: 'https://sandbox.example',
      getToken: async () => 'tok',
      fetch: fetch as never,
    });
    return { client, calls };
  }

  it('a refusal keeps its extra fields (`oldest`, `kept`) as details', async () => {
    const oldest = { app: 'old-quiz', hibernatedAt: '2026-09-01T00:00:00.000Z' };
    const { client } = fetchOnce(409, {
      error: 'sandbox limit (3) reached; delete one first',
      code: 'sleeping_limit',
      limit: { kind: 'apps', limit: 5, used: 5 },
      oldest,
    });
    const error = await client.open('garden-log').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect(error).toMatchObject({ kind: 'limit', code: 'sleeping_limit' });
    expect((error as SandboxApiError).details).toEqual({
      limit: { kind: 'apps', limit: 5, used: 5 },
      oldest,
    });
  });

  it('a refusal with no extra fields has no details, as before', async () => {
    const { client } = fetchOnce(409, { error: 'the sandbox changed concurrently; retry' });
    const error = await client.open('garden-log').catch((e: unknown) => e);
    expect((error as SandboxApiError).details).toBeNull();
  });

  it('hibernate POSTs to the sandbox’s /hibernate', async () => {
    const { client, calls } = fetchOnce(202, { name: 'sbx-abc', hibernating: true });
    await client.hibernate('sbx-abc');
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'https://sandbox.example/v1/sandboxes/sbx-abc/hibernate'],
    ]);
  });
});
