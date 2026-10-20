import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { TurnPart } from '@civitai/components-chat/core';
import {
  applyRunEvent,
  type RunEvent,
  type StartRunRequest,
} from '@civitai/components-chat/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import type { ModelProvider } from '../interfaces';
import { MemoryConversationStore } from '../memory-store';
import { Runner, type RunnerDeps } from '../runner';
import { bearerAuthenticator, fakeTools, untilAborted } from '../test-support/fakes';
import { freshDatabase, rowsContaining, tableCount, TEST_DATABASE_URL } from '../test-support/pg';
import { scriptedModel, toolResults } from '../test-support/scripted-model';
import { readEvents, type ReadEntry } from '../test-support/sse';

// Runs against a real Postgres (CI's `App unit tests` job provides one). Without
// ASSISTANT_RUNNER_TEST_DATABASE_URL the whole file skips.
const describePg = TEST_DATABASE_URL ? describe : describe.skip;
// In CI a lost URL must fail, not skip: the other suites would keep the app's job green.
if (process.env.CI && !TEST_DATABASE_URL)
  throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set in CI');

const LONG_TEXT = 'The quick brown fox jumps over the lazy dog, again and again. '.repeat(10);

describePg('assistant-runner on DBOS + Postgres', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let runner: Runner;
  let app: FastifyInstance;
  let base: string;
  const store = new MemoryConversationStore();
  const calls = { record: 0, wait: 0, waitAborted: 0, modelRequests: 0 };
  const flaky = { failNext: false };
  const tools = fakeTools({
    record: async () => {
      calls.record++;
      return 'recorded';
    },
    wait: async (_input, { abortSignal }) => {
      calls.wait++;
      const how = await untilAborted(abortSignal);
      if (how === 'aborted') calls.waitAborted++;
      return how;
    },
  });
  const scripts: Record<string, () => ReturnType<typeof scriptedModel>> = {
    long: () => scriptedModel(() => ({ text: LONG_TEXT }), { chunkDelayMs: 1 }),
    tools: () =>
      scriptedModel((prompt) =>
        toolResults(prompt) === 0
          ? { text: 'Recording. ', calls: [{ toolName: 'record', input: {} }] }
          : { text: 'Recorded.' }
      ),
    hang: () =>
      scriptedModel((prompt) =>
        toolResults(prompt) === 0
          ? { text: 'Waiting. ', calls: [{ toolName: 'wait', input: {} }] }
          : { text: 'Done waiting.' }
      ),
    flaky: () =>
      scriptedModel((prompt) => {
        if (toolResults(prompt) === 0) return { calls: [{ toolName: 'record', input: {} }] };
        if (flaky.failNext) {
          flaky.failNext = false;
          return { fail: new Error('the model broke') };
        }
        return { text: 'Recovered.' };
      }),
  };
  const models: ModelProvider = {
    languageModel: ({ model }) => {
      const scripted = scripts[model]!();
      const doStream = scripted.doStream.bind(scripted);
      scripted.doStream = (options) => {
        calls.modelRequests++;
        return doStream(options);
      };
      return scripted;
    },
  };
  const deps: RunnerDeps = {
    models,
    tools: tools.provider,
    store,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: (object, message) => console.error(message, object),
    },
    wallClockMs: 60_000,
    // Far past the graceful-stop bound below, so a stop that only the forced fallback ends fails it.
    stopGraceMs: 20_000,
  };

  beforeAll(async () => {
    db = await freshDatabase('runner');
    runner = new Runner(deps);
    runner.register();
    await runner.launch({
      databaseUrl: db.url,
      executorId: 'test',
      workerConcurrency: 10,
      logLevel: 'warn',
    });
    app = buildApp({ service: runner, authenticator: bearerAuthenticator });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
    await runner?.shutdown();
    await db?.drop();
  });

  const as = (userId: string, secret = '') => ({
    authorization: `Bearer user:${userId}${secret ? `:${secret}` : ''}`,
  });

  function startBody(overrides: {
    conversationId: string;
    model: string;
    seq?: number;
    retry?: boolean;
    content?: string;
    key?: string;
  }): StartRunRequest {
    return {
      v: 1,
      idempotencyKey: overrides.key ?? randomUUID(),
      conversationId: overrides.conversationId,
      turn: {
        seq: overrides.seq ?? 1,
        user: { content: overrides.content ?? 'Please do the thing.', attachments: [] },
        ...(overrides.retry ? { retry: true } : {}),
      },
      model: overrides.model,
      settings: {
        maxOutputTokens: 1024,
        tier: 'auto',
        allowMature: false,
        autoRunLimit: 0,
        spokenReplies: false,
      },
    };
  }

  async function post(path: string, headers: Record<string, string>, body: unknown) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
  }

  const events = (runId: string, userId: string, options: Parameters<typeof readEvents>[2] = {}) =>
    readEvents(`${base}/runs/${runId}/events`, as(userId), options);
  const ended = (entries: ReadEntry[]) =>
    entries.at(-1)!.event as Extract<RunEvent, { type: 'run-ended' }>;

  function rebuild(entries: ReadEntry[]): TurnPart[] {
    const parts: TurnPart[] = [];
    for (const { event } of entries)
      expect(applyRunEvent(parts, event), `event ${event.type} fits the parts`).toBe(true);
    return parts;
  }

  it('streams a reply as coalesced text deltas, ends it done and saves the head', async () => {
    const user = 'u-stream';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-stream', model: 'long', content: 'Tell me about foxes.' })
    );
    expect(start.status).toBe(201);
    const runId = start.body!.runId as string;

    const entries = await events(runId, user);
    expect(entries.map((entry) => entry.id)).toEqual(entries.map((_, index) => index));
    expect(entries[0]!.event.type).toBe('run-started');
    expect(ended(entries).status).toBe('done');

    const deltas = entries.flatMap(({ event }) =>
      event.type === 'text-delta' ? [event.text] : []
    );
    // Each character goes out once (edits, not whole parts), and the ~150 model chunks go as far fewer events.
    expect(deltas.join('')).toBe(LONG_TEXT);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThan(40);
    expect(rebuild(entries)).toEqual([{ kind: 'text', text: LONG_TEXT }]);

    const head = await store.load(user, 'c-stream');
    expect(head).toMatchObject({
      v: 2,
      app: 'chat-cvt',
      conversationId: 'c-stream',
      title: 'Tell me about foxes.',
      titleSource: 'first-message',
    });
    expect(head!.turns).toHaveLength(1);
    expect(head!.turns[0]!.assistant).toMatchObject({ status: 'done' });
    expect(head!.turns[0]!.assistant!.messages).toEqual(ended(entries).messages);
  });

  it('resumes the event stream after Last-Event-ID', async () => {
    const user = 'u-resume';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-resume', model: 'tools' })
    );
    const runId = start.body!.runId as string;
    const all = await events(runId, user);
    const cut = Math.floor(all.length / 2);
    const rest = await events(runId, user, { lastEventId: all[cut]!.id });
    expect(rest).toEqual(all.slice(cut + 1));
  });

  it('answers a repeated start with the same run, and refuses a second live run for the same user', async () => {
    const user = 'u-active';
    const key = randomUUID();
    const first = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-active-1', model: 'hang', key })
    );
    expect(first.status).toBe(201);
    const again = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-active-1', model: 'hang', key })
    );
    expect(again).toEqual({ status: 201, body: first.body });

    const other = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-active-2', model: 'hang' })
    );
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ v: 1, error: 'run-active', runId: first.body!.runId });

    // Another user is not held up by this one.
    const elsewhere = await post(
      '/runs',
      as('u-active-other'),
      startBody({ conversationId: 'c-active-3', model: 'tools' })
    );
    expect(elsewhere.status).toBe(201);
    expect(ended(await events(elsewhere.body!.runId as string, 'u-active-other')).status).toBe(
      'done'
    );

    await post(`/runs/${first.body!.runId as string}/stop`, as(user), { v: 1 });
    expect(ended(await events(first.body!.runId as string, user)).status).toBe('stopped');
  });

  // An invariant guard: run ids already hash in the viewer, so this has never failed. It fails if
  // they stop doing so.
  it('keeps one user’s idempotency key from naming another user’s run', async () => {
    const key = randomUUID();
    const first = await post(
      '/runs',
      as('u-key-a'),
      startBody({ conversationId: 'c-key-a', model: 'hang', key })
    );
    const runId = first.body!.runId as string;
    await events(runId, 'u-key-a', { stopWhen: ({ event }) => event.type === 'tool-call' });

    // Another user's stop with the same key reaches nothing of A's.
    expect(
      (
        await post('/runs/stop', as('u-key-b'), {
          v: 1,
          idempotencyKey: key,
          conversationId: 'c-key-a',
        })
      ).status
    ).toBe(202);
    expect(await runner.lookup('u-key-a', 'c-key-a')).toMatchObject({ runId });
    // Nor does their start with it return A's run.
    const second = await post(
      '/runs',
      as('u-key-b'),
      startBody({ conversationId: 'c-key-b', model: 'tools', key })
    );
    expect(second.status).toBe(201);
    expect(second.body!.runId).not.toBe(runId);

    await post(`/runs/${runId}/stop`, as('u-key-a'), { v: 1 });
    expect(ended(await events(runId, 'u-key-a')).status).toBe('stopped');
  });

  it('lets only one of two racing starts for the same user run', async () => {
    const user = 'u-race';
    const [a, b] = await Promise.all([
      post('/runs', as(user), startBody({ conversationId: 'c-race-1', model: 'hang' })),
      post('/runs', as(user), startBody({ conversationId: 'c-race-2', model: 'hang' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(loser.body).toMatchObject({ error: 'run-active' });
    const runId = winner.body!.runId as string;
    await post(`/runs/${runId}/stop`, as(user), { v: 1 });
    expect(ended(await events(runId, user)).status).toBe('stopped');
  });

  it('runs a tool call only once the head save recording its start has landed', async () => {
    const user = 'u-gated';
    const recordsBefore = calls.record;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = deps.store;
    deps.store = {
      load: (userId, conversationId) => real.load(userId, conversationId),
      update: async (userId, conversationId, change) => {
        // Holds back the first save that records the `record` call, as a slow store would.
        const next = change(await real.load(userId, conversationId));
        if (userId === user && JSON.stringify(next).includes('"toolName":"record"')) await held;
        return real.update(userId, conversationId, change);
      },
    };
    try {
      const start = await post(
        '/runs',
        as(user),
        startBody({ conversationId: 'c-gated', model: 'tools' })
      );
      const runId = start.body!.runId as string;
      await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(calls.record).toBe(recordsBefore);
      release();
      expect(ended(await events(runId, user)).status).toBe('done');
      expect(calls.record).toBe(recordsBefore + 1);
    } finally {
      release();
      deps.store = real;
    }
  });

  it('refuses a turn that is not the next one', async () => {
    const stale = await post(
      '/runs',
      as('u-stale'),
      startBody({ conversationId: 'c-stale', model: 'tools', seq: 3 })
    );
    expect(stale).toMatchObject({ status: 409, body: { error: 'stale-turn' } });
  });

  it('stops a running reply gracefully: run-ended stopped, the tool aborted and closed, the head saved stopped', async () => {
    const user = 'u-stop';
    const before = { ...tools.stats, waitAborted: calls.waitAborted };
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-stop', model: 'hang' })
    );
    const runId = start.body!.runId as string;
    const upToCall = await events(runId, user, {
      stopWhen: ({ event }) => event.type === 'tool-call',
    });

    const stoppedAt = Date.now();
    expect((await post(`/runs/${runId}/stop`, as(user), { v: 1 })).status).toBe(202);
    const rest = await events(runId, user, { lastEventId: upToCall.at(-1)!.id });
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect(ended(rest).status).toBe('stopped');
    expect(calls.waitAborted).toBe(before.waitAborted + 1);
    expect(tools.stats.closed).toBe(before.closed + 1);

    const head = await store.load(user, 'c-stop');
    expect(head!.v).toBe(2);
    expect(head!.turns[0]!.assistant).toMatchObject({ status: 'aborted' });
    expect(await runner.lookup(user, 'c-stop')).toBeNull();
  });

  it('a stop by key that arrives before its start makes that start end at once, stopped, without asking the model', async () => {
    const user = 'u-stopkey';
    const key = randomUUID();
    expect(
      (
        await post('/runs/stop', as(user), {
          v: 1,
          idempotencyKey: key,
          conversationId: 'c-stopkey',
        })
      ).status
    ).toBe(202);
    const requestsBefore = calls.modelRequests;
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-stopkey', model: 'tools', key })
    );
    expect(start.status).toBe(201);
    const entries = await events(start.body!.runId as string, user);
    expect(entries.map(({ event }) => event.type)).toEqual(['run-started', 'run-ended']);
    expect(ended(entries).status).toBe('stopped');
    expect(calls.modelRequests).toBe(requestsBefore);
  });

  it('a stop by key after the start stops that run', async () => {
    const user = 'u-stopkey-late';
    const key = randomUUID();
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-stopkey-late', model: 'hang', key })
    );
    const runId = start.body!.runId as string;
    await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });
    expect(
      (
        await post('/runs/stop', as(user), {
          v: 1,
          idempotencyKey: key,
          conversationId: 'c-stopkey-late',
        })
      ).status
    ).toBe(202);
    expect(ended(await events(runId, user)).status).toBe('stopped');
  });

  it('ends a run that outlives its wall clock as ran_out', async () => {
    const user = 'u-clock';
    deps.wallClockMs = 1500;
    try {
      const start = await post(
        '/runs',
        as(user),
        startBody({ conversationId: 'c-clock', model: 'hang' })
      );
      const runId = start.body!.runId as string;
      // The clock cuts off a call in flight, not a run that had already run out before it began.
      const upToCall = await events(runId, user, {
        stopWhen: ({ event }) => event.type === 'tool-call',
      });
      const entries = await events(runId, user, {
        lastEventId: upToCall.at(-1)!.id,
        timeoutMs: 20_000,
      });
      expect(ended(entries).status).toBe('ran_out');
      const head = await store.load(user, 'c-clock');
      expect(head!.turns[0]!.assistant).toMatchObject({ status: 'done', ranOut: true });
    } finally {
      deps.wallClockMs = 60_000;
    }
  });

  it('looks up a live run with its latest event id, and nothing once it ended', async () => {
    const user = 'u-lookup';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-lookup', model: 'hang', content: 'Wait for me.' })
    );
    const runId = start.body!.runId as string;
    const seen = await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });

    const live = (await fetch(`${base}/runs?conversationId=c-lookup`, { headers: as(user) }).then(
      (response) => response.json()
    )) as { run: { lastEventId: string } };
    expect(live).toMatchObject({
      v: 1,
      run: { runId, conversationId: 'c-lookup', seq: 1, user: { content: 'Wait for me.' } },
    });
    expect(Number(live.run.lastEventId)).toBeGreaterThanOrEqual(seen.at(-1)!.id);
    expect(Number(live.run.lastEventId)).toBeLessThan(await runner.journalLength(runId));
    // Another viewer sees no run of this conversation.
    expect(
      await fetch(`${base}/runs?conversationId=c-lookup`, { headers: as('u-lookup-other') }).then(
        (response) => response.json()
      )
    ).toEqual({ v: 1, run: null });
    expect(
      (await fetch(`${base}/runs/${runId}/events`, { headers: as('u-lookup-other') })).status
    ).toBe(404);

    // Nor can it stop the run (an invariant guard: stop has checked the owner from the start).
    expect((await post(`/runs/${runId}/stop`, as('u-lookup-other'), { v: 1 })).status).toBe(404);
    expect(await runner.lookup(user, 'c-lookup')).not.toBeNull();

    await post(`/runs/${runId}/stop`, as(user), { v: 1 });
    await events(runId, user);
    expect(
      await fetch(`${base}/runs?conversationId=c-lookup`, { headers: as(user) }).then((response) =>
        response.json()
      )
    ).toEqual({ v: 1, run: null });
  });

  it('a retry of a failed turn carries on from its finished steps without running their tools again', async () => {
    const user = 'u-retry';
    flaky.failNext = true;
    const recordsBefore = calls.record;
    const first = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-retry', model: 'flaky' })
    );
    const failed = await events(first.body!.runId as string, user);
    expect(failed.some(({ event }) => event.type === 'error')).toBe(true);
    expect(ended(failed)).toMatchObject({ status: 'error', resumable: true, steps: 1 });
    expect(calls.record).toBe(recordsBefore + 1);

    const retry = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-retry', model: 'flaky', retry: true })
    );
    expect(retry.status).toBe(201);
    const entries = await events(retry.body!.runId as string, user);
    expect(ended(entries).status).toBe('done');
    expect(calls.record).toBe(recordsBefore + 1);
    const started = entries[0]!.event as Extract<RunEvent, { type: 'run-started' }>;
    expect(started.parts).toMatchObject([{ kind: 'tool', toolName: 'record', state: 'done' }]);
    expect(rebuild(entries).at(-1)).toEqual({ kind: 'text', text: 'Recovered.' });
  });

  it('writes a patch into the head', async () => {
    const user = 'u-patch';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-patch', model: 'tools' })
    );
    await events(start.body!.runId as string, user);
    expect(
      (
        await post('/conversations/c-patch/patch', as(user), {
          v: 1,
          title: 'Renamed',
          model: 'other-model',
        })
      ).status
    ).toBe(204);
    expect(await store.load(user, 'c-patch')).toMatchObject({
      title: 'Renamed',
      titleSource: 'user',
      model: 'other-model',
    });
    expect(
      (await post('/conversations/c-missing/patch', as(user), { v: 1, title: 'x' })).status
    ).toBe(404);
  });

  it('keeps every credential the request carried out of what DBOS persists and out of the head', async () => {
    const user = 'u-custody';
    const sentinel = `sentinel${randomUUID().replace(/-/g, '')}`;
    const content = `custody marker ${randomUUID()}`;
    const headers = {
      ...as(user, sentinel),
      cookie: `session=${sentinel}`,
      'x-civitai-token': sentinel,
    };
    const start = await post(
      '/runs',
      headers,
      startBody({ conversationId: 'c-custody', model: 'tools', content })
    );
    expect(start.status).toBe(201);
    const entries = await readEvents(`${base}/runs/${start.body!.runId as string}/events`, headers);
    expect(ended(entries).status).toBe('done');

    expect(await tableCount(db.url, 'dbos')).toBeGreaterThan(5);
    // Positive control: the scan finds what the run did persist (the user's words, in its input and journal).
    const persisted = await rowsContaining(db.url, 'dbos', content);
    expect(persisted.length).toBeGreaterThan(0);
    // ...including the journal, so the scan below reads the stream values too.
    expect(persisted.some((row) => row.startsWith('streams:'))).toBe(true);
    expect(await rowsContaining(db.url, 'dbos', sentinel)).toEqual([]);
    expect(JSON.stringify([...store.heads.values()])).not.toContain(sentinel);
    expect(JSON.stringify(entries)).not.toContain(sentinel);
  });
});
