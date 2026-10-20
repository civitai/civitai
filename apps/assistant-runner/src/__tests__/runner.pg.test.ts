import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { TurnPart } from '@civitai/components-chat/core';
import {
  applyRunEvent,
  type RunEvent,
  type StartRunRequest,
} from '@civitai/components-chat/runner-protocol';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ModelMessage } from 'ai';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { RunCredentials } from '../credentials';
import { RunGrants } from '../grants';
import type { ModelProvider } from '../interfaces';
import { startTurn, withProgress } from '../head';
import { MemoryConversationStore } from '../memory-store';
import {
  REPLIES_QUEUE,
  REPLY_WORKFLOW,
  Runner,
  WORKFLOW_VERSION,
  type RunnerDeps,
} from '../runner';
import { createTokenVerifier } from '../tokens';
import { bearerAuthenticator, fakeTools, untilAborted } from '../test-support/fakes';
import { signGrant, testKeys } from '../test-support/keys';
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
// TEST-ONLY keys standing in for civitai's: every start carries a grant signed with them.
const keys = testKeys();

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
  /** What the `mint` model minted with, per request: the grant it found and the token it got. */
  const mints: { runId: string; grant: string; token: string }[] = [];
  let grantsPool: pg.Pool;
  let grants: RunGrants;
  const credentials = new RunCredentials(
    {
      forRun: (runId) => grants.forRun(runId),
      forConversation: (userId, conversationId) => grants.forConversation(userId, conversationId),
    },
    {
      token: async (grant) => {
        const token = `minted${randomUUID().replace(/-/g, '')}`;
        mints.push({ runId: '', grant, token });
        return token;
      },
    }
  );
  const models: ModelProvider = {
    languageModel: ({ model, runId }) => {
      if (model === 'mint') {
        // As a real provider does: the token is minted inside the request, from the run's grant.
        const scripted = scriptedModel(() => ({ text: 'Minted.' }));
        const doStream = scripted.doStream.bind(scripted);
        scripted.doStream = async (options) => {
          await credentials.forRun(runId)('chat');
          mints.at(-1)!.runId = runId;
          return doStream(options);
        };
        return scripted;
      }
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
    // Set in beforeAll, before the runner is made: it needs the test database.
    grants: undefined as unknown as RunGrants,
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
    grantsPool = new pg.Pool({ connectionString: db.url, max: 4 });
    grants = new RunGrants(grantsPool);
    await grants.init();
    deps.grants = grants;
    runner = new Runner(deps);
    runner.register();
    await runner.launch({
      databaseUrl: db.url,
      executorId: 'test',
      workerConcurrency: 10,
      logLevel: 'warn',
    });
    app = buildApp({
      service: runner,
      authenticator: bearerAuthenticator,
      grants: createTokenVerifier(keys.publicPem),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
    await runner?.shutdown();
    await grantsPool?.end();
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

  /** The grant civitai would sign for this start, for the user `headers` sign in as. */
  const grantFor = (headers: Record<string, string>, body: StartRunRequest) =>
    signGrant(keys, {
      userId: /^Bearer user:([^\s:]+)/.exec(headers.authorization ?? '')![1]!,
      conversationId: body.conversationId,
      idempotencyKey: body.idempotencyKey,
    });

  /** A POST as `headers` say; a start also carries its grant, unless `headers` already has one. */
  async function post(path: string, headers: Record<string, string>, body: unknown) {
    const grant: Record<string, string> =
      path === '/runs' && !headers['x-run-grant'] && headers.authorization
        ? { 'x-run-grant': await grantFor(headers, body as StartRunRequest) }
        : {};
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, ...grant, 'content-type': 'application/json' },
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

  async function sql<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  it('ends a stream whose run-ended was never journaled with how the head says the reply ended', async () => {
    const user = 'u-lost-end';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-lost-end', model: 'tools' })
    );
    const runId = start.body!.runId as string;
    const original = ended(await events(runId, user));
    expect(original.status).toBe('done');
    // As if the journal write of run-ended had failed while the run itself finished.
    await sql(
      `delete from dbos.streams where workflow_uuid = $1 and "offset" = (select max("offset") from dbos.streams where workflow_uuid = $1)`,
      [runId]
    );
    const replayed = await events(runId, user);
    expect(ended(replayed)).toMatchObject({
      type: 'run-ended',
      status: 'done',
      messages: original.messages,
    });
  });

  /** A run whose workflow never runs here (another version), its head saved `running`, then put in `status`. */
  async function parkedRun(
    user: string,
    conversationId: string,
    status: string,
    deadlinePast = false
  ) {
    await store.update(user, conversationId, () =>
      withProgress(
        startTurn(null, {
          conversationId,
          seq: 1,
          user: { content: 'Parked.', attachments: [] },
          now: new Date(),
        }),
        1,
        [{ role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] }],
        new Date()
      )
    );
    const runId = `run_parked_${randomUUID().replace(/-/g, '')}`;
    await DBOS.enqueueWorkflowWithOptions(
      {
        queueName: REPLIES_QUEUE,
        workflowName: REPLY_WORKFLOW,
        workflowID: runId,
        appVersion: 'reply-parked',
        authenticatedUser: user,
        attributes: { conversationId, seq: 1 },
      },
      { runId }
    );
    await sql(
      `update dbos.workflow_status set status = $2, workflow_deadline_epoch_ms = $3 where workflow_uuid = $1`,
      [runId, status, deadlinePast ? Date.now() - 1000 : null]
    );
    return runId;
  }

  it('a run DBOS cancelled at its deadline ends ran_out, in its stream and its head', async () => {
    const runId = await parkedRun('u-timed-out', 'c-timed-out', 'CANCELLED', true);
    expect(ended(await events(runId, 'u-timed-out'))).toMatchObject({
      status: 'ran_out',
      steps: 1,
    });
    const head = await store.load('u-timed-out', 'c-timed-out');
    expect(head!.turns[0]!.assistant).toMatchObject({ status: 'done', ranOut: true });
  });

  it('a run past its recovery limit ends error, in its stream and its head', async () => {
    const runId = await parkedRun('u-exhausted', 'c-exhausted', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED');
    expect(ended(await events(runId, 'u-exhausted'))).toMatchObject({
      status: 'error',
      resumable: false,
    });
    const head = await store.load('u-exhausted', 'c-exhausted');
    expect(head!.turns[0]!.assistant).toMatchObject({ status: 'error' });
  });

  it('records the end of a run cancelled outright in the head, once, and ends its stream with it', async () => {
    const user = 'u-cancelled';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-cancelled', model: 'hang' })
    );
    const runId = start.body!.runId as string;
    await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });
    const before = { aborted: calls.waitAborted, closed: tools.stats.closed };
    await DBOS.cancelWorkflow(runId);
    const entries = await events(runId, user);
    expect(ended(entries).status).toBe('stopped');
    const head = await store.load(user, 'c-cancelled');
    expect(head!.v).toBe(2);
    expect(head!.turns[0]!.assistant).toMatchObject({ status: 'aborted' });
    // The user's slot is free again.
    expect(await runner.lookup(user, 'c-cancelled')).toBeNull();

    // The pass still running in this process stops too: its call is aborted and its tools closed.
    const deadline = Date.now() + 10_000;
    while (calls.waitAborted === before.aborted && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.waitAborted).toBe(before.aborted + 1);
    while (tools.stats.closed === before.closed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tools.stats.closed).toBe(before.closed + 1);
    // ...and, finishing after the cancel path wrote the end, it does not replace it.
    const waitsAfter = calls.wait;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls.wait).toBe(waitsAfter);
    expect(await store.load(user, 'c-cancelled')).toEqual(head);
  });

  it('still ends the stream of a run cancelled outright when its head can no longer be written', async () => {
    const user = 'u-cancelled-unwritable';
    const start = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-cancelled-unwritable', model: 'hang' })
    );
    const runId = start.body!.runId as string;
    await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });
    // As once the user turned the assistant off: every write to the head is refused.
    const real = deps.store;
    deps.store = {
      load: (userId, conversationId) => real.load(userId, conversationId),
      update: async () => {
        throw new Error('consent_required');
      },
    };
    try {
      await DBOS.cancelWorkflow(runId);
      const entries = await events(runId, user);
      expect(ended(entries)).toMatchObject({ type: 'run-ended', status: 'stopped' });
    } finally {
      deps.store = real;
    }
  });

  it('deletes the journals and workflows of runs that ended before the retention cutoff, and nothing live', async () => {
    const done = await post(
      '/runs',
      as('u-retention'),
      startBody({ conversationId: 'c-retention', model: 'tools' })
    );
    const doneId = done.body!.runId as string;
    await events(doneId, 'u-retention');
    await post('/runs/stop', as('u-retention'), {
      v: 1,
      idempotencyKey: 'never-started',
      conversationId: 'c-retention',
    });
    const live = await post(
      '/runs',
      as('u-retention-live'),
      startBody({ conversationId: 'c-retention-live', model: 'hang' })
    );
    const liveId = live.body!.runId as string;
    await events(liveId, 'u-retention-live', {
      stopWhen: ({ event }) => event.type === 'tool-call',
    });
    // Settled: the finished run's workflow has recorded its output.
    await DBOS.getResult(doneId);

    expect(await runner.cleanup(60 * 60 * 1000)).toBe(0);
    expect(await runner.cleanup(0)).toBeGreaterThanOrEqual(2);
    expect(await DBOS.getWorkflowStatus(doneId)).toBeNull();
    expect(await runner.journalLength(doneId)).toBe(0);
    expect(
      await sql(`select 1 from dbos.workflow_status where name = 'reply-stop-marker'`)
    ).toEqual([]);
    expect(await DBOS.getWorkflowStatus(liveId)).toMatchObject({ status: 'PENDING' });
    expect(await runner.journalLength(liveId)).toBeGreaterThan(0);

    await post(`/runs/${liveId}/stop`, as('u-retention-live'), { v: 1 });
    expect(ended(await events(liveId, 'u-retention-live')).status).toBe('stopped');
  });

  it('ends a run stranded on an old workflow version as resumable, frees its user, and lets Continue carry on', async () => {
    const user = 'u-stranded';
    const recordsBefore = calls.record;
    const finished: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'old-a', toolName: 'record', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'old-a',
            toolName: 'record',
            output: { type: 'text', value: 'recorded' },
          },
        ],
      },
    ];
    await store.update(user, 'c-stranded', () =>
      withProgress(
        startTurn(null, {
          conversationId: 'c-stranded',
          seq: 1,
          user: { content: 'Old run.', attachments: [] },
          now: new Date(),
        }),
        1,
        finished,
        new Date()
      )
    );
    // A run an earlier image started: another workflow version, on this runner's executor id.
    const strandedId = `run_stranded_${randomUUID().replace(/-/g, '')}`;
    await DBOS.enqueueWorkflowWithOptions(
      {
        queueName: REPLIES_QUEUE,
        workflowName: REPLY_WORKFLOW,
        workflowID: strandedId,
        appVersion: 'reply-0',
        deduplicationID: user,
        authenticatedUser: user,
        attributes: { conversationId: 'c-stranded', seq: 1 },
      },
      { runId: strandedId, userId: user, conversationId: 'c-stranded', seq: 1 }
    );
    await sql(`update dbos.workflow_status set executor_id = 'test' where workflow_uuid = $1`, [
      strandedId,
    ]);
    expect(WORKFLOW_VERSION).not.toBe('reply-0');
    // A current run of another user, which the sweep must leave alone.
    const live = await post(
      '/runs',
      as('u-stranded-live'),
      startBody({ conversationId: 'c-stranded-live', model: 'hang' })
    );
    const liveId = live.body!.runId as string;
    await events(liveId, 'u-stranded-live', {
      stopWhen: ({ event }) => event.type === 'tool-call',
    });

    expect(await runner.sweepStranded()).toEqual([strandedId]);
    expect(await runner.sweepStranded()).toEqual([]);
    expect(await DBOS.getWorkflowStatus(strandedId)).toMatchObject({ status: 'CANCELLED' });
    expect(await DBOS.getWorkflowStatus(liveId)).toMatchObject({ status: 'PENDING' });

    const head = await store.load(user, 'c-stranded');
    expect(head!.v).toBe(2);
    expect(head!.turns[0]!.assistant).toMatchObject({
      status: 'error',
      errorKind: 'interrupted',
      messages: finished,
    });
    const end = ended(await events(strandedId, user));
    expect(end).toMatchObject({ status: 'error', resumable: true, steps: 1, messages: finished });

    // Continue: a retry of the turn carries on from the saved step, without running its tool again.
    const retry = await post(
      '/runs',
      as(user),
      startBody({ conversationId: 'c-stranded', model: 'tools', retry: true })
    );
    expect(retry.status).toBe(201);
    const entries = await events(retry.body!.runId as string, user);
    expect(ended(entries).status).toBe('done');
    expect(calls.record).toBe(recordsBefore);
    expect((entries[0]!.event as Extract<RunEvent, { type: 'run-started' }>).parts).toMatchObject([
      { kind: 'tool', toolName: 'record', state: 'done' },
    ]);

    await post(`/runs/${liveId}/stop`, as('u-stranded-live'), { v: 1 });
    expect(ended(await events(liveId, 'u-stranded-live')).status).toBe('stopped');
  });

  it('keeps every credential the request carried out of what DBOS persists and out of the head', async () => {
    const user = 'u-custody';
    const sentinel = `sentinel${randomUUID().replace(/-/g, '')}`;
    const content = `custody marker ${randomUUID()}`;
    const body = startBody({ conversationId: 'c-custody', model: 'tools', content });
    const headers = {
      ...as(user, sentinel),
      cookie: `session=${sentinel}`,
      'x-civitai-token': sentinel,
    };
    const grant = await grantFor(headers, body);
    const start = await post('/runs', { ...headers, 'x-run-grant': grant }, body);
    expect(start.status).toBe(201);
    const entries = await readEvents(`${base}/runs/${start.body!.runId as string}/events`, headers);
    expect(ended(entries).status).toBe('done');

    expect(await tableCount(db.url, 'dbos')).toBeGreaterThan(5);
    // Positive control: the scan finds what the run did persist (the user's words, in its input and journal).
    const persisted = await rowsContaining(db.url, 'dbos', content);
    expect(persisted.length).toBeGreaterThan(0);
    // ...including the journal, so the scan below reads the stream values too.
    expect(persisted.some((row) => row.startsWith('streams:'))).toBe(true);
    for (const credential of [sentinel, grant]) {
      expect(await rowsContaining(db.url, 'dbos', credential)).toEqual([]);
      expect(JSON.stringify([...store.heads.values()])).not.toContain(credential);
      expect(JSON.stringify(entries)).not.toContain(credential);
    }
  });

  it('mints inside the model request from the run’s own grant, and the token lands nowhere', async () => {
    const user = 'u-mint';
    const body = startBody({ conversationId: 'c-mint', model: 'mint' });
    const grant = await grantFor(as(user), body);
    const start = await post('/runs', { ...as(user), 'x-run-grant': grant }, body);
    const runId = start.body!.runId as string;
    expect(ended(await events(runId, user)).status).toBe('done');
    await DBOS.getResult(runId);

    // Positive control: the model did mint, with this run's grant.
    const mine = mints.filter((mint) => mint.runId === runId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((mint) => mint.grant === grant)).toBe(true);
    for (const { token } of mine) {
      expect(await rowsContaining(db.url, 'dbos', token)).toEqual([]);
      expect(await rowsContaining(db.url, 'assistant_runner', token)).toEqual([]);
      expect(JSON.stringify([...store.heads.values()])).not.toContain(token);
    }
    expect(await rowsContaining(db.url, 'dbos', grant)).toEqual([]);
  });

  it('keeps a run’s grant in the runner’s own table while it runs, and forgets it once the run ended itself', async () => {
    const user = 'u-grant-life';
    const body = startBody({ conversationId: 'c-grant-life', model: 'hang' });
    const grant = await grantFor(as(user), body);
    const start = await post('/runs', { ...as(user), 'x-run-grant': grant }, body);
    const runId = start.body!.runId as string;
    await events(runId, user, { stopWhen: ({ event }) => event.type === 'tool-call' });

    expect(await grants.forRun(runId)).toBe(grant);
    expect(await grants.forConversation(user, 'c-grant-life')).toBe(grant);
    expect(await rowsContaining(db.url, 'assistant_runner', grant)).toHaveLength(1);
    expect(await rowsContaining(db.url, 'dbos', grant)).toEqual([]);

    await post(`/runs/${runId}/stop`, as(user), { v: 1 });
    expect(ended(await events(runId, user)).status).toBe('stopped');
    await DBOS.getResult(runId);
    expect(await grants.forRun(runId)).toBeNull();
    expect(await rowsContaining(db.url, 'assistant_runner', grant)).toEqual([]);
  });

  it('keeps no grant for a start it refuses', async () => {
    const user = 'u-grant-refused';
    const body = startBody({ conversationId: 'c-grant-refused', model: 'tools', seq: 4 });
    const grant = await grantFor(as(user), body);
    const stale = await post('/runs', { ...as(user), 'x-run-grant': grant }, body);
    expect(stale.body).toMatchObject({ error: 'stale-turn' });
    expect(await rowsContaining(db.url, 'assistant_runner', grant)).toEqual([]);

    const other = await grantFor(as('u-someone-else'), body);
    const mismatched = await post('/runs', { ...as(user), 'x-run-grant': other }, body);
    expect(mismatched.status).toBe(403);
    expect(await rowsContaining(db.url, 'assistant_runner', other)).toEqual([]);
  });
});
