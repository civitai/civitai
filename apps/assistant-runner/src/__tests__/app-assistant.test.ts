import {
  KEEP_LIMIT,
  NEW_APP_FAILED_KEEP_OPEN,
  REMOTE_PREVIEW,
  TURN_LIMIT_REFUSAL,
  isKeepLimitResult,
  openAppNotChosen,
  assistantRules,
  assistantSubagentRules,
  assistantSubagentInstructions,
} from '@civitai/app-assistant';
import { REFUSED_BY_PAGE_NOTE, buildSystemPrompt } from '@civitai/components-chat/core';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import type { ModelMessage, ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toolResultsOf } from '../app-assistant/history';
import { AppAssistantTools, readPageState } from '../app-assistant/provider';
import { PAUSED_BY_OTHER_APP, PAUSED_IDLE, SANDBOX_GONE } from '../app-assistant/sandbox';
import type { OpenTools, ToolContext } from '../core/interfaces';
import type { TokenPurpose } from '../minter';
import { NEW_CHAT, chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';
import { scriptedModel, toolResults } from '../core/test-support/scripted-model';

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
  const ended: string[] = [];
  const stop = new AbortController();
  const tools = await provider().open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    // A chat that chose the open app, so its changes to it run; a new chat's are refused (NEW_CHAT).
    history: chosenApp('my-app'),
    signal: stop.signal,
    report: (result) => reported.push(result),
    endReply: (message) => ended.push(message),
    ...overrides,
  });
  opened.push(tools);
  return { tools, reported, ended, stop };
}

/** The runner's own reads as a reply opens (the SDK pin check): the assistant made none of them. */
const RUNNER_READS = ['my-app/package.json', 'my-app/node_modules/@civitai/sdk/package.json'];
/** Every `read_file` call but the runner's own SDK pin reads. */
const assistantReads = () =>
  fake.calls.filter((c) => c.tool === 'read_file' && !RUNNER_READS.includes(String(c.args.path)))
    .length;

const opensApps = () =>
  fake.requests.filter((r) => r.method === 'POST' && r.path === '/v1/sandboxes');

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
  it('offers the open app’s sandbox tools and the page tools the runner can run, the preview’s included', async () => {
    fake.add('my-app');
    const { tools } = await open();
    const names = Object.keys(tools.tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'sandbox__read_file',
        'sandbox__write_file',
        'sandbox__run_command',
        'create_app',
        'use_open_app',
        'set_checklist',
        'report_ready',
        'start_preview',
        'stop_preview',
      ])
    );
    expect(tools.hostTools?.sort()).toEqual([
      'create_app',
      'report_ready',
      'set_checklist',
      'start_preview',
      'stop_preview',
      'use_open_app',
    ]);
    // The page's prompt, shared: the same rules, and the remote mode's word on the preview.
    expect(tools.rules?.('DEFAULTS')).toBe(`DEFAULTS\n\n${assistantRules('remote')}`);
    expect(tools.instructions).toContain(REMOTE_PREVIEW);
    expect(tools.instructions).toContain('sb-my-app-1');
    // The runner does the tunnel steps itself: the assistant is never told to.
    expect(tools.instructions).not.toMatch(/sandbox__tunnel_/);
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

  it('opens no app the page names but the user does not have, whatever the key looks like', async () => {
    fake.add('my-app');
    for (const app of ['someone-elses-app', '../my-app', 'MY-APP', 'my-app/../x']) {
      const { tools } = await open({ page: { app } });
      expect(
        Object.keys(tools.tools).filter((name) => name.startsWith('sandbox__')),
        app
      ).toEqual([]);
      expect(tools.instructions, app).toContain('No app is open');
    }
    expect(fake.requests.some((r) => r.method === 'POST')).toBe(false);
    // Control: its own key opens it.
    const own = await open();
    expect(Object.keys(own.tools.tools)).toContain('sandbox__read_file');
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

  it('never wakes a sandbox that paused mid-reply: the call is not made again and the reply ends to be continued', async () => {
    const record = fake.add('my-app');
    const { tools, ended } = await open();
    // Idle for 30 minutes while the reply only talked to the model: the service paused it.
    record.state = 'suspended';
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'abc' })
    ).toMatchObject({
      error: expect.stringMatching(/paused/),
      retryable: true,
    });
    expect(fake.callsTo('write_file')).toBe(0);
    expect(opensApps()).toEqual([]);
    expect(record.state).toBe('suspended');
    expect(ended).toEqual([PAUSED_IDLE]);
  });

  it('an app found starting again (a pod restart) is not reported asleep: maybe finished, and the reply goes on', async () => {
    const record = fake.add('my-app');
    const { tools, ended } = await open();
    record.state = 'starting';
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'x' })
    ).toMatchObject({ error: expect.stringMatching(/may have finished/), retryable: true });
    expect(ended).toEqual([]);
    expect(opensApps()).toEqual([]);
    // Control: a paused one does end the reply.
    record.state = 'suspended';
    await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'x' });
    expect(ended).toEqual([PAUSED_IDLE]);
  });

  it('when the user opens another app mid-reply, leaves it running and ends the reply as paused', async () => {
    fake.add('my-app');
    const { tools, ended } = await open();
    const other = fake.userOpens('other-app');
    await call(tools.tools, 'sandbox__write_file', { path: 'a', content: 'x' });
    expect(ended).toEqual([PAUSED_BY_OTHER_APP]);
    // The user's app keeps running: nothing woke this one, which would have paused it.
    expect(other.state).toBe('running');
    expect(opensApps()).toEqual([]);
    expect(fake.callsTo('write_file')).toBe(0);
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

  it('looks at the user’s apps once for calls refused together, and ends the reply once', async () => {
    const record = fake.add('my-app');
    const { tools, ended } = await open();
    record.state = 'suspended';
    await Promise.all([
      call(tools.tools, 'sandbox__read_file', { path: 'a' }),
      call(tools.tools, 'sandbox__read_file', { path: 'b' }),
    ]);
    expect(
      fake.requests.filter((r) => r.method === 'GET' && r.path === '/v1/sandboxes')
    ).toHaveLength(2);
    expect(ended).toEqual([PAUSED_IDLE]);
    expect(opensApps()).toEqual([]);
  });

  it('ends the reply when waking the app at its start would make a new, empty one', async () => {
    fake.add('my-app', 'suspended');
    // Deleted after the list was read: the service's open makes a new app under the same key.
    fake.deleteBeforeOpen.add('my-app');
    await expect(open()).rejects.toThrow(SANDBOX_GONE);
    expect(fake.calls).toEqual([]);
  });

  it('does not offer the raw tunnel tools, which only the runner’s start_preview drives', async () => {
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
    expect(assistantReads()).toBe(0);
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
    expect(assistantReads()).toBe(1);
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
    expect(assistantReads()).toBe(5);
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
    expect(off.tools.rules?.('D')).not.toContain(assistantSubagentRules('remote'));
    const on = await open({ subagents: true, model: () => child });
    expect(Object.keys(on.tools.tools)).toContain('dispatch_agent');
    expect(on.tools.rules?.('D')).toContain(assistantSubagentRules('remote'));
  });

  it('a reply carried on from saved steps keeps its count and what it verified', async () => {
    fake.add('my-app');
    const current = messagesOf([
      [
        'set_checklist',
        { items: [{ label: 'Tip', done: true }] },
        { updated: true, open: 0, app: 'my-app' },
      ],
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
      [
        'set_checklist',
        { items: [{ label: 'Tip', done: true }] },
        { updated: true, open: 0, app: 'my-app' },
      ],
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

describe('the gate follows the app', () => {
  it('within a reply: checks passed on one app do not make another ready', async () => {
    fake.add('my-app');
    const { tools } = await open();
    await passAll(tools.tools);
    // Control: ready on the app the checks ran on.
    expect(await call(tools.tools, 'report_ready')).toMatchObject({ ready: true });
    expect(await call(tools.tools, 'create_app', { name: 'Tip calculator' })).toMatchObject({
      app: 'tip-calculator',
    });
    const refusal = ((await call(tools.tools, 'report_ready')) as { error: string }).error;
    expect(refusal).toMatch(/sandbox__preview_check: it has not run/);
    expect(refusal).toMatch(/Call set_checklist/);
  });

  it('across replies: one app’s finished checklist does not count for another', async () => {
    fake.add('my-app');
    fake.add('other-app');
    const earlier = messagesOf([
      [
        'set_checklist',
        { items: [{ label: 'Tip', done: true }] },
        { updated: true, open: 0, app: 'my-app' },
      ],
    ]);
    const other = await open({ page: { app: 'other-app' }, history: { earlier, current: [] } });
    expect(((await call(other.tools.tools, 'report_ready')) as { error: string }).error).toMatch(
      /Call set_checklist/
    );
    // Control: the app it was made for still has it.
    const mine = await open({ history: { earlier, current: [] } });
    expect(((await call(mine.tools.tools, 'report_ready')) as { error: string }).error).not.toMatch(
      /Call set_checklist/
    );
  });

  it('tags each checklist the runner shows with its app', async () => {
    fake.add('my-app');
    const { tools } = await open();
    expect(await call(tools.tools, 'set_checklist', { items: [{ label: 'Tip' }] })).toMatchObject({
      awaitsUser: true,
      app: 'my-app',
    });
  });
});

describe('the runner’s prompt', () => {
  /** Every tool name an App Assistant prompt (the page's or the runner's) may mention. */
  const KNOWN = [
    'create_app',
    'use_open_app',
    'set_checklist',
    'report_ready',
    'start_preview',
    'stop_preview',
    'dispatch_agent',
    'fetch_page',
    'get_guide',
    'web_search',
    'run_step',
    'run_workflow',
    // Named by the chat's own rules (`defaultRules`), which the runner's system prompt starts with.
    'ask_choice',
    'open_panel',
    'update_panel',
    'post_to_civitai',
    'search_models',
    'find_services',
    'get_input_schema',
    'caption_media',
    'transcribe_audio',
  ];

  it('names only tools the runner offers', async () => {
    fake.add('my-app');
    const child = scriptedModel(() => ({ text: 'ok' }));
    const { tools } = await open({ subagents: true, model: () => child });
    const offered = Object.keys(tools.tools);
    // The whole system prompt, built as the runner builds it: the chat's own rules first, then App
    // Assistant's, then the reply's instructions and what its subagents are told.
    const system = buildSystemPrompt({
      now: new Date(),
      tools: offered,
      host: { tools: tools.hostTools ?? [], instructs: true },
      ...(tools.rules ? { rules: tools.rules } : {}),
    });
    const prompt = `${system}\n${tools.instructions}\n${assistantSubagentInstructions('remote')}`;
    const named = new Set<string>();
    for (const name of KNOWN) if (new RegExp(`\\b${name}\\b`).test(prompt)) named.add(name);
    for (const match of prompt.matchAll(/\bsandbox__([a-z_]+)(\*)?/g))
      named.add(match[2] ? `sandbox__${match[1]}*` : `sandbox__${match[1]}`);
    expect(named.size).toBeGreaterThan(5);
    const missing = [...named].filter((name) =>
      name.endsWith('*')
        ? !offered.some((tool) => tool.startsWith(name.slice(0, -1)))
        : !offered.includes(name)
    );
    expect(missing).toEqual([]);
  });

  it('the chat’s own rules do name ask_choice (the control: the check reads them)', () => {
    expect(buildSystemPrompt({ now: new Date(), tools: ['sandbox__read_file'] })).toMatch(
      /\bask_choice\b/
    );
  });

  it('the page’s prompt does name tools the runner lacks (the control)', async () => {
    const { buildAssistantSystemPromptWithSubagents, buildAssistantInstructions } = await import(
      '@civitai/app-assistant'
    );
    const page = `${buildAssistantSystemPromptWithSubagents('')}\n${buildAssistantInstructions({
      sandbox: { name: 's', app: 'my-app', state: 'running' },
      apps: [],
      canPreview: true,
      previewHost: null,
    })}`;
    expect(page).toMatch(/sandbox__tunnel_\*/);
  });
});

describe('what the page is told of a call', () => {
  it('carries a command and a result’s first lines, never a file’s contents', async () => {
    fake.add('my-app');
    const { tools, reported } = await open();
    const content = 'SECRET-LOOKING-BUT-TEST-ONLY '.repeat(50);
    await call(tools.tools, 'sandbox__write_file', { path: 'a', content });
    await call(tools.tools, 'sandbox__run_command', run('cd my-app && npm test'));
    expect(JSON.stringify(reported[0])).not.toContain('SECRET-LOOKING');
    expect(reported[0]).toMatchObject({ name: 'sandbox__write_file', input: {}, isError: false });
    expect(reported[1]).toMatchObject({
      input: { command: 'cd my-app && npm test' },
      output: expect.stringMatching(/^exit_code: 0/),
    });
    expect((reported[1].output as string).length).toBeLessThanOrEqual(200);
  });
});

describe('the kept-apps limit, as the page is told of it', () => {
  it('a create_app refused at the cap reaches the page as the limit, in this reply and the next call', async () => {
    fake.add('my-app');
    fake.add('second-app', 'suspended');
    fake.add('third-app', 'suspended');
    fake.keepLimit = 3;
    const { tools, reported } = await open();
    const before = opensApps().length;
    await call(tools.tools, 'create_app', { name: 'Fourth app' }).catch(() => undefined);
    await call(tools.tools, 'create_app', { name: 'Fourth app' }).catch(() => undefined);
    const creates = reported.filter((r) => r.name === 'create_app');
    expect(creates).toHaveLength(2);
    expect(creates.map(isKeepLimitResult)).toEqual([true, true]);
    // The cap was asked once; the second call was refused by the gate.
    expect(opensApps().length - before).toBe(1);
  });

  it('NEGATIVE CONTROL: under the cap, create_app is not reported as the limit', async () => {
    fake.add('my-app');
    fake.keepLimit = 3;
    const { tools, reported } = await open();
    await call(tools.tools, 'create_app', { name: 'Fourth app' });
    const creates = reported.filter((r) => r.name === 'create_app');
    expect(creates).toHaveLength(1);
    expect(creates[0].isError).toBe(false);
    expect(isKeepLimitResult(creates[0])).toBe(false);
  });
});

/** A chat changes only an app it made (create_app) or chose (use_open_app). */
describe('a new chat beside an open app', () => {
  const OPEN = 'buzz-dashboard';
  const CHANGES: readonly (readonly [string, Record<string, unknown>])[] = [
    ['sandbox__delete_path', { path: `${OPEN}/src/block.ts` }],
    ['sandbox__write_file', { path: `${OPEN}/src/block.ts`, content: 'explorer' }],
    ['sandbox__edit_file', { path: `${OPEN}/block.manifest.json`, old: 'a', new: 'b' }],
    ['sandbox__run_command', run(`cd ${OPEN} && rm -rf src`)],
    ['sandbox__dev_server_restart', {}],
    ['sandbox__dev_server_start', { command: `cd ${OPEN} && npm run dev` }],
  ];
  const MUTATING = new Set(CHANGES.map(([name]) => name.replace('sandbox__', '')));
  /** The calls that changed (or could have changed) the open app, as its sandbox saw them. */
  const changesTo = (sandbox: string) =>
    fake.calls.filter((c) => c.sandbox === sandbox && MUTATING.has(c.tool));
  const checklistShown = () =>
    messagesOf([
      [
        'set_checklist',
        { items: [{ label: 'A search box' }, { label: 'A type filter' }] },
        { shown: true, awaitsUser: true, checklist: 'c-1', app: OPEN },
      ],
    ]);

  it('Build it after a checklist for another app changes nothing in the open app, and the new app is made instead', async () => {
    const dashboard = fake.add(OPEN);
    const { tools, reported } = await open({
      conversationId: 'conv-new',
      page: { app: OPEN },
      history: { earlier: checklistShown(), current: [] },
    });
    expect(await call(tools.tools, 'sandbox__list_dir', { path: OPEN })).toBe('src/');
    for (const [name, input] of CHANGES)
      expect(await call(tools.tools, name, input), name).toMatchObject({
        error: openAppNotChosen(OPEN),
      });
    expect(changesTo(dashboard.name)).toEqual([]);
    expect(reported.filter((r) => r.refused === openAppNotChosen(OPEN))).toHaveLength(
      CHANGES.length
    );

    expect(await call(tools.tools, 'create_app', { name: 'LoRA explorer' })).toMatchObject({
      app: 'lora-explorer',
    });
    expect(fake.sandboxes.map((s) => s.app).sort()).toEqual([OPEN, 'lora-explorer']);
    expect(changesTo(dashboard.name)).toEqual([]);
  });

  it('a new chat with no history at all is refused the same', async () => {
    const dashboard = fake.add(OPEN);
    const { tools } = await open({
      conversationId: 'conv-new',
      page: { app: OPEN },
      history: NEW_CHAT,
    });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toMatchObject({ error: openAppNotChosen(OPEN) });
    expect(changesTo(dashboard.name)).toEqual([]);
    // A test or typecheck run changes nothing, so it runs (and is the only call that reached it).
    await call(tools.tools, 'sandbox__run_command', run(`cd ${OPEN} && npm test`));
    expect(changesTo(dashboard.name)).toEqual([
      { sandbox: dashboard.name, tool: 'run_command', args: run(`cd ${OPEN} && npm test`) },
    ]);
  });

  it('a follow-up in the chat that made the app still changes it (not over-fixed)', async () => {
    const dashboard = fake.add(OPEN);
    const earlier = messagesOf([
      ['create_app', { name: 'Buzz dashboard' }, { app: OPEN, state: 'starting', note: 'n' }],
    ]);
    const { tools } = await open({ page: { app: OPEN }, history: { earlier, current: [] } });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toBe('wrote 1 bytes');
    expect(changesTo(dashboard.name)).toHaveLength(1);
  });

  it('once the user asks to change the open app, use_open_app chooses it and the change runs', async () => {
    const dashboard = fake.add(OPEN);
    const { tools } = await open({ page: { app: OPEN }, history: NEW_CHAT });
    expect(await call(tools.tools, 'use_open_app', { app: 'lora-explorer' })).toMatchObject({
      error: expect.stringMatching(/open now is buzz-dashboard/),
    });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toMatchObject({ error: openAppNotChosen(OPEN) });
    expect(await call(tools.tools, 'use_open_app', { app: OPEN })).toMatchObject({ app: OPEN });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toBe('wrote 1 bytes');
    expect(changesTo(dashboard.name)).toHaveLength(1);
  });

  it('what a chat chose was another app: the app the user switched to is not changed', async () => {
    const dashboard = fake.add(OPEN);
    const { tools } = await open({ page: { app: OPEN }, history: chosenApp('my-app') });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toMatchObject({ error: openAppNotChosen(OPEN) });
    expect(changesTo(dashboard.name)).toEqual([]);
  });

  it('at the kept-apps limit: the user is told, and the open app is neither chosen nor changed in its place', async () => {
    const dashboard = fake.add(OPEN);
    fake.add('second-app', 'suspended');
    fake.add('third-app', 'suspended');
    fake.keepLimit = 3;
    const { tools, reported } = await open({ page: { app: OPEN }, history: NEW_CHAT });
    await expect(call(tools.tools, 'create_app', { name: 'LoRA explorer' })).resolves.toMatchObject(
      { error: KEEP_LIMIT }
    );
    // The page shows its free-a-slot card for it.
    expect(isKeepLimitResult(reported.find((r) => r.name === 'create_app')!)).toBe(true);
    expect(await call(tools.tools, 'use_open_app', { app: OPEN })).toMatchObject({
      error: NEW_APP_FAILED_KEEP_OPEN,
    });
    expect(
      await call(tools.tools, 'sandbox__write_file', { path: `${OPEN}/a.ts`, content: 'x' })
    ).toMatchObject({ error: openAppNotChosen(OPEN) });
    expect(changesTo(dashboard.name)).toEqual([]);
    expect(fake.sandboxes.map((s) => s.app)).not.toContain('lora-explorer');
  });
});

describe('the page state the runner reads', () => {
  it('takes a string and nothing else; the lookup among the user’s own apps decides the rest', () => {
    expect(readPageState({ app: 'my-app' })).toEqual({ app: 'my-app' });
    expect(readPageState({ app: '../x' })).toEqual({ app: '../x' });
    for (const app of ['', 42, null, { a: 1 }, 'x'.repeat(201)])
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
