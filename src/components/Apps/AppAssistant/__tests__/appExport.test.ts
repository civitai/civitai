import { describe, expect, it, vi } from 'vitest';
import {
  AppExportError,
  EXPORT_FAILED,
  EXPORT_GONE,
  EXPORT_NOTE,
  EXPORT_TOO_LARGE,
  exportAppZip,
  exportFileName,
  waitUntilRunning,
} from '~/components/Apps/AppAssistant/appExport';
import type { Sandbox, SandboxClient } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';

const sandbox = (state: Sandbox['state'], name = 'sbx-tipcalc0001'): Sandbox => ({
  name,
  app: 'tip-calculator',
  state,
  mcpUrl: `https://sandbox.example/s/${name}/mcp`,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastActivityAt: '2026-10-05T00:00:00.000Z',
  expiresAt: null,
});

const refused = (status: number) =>
  new SandboxApiError(
    `export refused (${status})`,
    status,
    status === 413 ? 'bad_request' : 'conflict'
  );

function setup({
  states = ['running'] as Sandbox['state'][],
  exports = [] as (number | 'ok')[],
  startFails = false,
  startCreates = false,
} = {}) {
  const events: string[] = [];
  const zip = new Blob(['PK-zip-bytes'], { type: 'application/zip' });
  const client = {
    get: vi.fn(async (name: string) => {
      const state = states.length > 1 ? states.shift()! : states[0];
      events.push(`get ${name} ${state}`);
      return sandbox(state, name);
    }),
    exportApp: vi.fn(async (name: string, app: string) => {
      events.push(`export ${name} ${app}`);
      const next = exports.shift() ?? 'ok';
      if (next !== 'ok') throw refused(next);
      return zip;
    }),
  } as unknown as SandboxClient;
  const start = vi.fn(async (target: Sandbox) => {
    events.push(`start ${target.app}`);
    if (startFails) throw new SandboxApiError('busy', 409, 'conflict');
    // The listed app was gone: the service made a new, empty one under the same key.
    if (startCreates) return { sandbox: sandbox('starting', 'sbx-tipcalc0002'), created: true };
    return { sandbox: { ...target, state: 'starting' as const }, created: false };
  });
  const discard = vi.fn(async (name: string) => {
    events.push(`discard ${name}`);
  });
  const run = (target: Sandbox) =>
    exportAppZip({ client, sandbox: target, start, discard, pollMs: 1, timeoutMs: 200 });
  return { client, start, discard, events, zip, run };
}

describe('exportAppZip', () => {
  it('downloads a running app’s zip at once, starting nothing', async () => {
    const { run, start, events, zip } = setup();
    expect(await run(sandbox('running'))).toBe(zip);
    expect(start).not.toHaveBeenCalled();
    expect(events).toEqual(['export sbx-tipcalc0001 tip-calculator']);
  });

  it('starts a paused app first, waits until it runs, then downloads', async () => {
    const { run, events, zip } = setup({ states: ['starting', 'starting', 'running'] });
    expect(await run(sandbox('suspended'))).toBe(zip);
    expect(events).toEqual([
      'start tip-calculator',
      'get sbx-tipcalc0001 starting',
      'get sbx-tipcalc0001 starting',
      'get sbx-tipcalc0001 running',
      'export sbx-tipcalc0001 tip-calculator',
    ]);
  });

  it('a 413 is “too large”, and is not retried', async () => {
    const { run, start, client } = setup({ exports: [413] });
    const error = await run(sandbox('running')).catch((e) => e);
    expect(error).toBeInstanceOf(AppExportError);
    expect(error).toMatchObject({ kind: 'too_large', message: 'This app is too large to export.' });
    expect(start).not.toHaveBeenCalled();
    expect(client.exportApp).toHaveBeenCalledTimes(1);
  });

  it('a 409 (not running) starts the app once and tries again', async () => {
    const { run, events, zip } = setup({ exports: [409, 'ok'] });
    expect(await run(sandbox('running'))).toBe(zip);
    expect(events).toEqual([
      'export sbx-tipcalc0001 tip-calculator',
      'start tip-calculator',
      'get sbx-tipcalc0001 running',
      'export sbx-tipcalc0001 tip-calculator',
    ]);
  });

  it('a second 409 gives up: one restart only', async () => {
    const { run, start, client } = setup({ exports: [409, 409, 'ok'] });
    const error = await run(sandbox('running')).catch((e) => e);
    expect(error).toMatchObject({
      kind: 'failed',
      message: 'The app could not be exported. Try again in a moment.',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(client.exportApp).toHaveBeenCalledTimes(2);
  });

  it('any other failure is the generic error, with no restart', async () => {
    const { run, start } = setup({ exports: [500] });
    const error = await run(sandbox('running')).catch((e) => e);
    expect(error).toMatchObject({ kind: 'failed', message: EXPORT_FAILED });
    expect(start).not.toHaveBeenCalled();
  });

  it('a start that made a new, empty app (the listed one is gone) is “gone”: that app is deleted, nothing exported', async () => {
    const { run, events, client } = setup({ startCreates: true });
    const error = await run(sandbox('suspended')).catch((e) => e);
    expect(error).toMatchObject({
      kind: 'gone',
      message: 'This app no longer exists, so there is nothing to export.',
    });
    expect(events).toEqual(['start tip-calculator', 'discard sbx-tipcalc0002']);
    expect(client.exportApp).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a start that found the app deletes nothing', async () => {
    const { run, discard } = setup();
    await run(sandbox('suspended'));
    expect(discard).not.toHaveBeenCalled();
  });

  it('a start that fails is the generic error, and nothing is downloaded', async () => {
    const { run, client } = setup({ startFails: true });
    const error = await run(sandbox('suspended')).catch((e) => e);
    expect(error).toMatchObject({ kind: 'failed', message: EXPORT_FAILED });
    expect(client.exportApp).not.toHaveBeenCalled();
  });
});

describe('waitUntilRunning', () => {
  it('gives up after its timeout when the app never runs', async () => {
    const { client } = setup({ states: ['starting'] });
    await expect(
      waitUntilRunning(client, 'sbx-tipcalc0001', { pollMs: 1, timeoutMs: 20 })
    ).rejects.toThrow();
    expect((client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });
});

describe('the export copy', () => {
  it('pins the words the user reads', () => {
    expect(exportFileName('tip-calculator')).toBe('tip-calculator.zip');
    expect(EXPORT_TOO_LARGE).toBe('This app is too large to export.');
    expect(EXPORT_FAILED).toBe('The app could not be exported. Try again in a moment.');
    expect(EXPORT_GONE).toBe('This app no longer exists, so there is nothing to export.');
    expect(EXPORT_NOTE).toBe(
      'It has the app’s own files only: no node_modules, build output, caches, logs, .git, keys or .env files (.env.example is kept).'
    );
  });
});
