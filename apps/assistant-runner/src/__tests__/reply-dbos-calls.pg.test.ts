import type { StartRunRequest } from '@civitai/components-chat/runner-protocol';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GrantStore } from '../core/interfaces';
import { MemoryConversationStore } from '../core/memory-store';
import { Runner, type ReplyOutput } from '../core/runner';
import { fakeTools, untilAborted } from '../core/test-support/fakes';
import { freshDatabase, TEST_DATABASE_URL } from '../core/test-support/pg';
import { scriptedModel, toolResults } from '../core/test-support/scripted-model';
import { GOLDEN } from './golden/reply-dbos-calls';

/**
 * The golden record of the DBOS calls a reply makes: its workflows (names, version, queue), the
 * operations DBOS recorded for it in order (steps, recv, send), the journal stream it wrote and the
 * messages sent to it. Read back from DBOS's own tables, which is what recovery replays against, so
 * a refactor that leaves this record as it was cannot strand a run of the version before it.
 *
 * Runs against a real Postgres (CI's `App unit tests` job); without
 * ASSISTANT_RUNNER_TEST_DATABASE_URL it skips.
 */
const describePg = TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.CI && !TEST_DATABASE_URL)
  throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set in CI');

const SYSTEM_SCHEMA = 'dbos';
/** The columns of `workflow_status` that say which code a run belongs to. */
const STATUS_KEYS = [
  'name',
  'status',
  'application_version',
  'queue_name',
  'authenticated_user',
  'class_name',
  'config_name',
  'workflow_timeout_ms',
  'deduplication_id',
] as const;

describePg('the DBOS calls a reply makes (golden)', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let client: pg.Client;
  let runner: Runner;
  const store = new MemoryConversationStore();
  let waiting: () => void = () => undefined;
  const tools = fakeTools({
    record: async () => 'recorded',
    wait: async (_input, { abortSignal }) => {
      waiting();
      return untilAborted(abortSignal);
    },
  });
  const scripts: Record<string, () => ReturnType<typeof scriptedModel>> = {
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
  };
  /** Keeps no grants: what is recorded here is DBOS's, not the grant table's. */
  const grants: GrantStore = {
    save: async () => undefined,
    delete: async () => undefined,
    forgetUnlessEndPending: async () => undefined,
    markEndPending: async () => undefined,
    pendingEnds: async () => [],
    sweep: async () => 0,
  };

  beforeAll(async () => {
    db = await freshDatabase('golden');
    runner = new Runner({
      models: { languageModel: ({ model }) => scripts[model]!() },
      tools: tools.provider,
      store,
      grants,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: (object, message) => console.error(message, object),
      },
      wallClockMs: 60_000,
      stopGraceMs: 20_000,
    });
    runner.register();
    await runner.launch({
      databaseUrl: db.url,
      executorId: 'golden',
      workerConcurrency: 4,
      logLevel: 'warn',
    });
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await runner?.shutdown();
    await db?.drop();
  });

  function request(user: string, key: string, model: string): StartRunRequest {
    return {
      v: 1,
      idempotencyKey: key,
      conversationId: `c-${user}`,
      turn: { seq: 1, user: { content: 'Please do the thing.', attachments: [] } },
      model,
      settings: {
        maxOutputTokens: 1024,
        tier: 'auto',
        allowMature: false,
        autoRunLimit: 0,
        spokenReplies: false,
      },
    };
  }

  async function start(user: string, key: string, model: string): Promise<string> {
    const body = request(user, key, model);
    const outcome = await runner.start(user, body, {
      token: 'golden-grant',
      userId: user,
      conversationId: body.conversationId,
      idempotencyKey: key,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      subagents: false,
      preview: false,
    });
    if (!outcome.ok) throw new Error(`start refused: ${outcome.error} ${outcome.message}`);
    return outcome.response.runId;
  }

  /** Everything DBOS keeps about one reply (and its stop marker), with its ids named for what they are. */
  async function record(runId: string, options: { journalTypes: boolean }) {
    const name = (id: string | null) => (id === null ? null : id.replace(runId, '<run>'));
    const { rows: workflows } = await client.query<{ id: string; row: Record<string, unknown> }>(
      `select workflow_uuid as id, to_jsonb(w) as row from "${SYSTEM_SCHEMA}".workflow_status w
       where workflow_uuid like $1 order by workflow_uuid`,
      [`${runId}%`]
    );
    const { rows: operations } = await client.query<{
      function_id: number;
      function_name: string;
      child_workflow_id: string | null;
      output: string | null;
      error: string | null;
    }>(
      `select function_id, function_name, child_workflow_id, output, error
       from "${SYSTEM_SCHEMA}".operation_outputs where workflow_uuid = $1 order by function_id`,
      [runId]
    );
    const { rows: streams } = await client.query<{ key: string; function_id: number }>(
      `select distinct key, function_id from "${SYSTEM_SCHEMA}".streams
       where workflow_uuid = $1 order by key, function_id`,
      [runId]
    );
    const { rows: notifications } = await client.query<{
      topic: string | null;
      message: string;
      consumed: boolean;
    }>(
      `select topic, message, consumed from "${SYSTEM_SCHEMA}".notifications
       where destination_uuid = $1 order by topic, message, consumed`,
      [runId]
    );
    const types: string[] = [];
    let ended: unknown;
    for await (const { event } of runner.events(runId, undefined, new AbortController().signal)) {
      // Text arrives in as many deltas as the clock cuts it into: one entry per run of a type.
      if (types.at(-1) !== event.type) types.push(event.type);
      if (event.type === 'run-ended') ended = { status: event.status, steps: event.steps };
    }
    const output = await DBOS.retrieveWorkflow<ReplyOutput>(runId).getResult();
    return {
      workflows: workflows.map(({ id, row }) => ({
        id: name(id),
        ...Object.fromEntries(
          STATUS_KEYS.filter((key) => key in row).map((key) => [key, row[key]])
        ),
      })),
      operations: operations.map((op) => ({
        id: op.function_id,
        name: op.function_name,
        child: name(op.child_workflow_id),
        // A recv's output is the message it got; any other output carries times or ids.
        ...(op.function_name === 'DBOS.recv' ? { output: op.output } : {}),
        failed: op.error !== null,
      })),
      streams,
      notifications,
      journal: options.journalTypes
        ? { types, ended }
        : { first: types[0], last: types.at(-1), ended },
      output: { status: output.status, steps: output.steps, resume: output.resume !== undefined },
    };
  }

  const observed: Record<string, unknown> = {};
  const expectGolden = (scenario: string, value: unknown) => {
    observed[scenario] = value;
    if (JSON.stringify(value) !== JSON.stringify(GOLDEN[scenario]))
      console.log(`GOLDEN-OBSERVED ${scenario} ${JSON.stringify(value)}`);
    expect(value).toEqual(GOLDEN[scenario]);
  };

  it('a reply that calls a tool and ends done', async () => {
    const runId = await start('golden-done', 'key-done', 'tools');
    await DBOS.retrieveWorkflow(runId).getResult();
    expectGolden('done', await record(runId, { journalTypes: true }));
  });

  it('a reply the viewer stops while a tool runs', async () => {
    const started = new Promise<void>((resolve) => (waiting = resolve));
    const runId = await start('golden-stop', 'key-stop', 'hang');
    await started;
    expect(await runner.stop('golden-stop', runId)).toBe(true);
    await DBOS.retrieveWorkflow(runId).getResult();
    // Whether the cut-off call's result is journaled before the abort lands is a race: only the
    // journal's ends are recorded.
    expectGolden('stopped', await record(runId, { journalTypes: false }));
  });

  it('a reply stopped by its key before it started', async () => {
    await runner.stopByKey('golden-marker', 'key-marker');
    const runId = await start('golden-marker', 'key-marker', 'tools');
    await DBOS.retrieveWorkflow(runId).getResult();
    expectGolden('stopped-before-start', await record(runId, { journalTypes: true }));
  });

  it('records every scenario the golden holds', () => {
    expect(Object.keys(observed).sort()).toEqual(Object.keys(GOLDEN).sort());
  });
});
