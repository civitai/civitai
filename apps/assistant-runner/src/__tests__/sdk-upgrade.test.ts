import { readFileSync } from 'node:fs';

import { DEV_SERVER_COMMAND, REMOTE_PREVIEW } from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppAssistantTools } from '../app-assistant/provider';
import type { OpenTools, ToolContext } from '../interfaces';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * The SDK the host speaks, as the repo root pins it: the oracle for "current", read from the
 * repo's own manifest rather than from the code under test.
 */
const ROOT = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as { dependencies: Record<string, string> };
const CURRENT = ROOT.dependencies['@civitai/sdk']!;
const CURRENT_VERSION = CURRENT.slice(1);
const CURRENT_MINOR = CURRENT_VERSION.split('.').slice(0, 2).join('.');
/** What daily-challenge declared when measured live (web 5.1.373): below the current minor. */
const STALE = '^0.19.1';

/** The one install the runner runs, in the app key's own project directory. */
const INSTALL = 'cd my-app && npm install --no-audit --no-fund';
const INSTALLED = 'my-app/node_modules/@civitai/sdk/package.json';
/** The words the reply is told to start with after an upgrade. */
const USER_LINE = `Updated this app's Civitai SDK to ${CURRENT_MINOR} so the preview stays awake while you use it.`;

let fake: FakeSandboxService;
let logs: { level: string; object: object; message: string | undefined }[];
let opened: OpenTools[];
let reported: ChatToolResult[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  logs = [];
  opened = [];
  reported = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

const log = {
  info: (object: object, message?: string) => logs.push({ level: 'info', object, message }),
  warn: (object: object, message?: string) => logs.push({ level: 'warn', object, message }),
  error: (object: object, message?: string) => logs.push({ level: 'error', object, message }),
};

function provider(
  options: {
    sdkPinReadTimeoutMs?: number;
    sdkUpgradeTimeoutMs?: number;
    wakeTimeoutMs?: number;
  } = {}
) {
  return new AppAssistantTools({
    sandboxUrl: fake.url,
    // TEST-ONLY stand-in for a minted token: never a real credential.
    tokens: () => async (purpose) => `test-token-${purpose}`,
    log,
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
    ...options,
  } as ConstructorParameters<typeof AppAssistantTools>[0]);
}

async function open(tools: AppAssistantTools, overrides: Partial<ToolContext> = {}) {
  const stop = new AbortController();
  const result = await tools.open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    signal: stop.signal,
    report: (result) => reported.push(result),
    ...overrides,
  });
  opened.push(result);
  return result;
}

/** A file as `sandbox__read_file` answers it: JSON with its text in `content`. */
const fileOf = (path: unknown, content: string) =>
  JSON.stringify({
    path,
    size: Buffer.byteLength(content, 'utf8'),
    offset: 0,
    truncated: false,
    content,
  });

/** A `sandbox__run_command` answer, as sandbox-mcp writes its header. */
const ran = (exitCode: number, output = '') =>
  `exit_code: ${exitCode}\ntimed_out: false\nduration_ms: 10\noutput_bytes: ${output.length}\n---\n${output}`;

/** A 4-space package.json with a trailing newline, the SDK among `dependencies`. */
const pkg4 = (range: string) =>
  '{\n' +
  '    "name": "my-app",\n' +
  '    "private": true,\n' +
  '    "scripts": {\n' +
  '        "dev": "vite"\n' +
  '    },\n' +
  '    "dependencies": {\n' +
  '        "@civitai/components": "^0.13.0",\n' +
  `        "@civitai/sdk": "${range}",\n` +
  '        "react": "^19.1.0"\n' +
  '    }\n' +
  '}\n';

/** A tab-indented package.json with no trailing newline, the SDK among `devDependencies`. */
const pkgTabs = (range: string) =>
  '{\n' +
  '\t"name": "my-app",\n' +
  '\t"devDependencies": {\n' +
  `\t\t"@civitai/sdk": "${range}",\n` +
  '\t\t"vite": "^8.0.0"\n' +
  '\t}\n' +
  '}';

interface AppState {
  /** `my-app/package.json`'s text. */
  pkg: string;
  /** The installed SDK's version, `null` when none is installed. */
  installed: string | null;
  devRunning: boolean;
  devCommand: string | null;
  /** Every text written to `my-app/package.json`, in order. */
  writes: string[];
}

/**
 * A stateful app in the fake sandbox: its `package.json` is read and written through the file
 * tools, an install puts the SDK the declared range starts at into `node_modules` (`install` may
 * answer otherwise), and the dev server runs until stopped.
 */
function app(
  initial: { pkg: string; installed?: string | null; devRunning?: boolean },
  install?: (call: number, signal: AbortSignal) => Promise<string> | string
): AppState {
  const state: AppState = {
    pkg: initial.pkg,
    installed: initial.installed === undefined ? '0.19.1' : initial.installed,
    devRunning: initial.devRunning ?? true,
    devCommand: initial.devRunning === false ? null : `cd my-app && ${DEV_SERVER_COMMAND}`,
    writes: [],
  };
  let installs = 0;
  fake.tools.set('read_file', (args) => {
    if (args.path === 'my-app/package.json') return fileOf(args.path, state.pkg);
    if (args.path === INSTALLED) {
      if (state.installed === null) throw new Error('ENOENT: no such file');
      return fileOf(args.path, JSON.stringify({ name: '@civitai/sdk', version: state.installed }));
    }
    if (args.path === 'my-app/block.manifest.json')
      return fileOf(args.path, JSON.stringify({ blockId: 'my-app' }));
    return 'export {}';
  });
  fake.tools.set('write_file', (args) => {
    if (args.path === 'my-app/package.json') {
      state.pkg = String(args.content);
      state.writes.push(state.pkg);
    }
    return JSON.stringify({ path: args.path, bytesWritten: String(args.content).length });
  });
  fake.tools.set('run_command', async (args, signal) => {
    if (args.command !== INSTALL) return ran(0);
    installs++;
    if (install) return install(installs, signal);
    const range = JSON.parse(state.pkg) as Record<string, Record<string, string>>;
    const declared =
      range.dependencies?.['@civitai/sdk'] ?? range.devDependencies?.['@civitai/sdk'];
    state.installed = String(declared).replace(/^[\^~]/, '');
    return ran(0, 'added 1 package');
  });
  const status = () =>
    JSON.stringify({ running: state.devRunning, command: state.devCommand, lastExit: null });
  fake.tools.set('dev_server_status', status);
  fake.tools.set('dev_server_stop', () => {
    state.devRunning = false;
    return JSON.stringify({ stopped: true });
  });
  fake.tools.set('dev_server_start', (args) => {
    state.devRunning = true;
    state.devCommand = String(args.command);
    return status();
  });
  return state;
}

/** The tools the runner called, in order, without its reads and its port probes. */
const actions = () =>
  fake.calls
    .filter(
      (call) =>
        !['read_file', 'dev_server_status'].includes(call.tool) &&
        !(call.tool === 'run_command' && call.args.command !== INSTALL)
    )
    .map((call) =>
      call.tool === 'run_command'
        ? `run_command ${String(call.args.command)}`
        : call.tool === 'dev_server_start'
        ? `dev_server_start ${String(call.args.command)}`
        : call.tool
    );

const installCount = () =>
  fake.calls.filter((call) => call.tool === 'run_command' && call.args.command === INSTALL).length;

/** Nothing about the SDK in the turn's instructions: no line to tell the user, no steps to take. */
function expectNoSdkWords(instructions: string | undefined) {
  expect(instructions).toContain(REMOTE_PREVIEW);
  expect(instructions).not.toContain('@civitai/sdk');
  expect(instructions).not.toContain('Civitai SDK');
}

const failed = () => logs.filter((l) => /@civitai\/sdk upgrade failed/.test(l.message ?? ''));

describe('the runner upgrades an app on an old @civitai/sdk itself', () => {
  it('the oracle is a ^0.x range (what the upgrade writes)', () => {
    expect(CURRENT).toMatch(/^\^0\.\d+\.\d+$/);
    expect(STALE).not.toBe(CURRENT);
  });

  it('a stale pin: only that range is rewritten, npm install runs, the running dev server restarts, and the reply tells the user', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const tools = await open(provider());

    // Byte for byte the same file but for the one range.
    expect(state.writes).toEqual([pkg4(STALE).replace(`"${STALE}"`, `"${CURRENT}"`)]);
    expect(state.pkg).toBe(pkg4(CURRENT));
    expect(state.installed).toBe(CURRENT_VERSION);
    expect(actions()).toEqual([
      'write_file',
      `run_command ${INSTALL}`,
      'dev_server_stop',
      `dev_server_start cd my-app && ${DEV_SERVER_COMMAND}`,
    ]);
    expect(state.devRunning).toBe(true);
    // The install has a bound of its own in the sandbox.
    const install = fake.calls.find((c) => c.args.command === INSTALL)!;
    expect(typeof install.args.timeout_ms).toBe('number');

    // One line for the user; no steps for the assistant to take again.
    expect(tools.instructions).toContain(USER_LINE);
    expect(tools.instructions).not.toContain(`Run ${INSTALL}`);
    expect(tools.instructions).not.toContain('npm install');
    expect(tools.instructions).toContain(REMOTE_PREVIEW);
    // The page's gate hears of the install, as of any command that changed files.
    expect(reported).toContainEqual(
      expect.objectContaining({
        name: 'sandbox__run_command',
        input: { command: INSTALL },
        isError: false,
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'info', message: '@civitai/sdk upgraded' })
    );
    expect(failed()).toEqual([]);
  });

  it('a tab-indented package.json with the SDK among devDependencies and no final newline keeps all of that', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkgTabs('~0.20.3') });
    await open(provider());
    expect(state.writes).toEqual([pkgTabs(CURRENT)]);
    expect(installCount()).toBe(1);
  });

  it('a dev server that was not running is not started', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE), devRunning: false });
    const tools = await open(provider());
    expect(state.pkg).toBe(pkg4(CURRENT));
    expect(actions()).toEqual(['write_file', `run_command ${INSTALL}`]);
    expect(tools.instructions).toContain(USER_LINE);
  });

  it('a current range with an older SDK still installed is installed again, package.json untouched', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4('^0.22.0'), installed: '0.19.1' });
    await open(provider());
    expect(state.writes).toEqual([]);
    expect(installCount()).toBe(1);
    expect(state.installed).toBe('0.22.0');
  });

  it('a current pin with a current SDK installed makes no change at all', async () => {
    fake.add('my-app');
    const [major, minor] = CURRENT_VERSION.split('.').map(Number) as [number, number];
    for (const range of [
      CURRENT,
      CURRENT_VERSION,
      `~${CURRENT_VERSION}`,
      `^${major}.${minor + 1}.0`,
    ]) {
      fake.calls.length = 0;
      app({ pkg: pkg4(range), installed: CURRENT_VERSION });
      const tools = await open(provider());
      expectNoSdkWords(tools.instructions);
      expect(
        fake.calls.filter((c) => c.tool !== 'read_file' && c.tool !== 'dev_server_status'),
        range
      ).toEqual([]);
    }
  });
});

describe('a failed upgrade puts package.json back', () => {
  it('npm install failing: package.json is restored byte for byte, installed again, no restart, and logged', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) }, (call) =>
      call === 1 ? ran(1, 'npm ERR! code ETARGET') : ran(0, 'up to date')
    );
    const tools = await open(provider());

    expect(state.pkg).toBe(pkg4(STALE));
    expect(state.writes).toEqual([pkg4(CURRENT), pkg4(STALE)]);
    expect(actions()).toEqual([
      'write_file',
      `run_command ${INSTALL}`,
      'write_file',
      `run_command ${INSTALL}`,
    ]);
    expect(state.devRunning).toBe(true);
    expect(failed()).toEqual([
      expect.objectContaining({
        level: 'warn',
        object: expect.objectContaining({ stage: 'install', rolledBack: true }),
      }),
    ]);
    // The reply goes on, with nothing said about an upgrade that did not happen.
    expectNoSdkWords(tools.instructions);
    expect(Object.keys(tools.tools)).toContain('sandbox__read_file');
  });

  it('an install that reports success but leaves the old SDK installed is rolled back too', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) }, () => ran(0, 'up to date'));
    const tools = await open(provider());
    expect(state.pkg).toBe(pkg4(STALE));
    expect(installCount()).toBe(2);
    expect(failed()).toEqual([
      expect.objectContaining({ object: expect.objectContaining({ stage: 'verify' }) }),
    ]);
    expectNoSdkWords(tools.instructions);
  });

  it('an install past the upgrade’s time budget is abandoned and rolled back', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) }, (call, signal) =>
      call === 1
        ? new Promise<string>((resolve) =>
            signal.addEventListener('abort', () => resolve(ran(137, 'killed')))
          )
        : ran(0, 'up to date')
    );
    const started = Date.now();
    const tools = await open(provider({ sdkUpgradeTimeoutMs: 300 }));
    // Well under the default budget: an upgrade that ignored the option would wait that out.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.pkg).toBe(pkg4(STALE));
    expect(state.writes).toEqual([pkg4(CURRENT), pkg4(STALE)]);
    expect(installCount()).toBe(2);
    expect(failed()).toEqual([
      expect.objectContaining({ object: expect.objectContaining({ reason: 'timeout' }) }),
    ]);
    expectNoSdkWords(tools.instructions);
  });

  it('a dev server that does not come back after the upgrade rolls it back and starts the old one', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    let starts = 0;
    fake.tools.set('dev_server_start', (args) => {
      starts++;
      state.devCommand = String(args.command);
      state.devRunning = starts > 1;
      return JSON.stringify({
        running: state.devRunning,
        command: state.devCommand,
        lastExit: state.devRunning ? null : { code: 1 },
      });
    });
    const tools = await open(provider());
    expect(state.pkg).toBe(pkg4(STALE));
    expect(state.installed).toBe('0.19.1');
    expect(starts).toBe(2);
    expect(state.devRunning).toBe(true);
    expect(failed()).toEqual([
      expect.objectContaining({ object: expect.objectContaining({ stage: 'restart' }) }),
    ]);
    expectNoSdkWords(tools.instructions);
  });

  it('a failed upgrade is tried once more in a later reply, then no more for that pin', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) }, (call) =>
      call % 2 === 1 ? ran(1, 'npm ERR!') : ran(0, 'up to date')
    );
    const tools = provider();
    await open(tools);
    expect(installCount()).toBe(2);
    await open(tools, { runId: 'run-2' });
    expect(installCount()).toBe(4);
    await open(tools, { runId: 'run-3' });
    await open(tools, { runId: 'run-4' });
    expect(installCount()).toBe(4);
    expect(state.pkg).toBe(pkg4(STALE));
  });
});

describe('when the runner cannot upgrade, it changes nothing', () => {
  it('a sandbox that lists no exec tool: no write, no install, and a log line', async () => {
    fake.add('my-app');
    fake.hiddenTools.add('run_command');
    const state = app({ pkg: pkg4(STALE) });
    const tools = await open(provider());
    expect(state.writes).toEqual([]);
    expect(fake.calls.filter((c) => c.tool !== 'read_file')).toEqual([]);
    expectNoSdkWords(tools.instructions);
    expect(logs.some((l) => /@civitai\/sdk not upgraded/.test(l.message ?? ''))).toBe(true);
  });

  it('a package.json whose layout would not survive a rewrite is left as it is', async () => {
    fake.add('my-app');
    const inline = `{ "name": "my-app", "dependencies": { "@civitai/sdk": "${STALE}" } }\n`;
    const state = app({ pkg: inline });
    await open(provider());
    expect(state.writes).toEqual([]);
    expect(installCount()).toBe(0);
    expect(logs.some((l) => /@civitai\/sdk not upgraded/.test(l.message ?? ''))).toBe(true);
  });

  it('an app without @civitai/sdk gets nothing', async () => {
    fake.add('my-app');
    const state = app({
      pkg: JSON.stringify({ name: 'my-app', dependencies: { vite: '^8.0.0' } }),
    });
    expectNoSdkWords((await open(provider())).instructions);
    expect(state.writes).toEqual([]);
    expect(installCount()).toBe(0);
  });

  it('an unreadable package.json opens the tools with no change and no throw, and says so in the log', async () => {
    fake.add('my-app');
    app({ pkg: pkg4(STALE) });
    fake.tools.set('read_file', () => {
      throw new Error('ENOENT: no such file');
    });
    const tools = await open(provider());
    expectNoSdkWords(tools.instructions);
    expect(Object.keys(tools.tools)).toContain('sandbox__read_file');
    expect(fake.callsTo('write_file')).toBe(0);
    expect(logs.some((l) => /package\.json/.test(l.message ?? ''))).toBe(true);
  });

  it('a package.json that is not JSON, or a range it cannot read, gets no change, and says so in the log', async () => {
    fake.add('my-app');
    for (const content of [
      'not json {',
      pkg4('latest'),
      pkg4('workspace:*'),
      pkg4('>=0.10.0'),
      pkg4('github:civitai/sdk'),
      JSON.stringify({ dependencies: { '@civitai/sdk': 19 } }),
    ]) {
      logs = [];
      const state = app({ pkg: content });
      const tools = await open(provider());
      expectNoSdkWords(tools.instructions);
      expect(state.writes, content).toEqual([]);
      expect(
        logs.some((l) => /@civitai\/sdk|package\.json/.test(l.message ?? '')),
        content
      ).toBe(true);
    }
    expect(installCount()).toBe(0);
  });

  it('a package.json read that never answers does not hold the turn', async () => {
    fake.add('my-app');
    app({ pkg: pkg4(STALE) });
    fake.tools.set('read_file', (args, signal) =>
      args.path === 'my-app/package.json'
        ? new Promise<string>((resolve) =>
            signal.addEventListener('abort', () => resolve('aborted'))
          )
        : 'export {}'
    );
    const started = Date.now();
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200 }));
    expect(Date.now() - started).toBeLessThan(2_500);
    expectNoSdkWords(tools.instructions);
    expect(fake.callsTo('write_file')).toBe(0);
  });

  it('a sandbox that never answers MCP initialize does not hold the turn past its tools’ own wait', async () => {
    fake.add('my-app');
    fake.hangInitialize = true;
    app({ pkg: pkg4(STALE) });
    const started = Date.now();
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200 }));
    // The tools' list gives up at 15 s (LIST_TIMEOUT_MS); the check adds at most its own bound.
    expect(Date.now() - started).toBeLessThan(18_000);
    expectNoSdkWords(tools.instructions);
    expect(fake.callsTo('read_file')).toBe(0);
  }, 90_000);

  it('a paused app that does not wake is not read, and opens as before', async () => {
    fake.add('my-app', 'suspended');
    fake.startsAfter = Infinity;
    app({ pkg: pkg4(STALE) });
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200, wakeTimeoutMs: 200 }), {}).catch(
      () => null
    );
    if (tools) expectNoSdkWords(tools.instructions);
    expect(fake.callsTo('read_file')).toBe(0);
  });
});

describe('after an upgrade there is nothing left to do', () => {
  it('the next reply finds the current pin and changes nothing', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const tools = provider();
    expect((await open(tools)).instructions).toContain(USER_LINE);
    expectNoSdkWords((await open(tools, { runId: 'run-2' })).instructions);
    expect(state.writes).toHaveLength(1);
    expect(installCount()).toBe(1);
  });

  it('a new stale pin, in another conversation, gets its own upgrade', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const tools = provider();
    await open(tools);
    state.pkg = pkg4('^0.18.0');
    state.installed = '0.18.0';
    expect(
      (await open(tools, { runId: 'run-2', conversationId: 'conv-2' })).instructions
    ).toContain(USER_LINE);
    expect(installCount()).toBe(2);
  });
});
