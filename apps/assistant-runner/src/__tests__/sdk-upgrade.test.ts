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
  /** `my-app/package-lock.json`'s text, `null` when there is none. */
  lock: string | null;
  /** The installed SDK's version, `null` when none is installed. */
  installed: string | null;
  devRunning: boolean;
  devCommand: string | null;
  /** Every text written to `my-app/package.json`, in order. */
  writes: string[];
  /** How many installs ran at once, at most. */
  maxConcurrentInstalls: number;
  /** Each install's start and end, in order of starting. */
  installSpans: { start: number; end?: number }[];
}

/** The lockfile an install leaves for a declared range (what the fake's npm writes). */
const lockFor = (range: string) => `{\n  "lockfileVersion": 3,\n  "sdk": "${range}"\n}\n`;
/** The app's own lockfile before any upgrade: not one the fake's npm would write. */
const ORIGINAL_LOCK = '{\n  "lockfileVersion": 2,\n  "sdk": "resolved-by-hand"\n}\n';

/**
 * A stateful app in the fake sandbox: its `package.json` and `package-lock.json` are read and
 * written through the file tools, an install puts the SDK the declared range starts at into
 * `node_modules` and rewrites the lockfile (`install` may answer otherwise), and the dev server runs
 * until stopped.
 */
function app(
  initial: { pkg: string; installed?: string | null; devRunning?: boolean; lock?: string | null },
  install?: (call: number, signal: AbortSignal) => Promise<string> | string
): AppState {
  const state: AppState = {
    pkg: initial.pkg,
    lock: initial.lock === undefined ? ORIGINAL_LOCK : initial.lock,
    installed: initial.installed === undefined ? '0.19.1' : initial.installed,
    devRunning: initial.devRunning ?? true,
    devCommand: initial.devRunning === false ? null : `cd my-app && ${DEV_SERVER_COMMAND}`,
    writes: [],
    maxConcurrentInstalls: 0,
    installSpans: [],
  };
  let installs = 0;
  let running = 0;
  fake.tools.set('read_file', (args) => {
    if (args.path === 'my-app/package.json') return fileOf(args.path, state.pkg);
    if (args.path === 'my-app/package-lock.json') {
      if (state.lock === null) throw new Error('ENOENT: no such file');
      return fileOf(args.path, state.lock);
    }
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
    if (args.path === 'my-app/package-lock.json') state.lock = String(args.content);
    return JSON.stringify({ path: args.path, bytesWritten: String(args.content).length });
  });
  fake.tools.set('run_command', async (args, signal) => {
    const command = String(args.command);
    if (command === 'cd my-app && rm -f package-lock.json') {
      state.lock = null;
      return ran(0);
    }
    if (command.includes('[ -e package-lock.json ]'))
      return ran(0, state.lock === null ? 'absent\n' : 'present\n');
    if (command !== INSTALL) return ran(0);
    installs++;
    running++;
    state.maxConcurrentInstalls = Math.max(state.maxConcurrentInstalls, running);
    const span: { start: number; end?: number } = { start: Date.now() };
    state.installSpans.push(span);
    try {
      if (install) return await install(installs, signal);
      const parsed = JSON.parse(state.pkg) as Record<string, Record<string, string>>;
      const declared = String(
        parsed.dependencies?.['@civitai/sdk'] ?? parsed.devDependencies?.['@civitai/sdk']
      );
      // A kept lockfile wins, as npm keeps a locked version that still satisfies the range.
      const locked = state.lock === ORIGINAL_LOCK && declared === STALE;
      state.installed = locked ? '0.19.1' : declared.replace(/^[\^~]/, '');
      if (!locked) state.lock = lockFor(declared);
      return ran(0, 'added 1 package');
    } finally {
      running--;
      span.end = Date.now();
    }
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
  fake.tools.set('dev_server_restart', () => {
    state.devRunning = true;
    return status();
  });
  return state;
}

/** The tools the runner called, in order, without its reads, its looks and its port probes. */
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
          : call.tool === 'write_file'
            ? `write_file ${String(call.args.path)}`
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
      'write_file my-app/package.json',
      `run_command ${INSTALL}`,
      'dev_server_stop',
      `dev_server_start cd my-app && ${DEV_SERVER_COMMAND}`,
    ]);
    expect(state.devRunning).toBe(true);
    expect(state.lock).toBe(lockFor(CURRENT));
    // The install has a bound of its own in the sandbox: it kills the install, and answers, past it.
    const install = fake.calls.find((c) => c.args.command === INSTALL)!;
    expect(install.args.timeout_ms).toBe(90_000);

    // One line for the user; no steps for the assistant to take again.
    expect(tools.instructions).toContain(USER_LINE);
    // (The turn's own instructions say `cd <blockId> && npm install`; the upgrade names no step.)
    expect(tools.instructions).not.toContain('cd my-app && npm install');
    expect(tools.instructions).not.toContain('SDK upgrade, before the rest of this reply');
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
    expect(actions()).toEqual(['write_file my-app/package.json', `run_command ${INSTALL}`]);
    expect(tools.instructions).toContain(USER_LINE);
  });

  it('a dev server started some other way is restarted with its own command', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    state.devCommand = 'npm --prefix my-app run dev';
    const tools = await open(provider());
    expect(state.pkg).toBe(pkg4(CURRENT));
    expect(actions()).toEqual([
      'write_file my-app/package.json',
      `run_command ${INSTALL}`,
      'dev_server_restart',
    ]);
    expect(fake.calls.find((c) => c.tool === 'dev_server_restart')!.args).toEqual({});
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
      'write_file my-app/package.json',
      `run_command ${INSTALL}`,
      'write_file my-app/package.json',
      'write_file my-app/package-lock.json',
      `run_command ${INSTALL}`,
    ]);
    expect(state.lock).toBe(ORIGINAL_LOCK);
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

  it('an install that ends past the budget is rolled back once it answered, never beside it', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) }, async (call) => {
      if (call === 1) {
        // Slower than the budget, and it does finish: cutting it off would not stop it in the sandbox.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        state.installed = CURRENT_VERSION;
        state.lock = lockFor(CURRENT);
        return ran(0, 'added 1 package');
      }
      state.installed = state.lock === ORIGINAL_LOCK ? '0.19.1' : 'wrong';
      return ran(0, 'up to date');
    });
    const tools = await open(provider({ sdkUpgradeTimeoutMs: 800 }));
    expect(state.installSpans).toHaveLength(2);
    // The rollback's install began only after the upgrade's had answered.
    expect(state.installSpans[1]!.start).toBeGreaterThanOrEqual(state.installSpans[0]!.end!);
    expect(state.maxConcurrentInstalls).toBe(1);
    expect(state.pkg).toBe(pkg4(STALE));
    expect(state.writes).toEqual([pkg4(CURRENT), pkg4(STALE)]);
    expect(state.lock).toBe(ORIGINAL_LOCK);
    expect(state.installed).toBe('0.19.1');
    // No restart: the budget ran out before it.
    expect(fake.callsTo('dev_server_stop')).toBe(0);
    expect(failed()).toEqual([
      expect.objectContaining({
        object: expect.objectContaining({ stage: 'install', reason: 'timeout', rolledBack: true }),
      }),
    ]);
    expectNoSdkWords(tools.instructions);
  });

  it('an app with no lockfile has none again after a rollback', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE), lock: null }, (call) => {
      // Every npm install writes a lockfile, failed or not.
      state.lock = lockFor('written-by-npm');
      return call === 1 ? ran(1, 'npm ERR!') : ran(0, 'up to date');
    });
    await open(provider());
    expect(installCount()).toBe(2);
    expect(state.pkg).toBe(pkg4(STALE));
    expect(state.lock).toBeNull();
    expect(failed()).toEqual([
      expect.objectContaining({ object: expect.objectContaining({ rolledBack: true }) }),
    ]);
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
    expect(state.lock).toBe(ORIGINAL_LOCK);
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

describe('one upgrade at a time, and never for a stopped run', () => {
  it('two replies opening the same app at once install once, one after the other', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const tools = provider();
    const [first, second] = await Promise.all([
      open(tools),
      open(tools, { runId: 'run-2', conversationId: 'conv-2' }),
    ]);
    expect(state.maxConcurrentInstalls).toBe(1);
    // The second found the pin current once the first was done.
    expect(installCount()).toBe(1);
    expect(state.writes).toEqual([pkg4(CURRENT)]);
    expect(
      [first.instructions, second.instructions].filter((i) => i?.includes(USER_LINE))
    ).toHaveLength(1);
  });

  it('a run already stopped changes nothing', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const stopped = new AbortController();
    stopped.abort();
    await open(provider(), { signal: stopped.signal }).catch(() => null);
    expect(state.writes).toEqual([]);
    expect(installCount()).toBe(0);
  });
});

describe('when the runner cannot upgrade, it changes nothing', () => {
  it('a lockfile it cannot keep whole: no write, no install', async () => {
    fake.add('my-app');
    const state = app({ pkg: pkg4(STALE) });
    const read = fake.tools.get('read_file')!;
    fake.tools.set('read_file', (args, signal) =>
      args.path === 'my-app/package-lock.json'
        ? JSON.stringify({ path: args.path, size: 5_000_000, truncated: true, content: '{' })
        : read(args, signal)
    );
    await open(provider());
    expect(state.writes).toEqual([]);
    expect(installCount()).toBe(0);
    expect(failed()).toEqual([
      expect.objectContaining({ object: expect.objectContaining({ stage: 'backup' }) }),
    ]);
  });

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
