import {
  APP_ASSISTANT_RULES,
  APP_ASSISTANT_SUBAGENT_RULES,
  REMOTE_NO_PREVIEW,
  TURN_LIMIT_REFUSAL,
} from '@civitai/app-assistant';
import { REFUSED_BY_PAGE_NOTE } from '@civitai/components-chat/core';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import type { ModelMessage, ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolResultsOf } from '../app-assistant/history';
import { AppAssistantTools, readPageState } from '../app-assistant/provider';
import { SANDBOX_GONE } from '../app-assistant/sandbox';
import type { OpenTools, ToolContext } from '../interfaces';
import type { TokenPurpose } from '../minter';
import { FakeSandboxService } from '../test-support/fake-sandbox';
import { scriptedModel, toolResults } from '../test-support/scripted-model';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY stand-ins for minted tokens: never a real credential.
const tokenFor = (purpose: TokenPurpose) => `test-token-${purpose}`;

let fake: FakeSandboxService;
let purposes: TokenPurpose[];
let seen: string[];
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  purposes = [];
  seen = [];
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

function provider() {
  return new AppAssistantTools({
    sandboxUrl: fake.url,
    tokens: () => async (purpose) => {
      purposes.push(purpose);
      return tokenFor(purpose);
    },
    log: quiet,
    fetch: (input, init) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return fetch(input, init);
    },
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
  });
}

async function open(overrides: Partial<ToolContext> = {}) {
  const reported: ChatToolResult[] = [];
  const stop = new AbortController();
  const tools = await provider().open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    signal: stop.signal,
    report: (result) => reported.push(result),
    ...overrides,
  });
  opened.push(tools);
  return { tools, reported, stop };
}

let callId = 0;
function call(tools: ToolSet, name: string, input: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: `t-${++callId}`, messages: [] } as never)
  );
}

const run = (command: string) => ({ command });
/** Every check report_ready asks for, passing, by the parent. */
async function passAll(tools: ToolSet) {
  await call(tools, 'set_checklist', { items: [{ label: 'Tip calculator', done: true }] });
  await call(tools, 'sandbox__preview_check');
  await call(tools, 'sandbox__run_command', run('cd my-app && npm test'));
  await call(tools, 'sandbox__run_command', run('cd my-app && npx tsc --noEmit'));
}

describe('App Assistant’s tools on the runner', () => {
  it('offers the open app’s sandbox tools and the page tools the runner can run, never the preview', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const names = Object.keys(tools.tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'sandbox__read_file',
        'sandbox__write_file',
        'sandbox__run_command',
        'create_app',
        'set_checklist',
        'report_ready',
      ])
    );
    expect(names).not.toContain('start_preview');
    expect(names).not.toContain('stop_preview');
    expect(tools.hostTools?.sort()).toEqual(['create_app', 'report_ready', 'set_checklist']);
    // The page's prompt, shared: the same rules, and the remote mode's word on the preview.
    expect(tools.rules?.('DEFAULTS')).toBe(`DEFAULTS\n\n${APP_ASSISTANT_RULES}`);
    expect(tools.instructions).toContain(REMOTE_NO_PREVIEW);
    expect(tools.instructions).toContain('sb-my-app-1');
    expect(tools.instructions).not.toContain('call start_preview with');
  });

  it('asks the sandbox service and the MCP server with sandbox tokens only', async () => {
    fake.add('my-app');
    const { tools } = await open();
    expect(await call(tools.tools, 'sandbox__read_file', { path: 'a' })).toBe('export {}');
    expect(fake.requests.length).toBeGreaterThan(2);
    for (const request of fake.requests)
      expect(request.authorization, request.path).toBe(`Bearer ${tokenFor('sandbox')}`);
    expect(new Set(purposes)).toEqual(new Set(['sandbox']));
  });

  it('wakes a paused app as the reply starts, and offers its tools', async () => {
    fake.add('my-app', 'suspended');
    const { tools } = await open();
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/sandboxes')).toBe(true);
    expect(Object.keys(tools.tools)).toContain('sandbox__run_command');
    expect(tools.instructions).toContain('It is running');
  });

  it('opens no app the page names but the user does not have', async () => {
    fake.add('my-app');
    const { tools } = await open({ page: { app: 'someone-elses-app' } });
    expect(Object.keys(tools.tools).filter((name) => name.startsWith('sandbox__'))).toEqual([]);
    expect(tools.instructions).toContain('No app is open');
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('sends no token to an MCP address outside the sandbox service, and offers none of its tools', async () => {
    const elsewhere = 'http://127.0.0.2:9/mcp/sb';
    fake.add('my-app').mcpUrl = elsewhere;
    const { tools } = await open();
    expect(Object.keys(tools.tools).filter((name) => name.startsWith('sandbox__'))).toEqual([]);
    // Control: the provider did reach the sandbox service itself.
    expect(seen.some((url) => url.startsWith(fake.url))).toBe(true);
    expect(seen.filter((url) => url.startsWith('http://127.0.0.2'))).toEqual([]);
  });

  it('finds a sandbox paused mid-reply again, wakes it and makes the call there, once', async () => {
    const record = fake.add('my-app');
    const { tools } = await open();
    // Idle for 30 minutes while the reply only talked to the model: the service paused it.
    record.state = 'suspended';
    expect(await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'abc' })).toBe(
      'wrote 3 bytes'
    );
    expect(fake.callsTo('write_file')).toBe(1);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/sandboxes')).toBe(true);
  });

  it('never makes a call again when an app that still runs answered it with an error status', async () => {
    fake.add('my-app');
    const { tools } = await open();
    // A proxy's 502, a pod restart: the call may have run before the error came back.
    fake.failCalls = 1;
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'x' })
    ).toMatchObject({
      error: expect.stringMatching(/may have finished/),
      retryable: true,
    });
    expect(fake.callsTo('write_file')).toBe(0);
    // It ran, so nothing was woken.
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/sandboxes')).toBe(
      false
    );
    // Control: the next call goes through on the same app.
    expect(await call(tools.tools, 'sandbox__list_dir', { path: '.' })).toBe('src/');
  });

  it('wakes a paused app once for calls that failed together', async () => {
    const record = fake.add('my-app');
    const { tools } = await open();
    record.state = 'suspended';
    const results = await Promise.all([
      call(tools.tools, 'sandbox__read_file', { path: 'a' }),
      call(tools.tools, 'sandbox__read_file', { path: 'b' }),
    ]);
    expect(results).toEqual(['export {}', 'export {}']);
    expect(fake.callsTo('read_file')).toBe(2);
    expect(
      fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sandboxes')
    ).toHaveLength(1);
    // The connection it made is the one Stop closes.
    const running = call(tools.tools, 'sandbox__run_command', run('hang'));
    running.catch(() => undefined);
    await expect.poll(() => fake.callsTo('run_command'), { timeout: 5_000 }).toBe(1);
    await tools.close();
    await expect.poll(() => fake.abandoned.length, { timeout: 5_000 }).toBe(1);
  });

  it('does not offer the tunnel tools, which serve only the page’s preview', async () => {
    fake.add('my-app');
    const { tools } = await open();
    expect(Object.keys(tools.tools).filter((name) => name.includes('tunnel'))).toEqual([]);
    // Control: the fake does list one.
    expect(Object.keys(tools.tools)).toContain('sandbox__read_file');
  });

  it('never makes a new, empty app in place of one deleted mid-reply', async () => {
    fake.add('my-app');
    const { tools } = await open();
    fake.sandboxes.splice(0);
    await expect(call(tools.tools, 'sandbox__write_file', { path: 'a' })).rejects.toThrow(
      SANDBOX_GONE
    );
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/v1/sandboxes')).toBe(
      false
    );
    expect(fake.callsTo('write_file')).toBe(0);
  });

  it('closing the tools ends a run_command still running in the sandbox', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const running = call(tools.tools, 'sandbox__run_command', run('hang'));
    running.catch(() => undefined);
    await expect.poll(() => fake.callsTo('run_command'), { timeout: 5_000 }).toBe(1);
    expect(fake.abandoned).toEqual([]);
    await tools.close();
    // The transport is gone: the sandbox saw the call's connection close, which is what ends it.
    await expect.poll(() => fake.abandoned.length, { timeout: 5_000 }).toBe(1);
    await expect(running).rejects.toBeDefined();
    // And nothing reconnects afterwards.
    const before = fake.requests.length;
    await expect(call(tools.tools, 'sandbox__read_file', { path: 'a' })).rejects.toBeDefined();
    expect(fake.requests.length).toBe(before);
  });

  it('reports every finished call to the page, as the browser’s gate reports it', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    await call(tools.tools, 'sandbox__read_file', { path: 'a' });
    await call(tools.tools, 'report_ready');
    expect(reported.map((r) => r.name)).toEqual(['sandbox__read_file', 'report_ready']);
    expect(reported[0]).toMatchObject({ output: 'export {}', isError: false });
    expect(reported[1]).toMatchObject({
      isError: true,
      refused: expect.stringMatching(/^Not ready/),
    });
  });
});

describe('App Assistant’s gate on the runner', () => {
  it('refuses report_ready until the parent ran the checks, and a file change undoes them', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const notReady = (await call(tools.tools, 'report_ready')) as { error: string };
    expect(notReady.error).toMatch(/^Not ready yet\./);
    await passAll(tools.tools);
    expect(await call(tools.tools, 'report_ready')).toMatchObject({ ready: true });
    await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'x' });
    expect(((await call(tools.tools, 'report_ready')) as { error: string }).error).toMatch(
      /sandbox__preview_check: it has not run/
    );
  });

  it('a command other than the checks undoes them; reading does not', async () => {
    fake.add('my-app');
    const { tools } = await open();
    await passAll(tools.tools);
    await call(tools.tools, 'sandbox__read_file', { path: 'a' });
    expect(await call(tools.tools, 'report_ready')).toMatchObject({ ready: true });
    await call(tools.tools, 'sandbox__run_command', run('npm install'));
    expect(await call(tools.tools, 'report_ready')).toMatchObject({ error: expect.any(String) });
  });

  it('ends the reply at its 151st parent call', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    for (let i = 0; i < 150; i++) await call(tools.tools, 'report_ready');
    const ended = (await call(tools.tools, 'sandbox__read_file', { path: 'a' })) as {
      error: string;
    };
    expect(ended.error).toBe(TURN_LIMIT_REFUSAL);
    // The 150th was still the gate's ordinary refusal, not the end.
    expect(reported[149]).not.toHaveProperty('stopped');
    expect(reported.at(-1)).toMatchObject({ stopped: true, refused: TURN_LIMIT_REFUSAL });
    expect(fake.callsTo('read_file')).toBe(0);
  });

  it('keeps a subagent read-only: it cannot write or run commands', async () => {
    fake.add('my-app');
    const child = scriptedModel((prompt) =>
      toolResults(prompt) === 0
        ? {
            calls: [
              { toolName: 'sandbox__write_file', input: { path: 'a', content: 'x' } },
              { toolName: 'sandbox__run_command', input: { command: 'npm test' } },
              { toolName: 'sandbox__read_file', input: { path: 'a' } },
            ],
          }
        : { text: 'Done.' }
    );
    const { tools } = await open({ subagents: true, model: () => child });
    await call(tools.tools, 'dispatch_agent', { task: 'Change a.', mode: 'read' });
    expect(fake.callsTo('write_file')).toBe(0);
    expect(fake.callsTo('run_command')).toBe(0);
    // Control: the read it was allowed did run.
    expect(fake.callsTo('read_file')).toBe(1);
  });

  it('leaves a subagent’s calls out of the parent’s 150', async () => {
    fake.add('my-app');
    // The subagent reads five times, then answers.
    const child = scriptedModel((prompt) =>
      toolResults(prompt) < 5
        ? { calls: [{ toolName: 'sandbox__read_file', input: { path: 'a' } }] }
        : { text: 'Found it.' }
    );
    const { tools, reported } = await open({ subagents: true, model: () => child });
    for (let i = 0; i < 148; i++) await call(tools.tools, 'report_ready');
    const dispatched = (await call(tools.tools, 'dispatch_agent', {
      task: 'Read a and say what it exports.',
      mode: 'read',
    })) as { status: string };
    expect(dispatched.status).toBe('done');
    // All five ran though the parent's count stood at 149: a subagent has its own budget.
    expect(fake.callsTo('read_file')).toBe(5);
    expect(reported.filter((r) => r.subagent !== undefined)).toHaveLength(5);
    expect(await call(tools.tools, 'sandbox__list_dir', { path: '.' })).toBe('src/');
    expect(await call(tools.tools, 'sandbox__list_dir', { path: '.' })).toMatchObject({
      error: TURN_LIMIT_REFUSAL,
    });
  });

  it('offers subagents only when civitai’s grant says the viewer has them', async () => {
    fake.add('my-app');
    const child = scriptedModel(() => ({ text: 'ok' }));
    const off = await open({ subagents: false, model: () => child });
    expect(Object.keys(off.tools.tools)).not.toContain('dispatch_agent');
    expect(off.tools.rules?.('D')).not.toContain(APP_ASSISTANT_SUBAGENT_RULES);
    const on = await open({ subagents: true, model: () => child });
    expect(Object.keys(on.tools.tools)).toContain('dispatch_agent');
    expect(on.tools.rules?.('D')).toContain(APP_ASSISTANT_SUBAGENT_RULES);
  });

  it('a reply carried on from saved steps keeps its count and what it verified', async () => {
    fake.add('my-app');
    const current = messagesOf([
      ['set_checklist', { items: [{ label: 'Tip', done: true }] }, { updated: true, open: 0 }],
      ['sandbox__preview_check', {}, 'render: ok'],
      ['sandbox__run_command', run('cd my-app && npm test'), 'exit_code: 0'],
      ['sandbox__run_command', run('cd my-app && npx tsc --noEmit'), 'exit_code: 0'],
    ]);
    const { tools } = await open({ history: { earlier: [], current } });
    expect(await call(tools.tools, 'report_ready')).toMatchObject({ ready: true });

    const many = messagesOf(
      Array.from({ length: 150 }, () => ['sandbox__list_dir', {}, 'src/'] as const)
    );
    const full = await open({ history: { earlier: [], current: many } });
    expect(await call(full.tools.tools, 'sandbox__list_dir', { path: '.' })).toMatchObject({
      error: TURN_LIMIT_REFUSAL,
    });
  });

  it('a new reply keeps the conversation’s checklist but checks the app again', async () => {
    fake.add('my-app');
    const earlier = messagesOf([
      ['set_checklist', { items: [{ label: 'Tip', done: true }] }, { updated: true, open: 0 }],
      ['sandbox__preview_check', {}, 'render: ok'],
      ['sandbox__run_command', run('cd my-app && npm test'), 'exit_code: 0'],
      ['sandbox__run_command', run('cd my-app && npx tsc --noEmit'), 'exit_code: 0'],
    ]);
    const { tools } = await open({ history: { earlier, current: [] } });
    const refusal = ((await call(tools.tools, 'report_ready')) as { error: string }).error;
    expect(refusal).toMatch(/sandbox__preview_check: it has not run/);
    expect(refusal).not.toMatch(/Call set_checklist/);
  });
});

describe('the page state the runner reads', () => {
  it('takes an app key and nothing else', () => {
    expect(readPageState({ app: 'my-app' })).toEqual({ app: 'my-app' });
    for (const app of ['../x', 'A', '', 42, null, 'x'.repeat(80)])
      expect(readPageState({ app } as never)).toEqual({ app: null });
    expect(readPageState(undefined)).toEqual({ app: null });
  });
});

describe('toolResultsOf', () => {
  it('pairs each call with its saved result, marking failures and the gate’s refusals', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 'x', input: { n: 1 } },
          { type: 'tool-call', toolCallId: 'b', toolName: 'y', input: {} },
          { type: 'tool-call', toolCallId: 'c', toolName: 'z', input: {} },
          { type: 'tool-call', toolCallId: 'd', toolName: 'w', input: {} },
          { type: 'tool-call', toolCallId: 'e', toolName: 'v', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 'x',
            output: { type: 'text', value: 'ok' },
          },
          {
            type: 'tool-result',
            toolCallId: 'b',
            toolName: 'y',
            output: { type: 'error-text', value: 'boom' },
          },
          {
            type: 'tool-result',
            toolCallId: 'd',
            toolName: 'w',
            output: { type: 'json', value: { error: 'Not ready', note: REFUSED_BY_PAGE_NOTE } },
          },
          {
            type: 'tool-result',
            toolCallId: 'e',
            toolName: 'v',
            output: { type: 'json', value: { error: 'failed', note: 'other' } },
          },
        ],
      },
    ];
    expect(toolResultsOf(messages)).toEqual([
      { name: 'x', input: { n: 1 }, output: 'ok', isError: false },
      { name: 'y', input: {}, output: { error: 'boom' }, isError: true },
      { name: 'z', input: {}, output: undefined, isError: true },
      {
        name: 'w',
        input: {},
        output: { error: 'Not ready', note: REFUSED_BY_PAGE_NOTE },
        isError: true,
        refused: 'Not ready',
      },
      { name: 'v', input: {}, output: { error: 'failed', note: 'other' }, isError: true },
    ]);
  });
});

/** A reply's saved messages making these calls, each answered with its output. */
function messagesOf(
  calls: readonly (readonly [string, Record<string, unknown>, unknown])[]
): ModelMessage[] {
  return calls.flatMap(([toolName, input, output], index): ModelMessage[] => [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `s-${index}`, toolName, input }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: `s-${index}`,
          toolName,
          output:
            typeof output === 'string'
              ? { type: 'text', value: output }
              : { type: 'json', value: output as never },
        },
      ],
    },
  ]);
}
