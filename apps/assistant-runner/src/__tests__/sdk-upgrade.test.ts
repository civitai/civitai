import { readFileSync } from 'node:fs';

import { DEV_SERVER_COMMAND, REMOTE_PREVIEW } from '@civitai/app-assistant';
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
/** What daily-challenge declared when measured live (web 5.1.373): below the current minor. */
const STALE = '^0.19.1';

let fake: FakeSandboxService;
let logs: { level: string; object: object; message: string | undefined }[];
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  logs = [];
  opened = [];
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

function provider(options: { sdkPinReadTimeoutMs?: number; wakeTimeoutMs?: number } = {}) {
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
    ...overrides,
  });
  opened.push(result);
  return result;
}

const INSTALLED = 'my-app/node_modules/@civitai/sdk/package.json';

/** A file as `sandbox__read_file` answers it: JSON with its text in `content`. */
const fileOf = (path: unknown, content: string) =>
  JSON.stringify({ path, size: content.length, content });

/**
 * The app's `package.json`, and, when `installed` gives a version, the installed SDK's own
 * `package.json` under `node_modules` (otherwise that read fails, as for a missing file).
 */
function appPackage(content: () => string, installed: () => string | null = () => null) {
  fake.tools.set('read_file', (args) => {
    if (args.path === 'my-app/package.json') return fileOf(args.path, content());
    if (args.path === INSTALLED) {
      const version = installed();
      if (version === null) throw new Error('ENOENT: no such file');
      return fileOf(args.path, JSON.stringify({ name: '@civitai/sdk', version }));
    }
    return 'export {}';
  });
}

const pkg = (range: string, field: 'dependencies' | 'devDependencies' = 'dependencies') =>
  JSON.stringify({
    name: 'my-app',
    [field]: { '@civitai/components': '^0.13.0', '@civitai/sdk': range },
  });

/** Every part of the nudge the assistant needs to act on, for the app's own project directory. */
function expectNudge(instructions: string | undefined, declared: string) {
  expect(instructions).toContain(`"@civitai/sdk": "${declared}"`);
  expect(instructions).toContain(`"@civitai/sdk": "${CURRENT}"`);
  expect(instructions).toContain('cd my-app && npm install');
  expect(instructions).toContain(`cd my-app && ${DEV_SERVER_COMMAND}`);
  // The turn's own instructions are still all there.
  expect(instructions).toContain(REMOTE_PREVIEW);
}

/** No nudge: nothing about the SDK or an install in the turn's instructions. */
function expectNoNudge(instructions: string | undefined) {
  expect(instructions).toContain(REMOTE_PREVIEW);
  expect(instructions).not.toContain('@civitai/sdk');
  // The turn's own instructions say `cd <blockId> && npm install`; the nudge names the project.
  expect(instructions).not.toContain('cd my-app && npm install');
}

describe('the runner nudges an app on an old @civitai/sdk to upgrade', () => {
  it('the oracle is a ^0.x range (what the nudge would bump to)', () => {
    expect(CURRENT).toMatch(/^\^0\.\d+\.\d+$/);
  });

  it('a stale pin gets the nudge: bump to the current range, install, restart the dev server', async () => {
    fake.add('my-app');
    appPackage(() => pkg(STALE));
    const tools = await open(provider());
    expectNudge(tools.instructions, STALE);
    // Read with the sandbox's own file tool, in the app key's project directory.
    expect(fake.calls).toContainEqual({
      sandbox: 'sb-my-app-1',
      tool: 'read_file',
      args: { path: 'my-app/package.json' },
    });
  });

  it('a stale pin among devDependencies, or a tilde or exact one, gets it too', async () => {
    fake.add('my-app');
    for (const [range, field] of [
      ['~0.20.3', 'devDependencies'],
      ['0.19.1', 'dependencies'],
      ['^0.1.0', 'dependencies'],
    ] as const) {
      appPackage(() => pkg(range, field));
      const tools = await open(provider());
      expectNudge(tools.instructions, range);
    }
  });

  it('a current pin, or a newer one, gets none', async () => {
    fake.add('my-app');
    const [major, minor] = CURRENT.slice(1).split('.').map(Number) as [number, number];
    for (const range of [
      CURRENT,
      CURRENT.slice(1),
      `~${CURRENT.slice(1)}`,
      `^${major}.${minor + 1}.0`,
      `^${major + 1}.0.0`,
    ]) {
      appPackage(() => pkg(range));
      const tools = await open(provider());
      expectNoNudge(tools.instructions);
    }
  });

  it('an app without @civitai/sdk gets none', async () => {
    fake.add('my-app');
    appPackage(() => JSON.stringify({ name: 'my-app', dependencies: { vite: '^8.0.0' } }));
    expectNoNudge((await open(provider())).instructions);
  });

  it('an unreadable package.json opens the tools with no nudge and no throw, and says so in the log', async () => {
    fake.add('my-app');
    fake.tools.set('read_file', () => {
      throw new Error('ENOENT: no such file');
    });
    const tools = await open(provider());
    expectNoNudge(tools.instructions);
    expect(Object.keys(tools.tools)).toContain('sandbox__read_file');
    expect(logs.some((l) => /package\.json/.test(l.message ?? ''))).toBe(true);
  });

  it('a package.json that is not JSON, or a range it cannot read, gets none, and says so in the log', async () => {
    fake.add('my-app');
    for (const content of [
      'not json {',
      pkg('latest'),
      pkg('workspace:*'),
      pkg('>=0.10.0'),
      pkg('github:civitai/sdk'),
      JSON.stringify({ dependencies: { '@civitai/sdk': 19 } }),
    ]) {
      logs = [];
      appPackage(() => content);
      const tools = await open(provider());
      expectNoNudge(tools.instructions);
      expect(
        logs.some((l) => /@civitai\/sdk|package\.json/.test(l.message ?? '')),
        content
      ).toBe(true);
    }
  });

  it('a package.json read that never answers does not hold the turn', async () => {
    fake.add('my-app');
    fake.tools.set('read_file', (args, signal) =>
      args.path === 'my-app/package.json'
        ? new Promise<string>((resolve) =>
            signal.addEventListener('abort', () => resolve('aborted'))
          )
        : 'export {}'
    );
    const started = Date.now();
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200 }));
    // Well under the 5 s default: a check that ignored the option would wait that out.
    expect(Date.now() - started).toBeLessThan(2_500);
    expectNoNudge(tools.instructions);
  });

  it('a sandbox that never answers MCP initialize does not hold the turn past its tools’ own wait', async () => {
    fake.add('my-app');
    fake.hangInitialize = true;
    appPackage(() => pkg(STALE));
    const started = Date.now();
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200 }));
    // The tools' list gives up at 15 s (LIST_TIMEOUT_MS); the pin check adds at most its own bound,
    // never MCP initialize's 60 s.
    expect(Date.now() - started).toBeLessThan(18_000);
    expectNoNudge(tools.instructions);
    expect(fake.callsTo('read_file')).toBe(0);
  }, 90_000);

  it('a paused app that does not wake is not read, and opens as before', async () => {
    fake.add('my-app', 'suspended');
    fake.startsAfter = Infinity;
    appPackage(() => pkg(STALE));
    const tools = await open(provider({ sdkPinReadTimeoutMs: 200, wakeTimeoutMs: 200 }), {}).catch(
      () => null
    );
    if (tools) expectNoNudge(tools.instructions);
    expect(fake.callsTo('read_file')).toBe(0);
  });
});

describe('the installed @civitai/sdk counts too', () => {
  it('a current range with an older SDK still installed (an install that did not finish) gets the nudge', async () => {
    fake.add('my-app');
    appPackage(
      () => pkg(CURRENT),
      () => '0.19.1'
    );
    const tools = await open(provider());
    expectNudge(tools.instructions, CURRENT);
    expect(tools.instructions).toContain('0.19.1');
    expect(fake.calls).toContainEqual({
      sandbox: 'sb-my-app-1',
      tool: 'read_file',
      args: { path: INSTALLED },
    });
  });

  it('a current range with the current SDK installed gets none', async () => {
    fake.add('my-app');
    appPackage(
      () => pkg(CURRENT),
      () => CURRENT.slice(1)
    );
    expectNoNudge((await open(provider())).instructions);
  });

  it('a still-stale install after a nudged turn is told again, once per change', async () => {
    fake.add('my-app');
    let range = STALE;
    let installed = '0.19.1';
    appPackage(
      () => pkg(range),
      () => installed
    );
    const tools = provider();
    expectNudge((await open(tools)).instructions, STALE);
    // package.json was bumped but npm install did not finish: told again, once.
    range = CURRENT;
    expectNudge((await open(tools, { runId: 'run-2' })).instructions, CURRENT);
    expectNoNudge((await open(tools, { runId: 'run-3' })).instructions);
    installed = CURRENT.slice(1);
    expectNoNudge((await open(tools, { runId: 'run-4' })).instructions);
  });
});

describe('the nudge fires once per app per conversation, or until the pin changes', () => {
  it('a second reply with the same stale pin gets none', async () => {
    fake.add('my-app');
    appPackage(() => pkg(STALE));
    const tools = provider();
    expectNudge((await open(tools)).instructions, STALE);
    expectNoNudge((await open(tools, { runId: 'run-2' })).instructions);
    expectNoNudge((await open(tools, { runId: 'run-3' })).instructions);
  });

  it('a changed pin that is still stale gets it again, once', async () => {
    fake.add('my-app');
    let range = STALE;
    appPackage(() => pkg(range));
    const tools = provider();
    expectNudge((await open(tools)).instructions, STALE);
    range = '^0.20.0';
    expectNudge((await open(tools, { runId: 'run-2' })).instructions, '^0.20.0');
    expectNoNudge((await open(tools, { runId: 'run-3' })).instructions);
  });

  it('after the upgrade there is none', async () => {
    fake.add('my-app');
    let range = STALE;
    appPackage(() => pkg(range));
    const tools = provider();
    expectNudge((await open(tools)).instructions, STALE);
    range = CURRENT;
    expectNoNudge((await open(tools, { runId: 'run-2' })).instructions);
  });

  it('another conversation about the same app gets its own one nudge', async () => {
    fake.add('my-app');
    appPackage(() => pkg(STALE));
    const tools = provider();
    expectNudge((await open(tools)).instructions, STALE);
    expectNudge(
      (await open(tools, { runId: 'run-2', conversationId: 'conv-2' })).instructions,
      STALE
    );
    expectNoNudge((await open(tools, { runId: 'run-3', conversationId: 'conv-2' })).instructions);
  });
});
