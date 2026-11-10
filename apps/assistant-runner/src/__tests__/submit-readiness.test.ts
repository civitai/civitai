import { readFileSync } from 'node:fs';

import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppAssistantTools } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * What the runner's submit_for_review checks before it offers the Submit for review button: an app
 * civitai would refuse, or one about to change under the offer, is not offered.
 */

const ROOT = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as { dependencies: Record<string, string> };
const CURRENT = ROOT.dependencies['@civitai/sdk']!;
const CURRENT_MINOR = CURRENT.slice(1).split('.').slice(0, 2).join('.');
/** What `civitai app create`'s page template pins: below the host's SDK. */
const SCAFFOLD_PIN = '^0.19.0';
const INSTALL = 'cd my-app && npm install --no-audit --no-fund';

let fake: FakeSandboxService;
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  await fake.start();
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function open() {
  const tools = await new AppAssistantTools({
    sandboxUrl: fake.url,
    // TEST-ONLY stand-in for a minted token: never a real credential.
    tokens: () => async (purpose) => `test-token-${purpose}`,
    log: quiet,
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
  }).open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    history: chosenApp('my-app'),
    signal: new AbortController().signal,
  });
  opened.push(tools);
  return tools.tools;
}

let callId = 0;
function call(tools: ToolSet, name: string, input: Record<string, unknown> = {}) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: `t-${++callId}`, messages: [] } as never)
  ) as Promise<Record<string, unknown>>;
}

async function passChecks(tools: ToolSet) {
  await call(tools, 'set_checklist', { items: [{ label: 'Portrait maker', done: true }] });
  await call(tools, 'sandbox__preview_check');
  await call(tools, 'sandbox__run_command', { command: 'cd my-app && npm test' });
  await call(tools, 'sandbox__run_command', { command: 'cd my-app && npx tsc --noEmit' });
}

/** A file as `sandbox__read_file` answers it. */
const fileOf = (path: unknown, content: string) =>
  JSON.stringify({ path, size: Buffer.byteLength(content), truncated: false, content });

/** The open app's files, as `sandbox__read_file` reads them; `null` is a file that is not there. */
function files(read: (path: string) => string | null) {
  fake.tools.set('read_file', (args) => {
    const content = read(String(args.path));
    if (content === null) throw new Error('ENOENT: no such file');
    return fileOf(args.path, content);
  });
}

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ blockId: 'my-app', name: 'Portrait maker', version: '0.1.0', ...extra });

describe('a sensitive scope without a justification is caught before submit', () => {
  const REPORT_READY_REFUSAL =
    'Not ready yet. block.manifest.json asks for ai:write:budgeted, which Civitai accepts only with a reason: add to it "scopeJustifications": { "ai:write:budgeted": "<why the app needs it, in one plain sentence>" }, and tell the user in one sentence what you wrote. Then run the preview check, the tests and the typecheck again, and call report_ready again.';

  it('report_ready refuses an app whose manifest asks for ai:write:budgeted with no reason', async () => {
    fake.add('my-app');
    files((path) =>
      path === 'my-app/block.manifest.json' ? manifest({ scopes: ['ai:write:budgeted'] }) : null
    );
    const tools = await open();
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({
      error: REPORT_READY_REFUSAL,
    });
    expect(await call(tools, 'submit_for_review')).toMatchObject({
      error: expect.stringMatching(/^Not ready yet\. Call report_ready first/),
    });
  });

  it('submit_for_review refuses it too, when the manifest lost its reason after report_ready', async () => {
    fake.add('my-app');
    let current = manifest({
      scopes: ['ai:write:budgeted', 'buzz:read:self'],
      scopeJustifications: { 'ai:write:budgeted': 'Generates portraits.', 'buzz:read:self': 'x' },
    });
    files((path) => (path === 'my-app/block.manifest.json' ? current : null));
    const tools = await open();
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({ ready: true });
    // Changed behind the gate's back (nothing the gate hears of): the submit reads it again.
    current = manifest({
      scopes: ['ai:write:budgeted', 'buzz:read:self'],
      scopeJustifications: { 'ai:write:budgeted': ' ' },
    });
    expect(await call(tools, 'submit_for_review')).toMatchObject({
      error:
        'Not ready yet. block.manifest.json asks for ai:write:budgeted, buzz:read:self, which Civitai accepts only with a reason: add to it "scopeJustifications": { "ai:write:budgeted": "<why the app needs it, in one plain sentence>" }, with an entry for each of them, and tell the user in one sentence what you wrote. Then run the preview check, the tests and the typecheck again, and call submit_for_review again.',
    });
  });

  it('a justified sensitive scope, or a scope that is not sensitive, is offered', async () => {
    fake.add('my-app');
    files((path) =>
      path === 'my-app/block.manifest.json'
        ? manifest({
            scopes: ['ai:write:budgeted', 'models:read:self'],
            scopeJustifications: { 'ai:write:budgeted': 'Generates the portrait you ask for.' },
          })
        : null
    );
    const tools = await open();
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({ ready: true });
    expect(await call(tools, 'submit_for_review')).toMatchObject({ awaitsUser: true });
  });
});

/**
 * An app the reply has not scaffolded yet as it opens (no package.json for the runner to read):
 * `scaffold()` writes what `civitai app create` pins. Every install answers `installExit`; one that
 * exits 0 installs the range package.json declares. `steps` records each install and each answer.
 */
async function scaffoldedDuringReply({ installExit = 0 }: { installExit?: number } = {}) {
  fake.add('my-app');
  const app = {
    pkg: null as string | null,
    installed: null as string | null,
    steps: [] as string[],
  };
  files((path) => {
    if (path === 'my-app/block.manifest.json') return manifest();
    if (path === 'my-app/package.json') return app.pkg;
    if (path === 'my-app/node_modules/@civitai/sdk/package.json')
      return app.installed === null
        ? null
        : JSON.stringify({ name: '@civitai/sdk', version: app.installed });
    return null;
  });
  fake.tools.set('write_file', (args) => {
    if (args.path === 'my-app/package.json') app.pkg = String(args.content);
    return JSON.stringify({ path: args.path });
  });
  fake.tools.set('run_command', (args) => {
    const command = String(args.command);
    if (command === INSTALL) {
      app.steps.push('install');
      if (installExit === 0) {
        const declared = /"@civitai\/sdk": "([^"]+)"/.exec(app.pkg ?? '')?.[1] ?? '';
        app.installed = declared.replace(/^[\^~]/, '');
      }
      return `exit_code: ${installExit}\ntimed_out: false\n---\n`;
    }
    // No lockfile in this app: the upgrade keeps that it had none.
    const output = command.includes('[ -e package-lock.json ]') ? 'absent\n' : '';
    return `exit_code: 0\ntimed_out: false\n---\n${output}`;
  });
  fake.tools.set('dev_server_status', () => JSON.stringify({ running: false }));
  const tools = await open();
  const scaffold = () => {
    app.pkg = `{\n  "name": "my-app",\n  "dependencies": {\n    "@civitai/sdk": "${SCAFFOLD_PIN}"\n  }\n}\n`;
    app.installed = SCAFFOLD_PIN.slice(1);
  };
  return { tools, app, scaffold };
}

describe('an SDK upgrade lands before the submit offer, never after it', () => {
  it('an app scaffolded during the reply is upgraded at submit_for_review, which then waits for the checks again', async () => {
    const { tools, app, scaffold } = await scaffoldedDuringReply();
    expect(app.steps).toEqual([]);

    // The reply scaffolds the app (the template pins an older SDK) and checks it.
    scaffold();
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({ ready: true });

    const first = await call(tools, 'submit_for_review');
    app.steps.push('submit answered');
    expect(first).toMatchObject({
      error: `Not submitted yet: the runner just updated this app's Civitai SDK to ${CURRENT} and reinstalled its packages, so the app changed after its checks. Tell the user in one line: Updated this app's Civitai SDK to ${CURRENT_MINOR} so the preview stays awake while you use it. Then run the preview check, the tests and the typecheck again, call report_ready, and call submit_for_review again.`,
    });
    expect(app.steps).toEqual(['install', 'submit answered']);
    expect(app.pkg).toContain(`"@civitai/sdk": "${CURRENT}"`);

    // The install changed the app: it is checked again before it is offered, and not upgraded again.
    expect(await call(tools, 'submit_for_review')).toMatchObject({
      error: expect.stringMatching(/sandbox__preview_check: it has not run/),
    });
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({ ready: true });
    expect(await call(tools, 'submit_for_review')).toMatchObject({ awaitsUser: true });
    expect(app.steps.filter((step) => step === 'install')).toHaveLength(1);
  });

  it('an upgrade that fails after changing the app withholds the offer too: the rolled-back app is checked again', async () => {
    const { tools, app, scaffold } = await scaffoldedDuringReply({ installExit: 1 });
    scaffold();
    const scaffolded = app.pkg;
    await passChecks(tools);
    expect(await call(tools, 'report_ready', { data: 'civitai' })).toMatchObject({ ready: true });

    const first = await call(tools, 'submit_for_review');
    app.steps.push('submit answered');
    expect(first).toMatchObject({
      error: `Not submitted yet: the runner tried to update this app's Civitai SDK to ${CURRENT} and it failed, so it put the app's packages back; the app changed after its checks all the same. Do not tell the user about the SDK. Run the preview check, the tests and the typecheck again, call report_ready, and call submit_for_review again.`,
    });
    expect(first).not.toHaveProperty('awaitsUser');
    // It installed (the upgrade's, then the rollback's) before it answered, and put package.json back.
    expect(app.steps).toEqual(['install', 'install', 'submit answered']);
    expect(app.pkg).toBe(scaffolded);
    // Those installs reached the gate: the next submit waits for the checks.
    expect(await call(tools, 'submit_for_review')).toMatchObject({
      error: expect.stringMatching(/sandbox__preview_check: it has not run/),
    });
  });
});
