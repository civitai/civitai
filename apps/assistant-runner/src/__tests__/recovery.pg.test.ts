import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TurnPart } from '@civitai/components-chat/core';
import { applyRunEvent } from '@civitai/components-chat/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signGrant, testKeys } from '../test-support/keys';
import { freshDatabase, TEST_DATABASE_URL } from '../core/test-support/pg';
import { readEvents } from '../core/test-support/sse';

const describePg = TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.CI && !TEST_DATABASE_URL)
  throw new Error('ASSISTANT_RUNNER_TEST_DATABASE_URL is not set in CI');

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('../test-support/fixture-server.ts', import.meta.url));
// TEST-ONLY keys: the runners verify the grants this file signs with them.
const keys = testKeys();

interface Child {
  process: ChildProcess;
  port: number;
  output: () => string;
}

/** A runner process on `databaseUrl` under `executorId`; resolves once it listens. */
function startRunner(
  databaseUrl: string,
  executorId: string,
  dir: string,
  env: Record<string, string> = {}
): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: appDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUNNER_EXECUTOR_ID: executorId,
        FIXTURE_DIR: dir,
        FIXTURE_PUBLIC_KEY: keys.publicPem,
        NODE_ENV: 'test',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`runner did not start:\n${output}`)), 45_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /READY (\d+)/.exec(output);
      if (ready) {
        clearTimeout(timer);
        resolve({ process: child, port: Number(ready[1]), output: () => output });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`runner exited (${code}) before it was ready:\n${output}`));
    });
  });
}

async function until<T>(what: string, probe: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describePg('crash recovery', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let dir: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    db = await freshDatabase('recovery');
    dir = mkdtempSync(join(tmpdir(), 'assistant-runner-recovery-'));
  });

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a runner killed after saving the reply’s end but before journaling it does not run the reply again', async () => {
    const endDir = mkdtempSync(join(tmpdir(), 'assistant-runner-end-'));
    const children2: Child[] = [];
    try {
      const calls = () =>
        existsSync(join(endDir, 'calls.log'))
          ? readFileSync(join(endDir, 'calls.log'), 'utf8').trim().split('\n')
          : [];
      const headers = { authorization: 'Bearer user:u-end', 'content-type': 'application/json' };
      const grant = await signGrant(keys, {
        userId: 'u-end',
        conversationId: 'c-end',
        idempotencyKey: 'end-1',
      });
      const first = await startRunner(db.url, 'executor-end', endDir, {
        FIXTURE_SCRIPT: 'short',
        FIXTURE_HOLD_AFTER_END: '1',
      });
      children.push(first.process);
      children2.push(first);
      const start = await fetch(`http://127.0.0.1:${first.port}/runs`, {
        method: 'POST',
        headers: { ...headers, 'x-run-grant': grant },
        body: JSON.stringify({
          v: 1,
          idempotencyKey: 'end-1',
          conversationId: 'c-end',
          turn: { seq: 1, user: { content: 'Do it once.', attachments: [] } },
          model: 'scripted',
          settings: {
            maxOutputTokens: 1024,
            tier: 'auto',
            allowMature: false,
            autoRunLimit: 0,
            spokenReplies: false,
          },
        }),
      });
      expect(start.status).toBe(201);
      const { runId } = (await start.json()) as { runId: string };
      // The store holds the run right after it saved the end: killed in that window.
      const headFile = join(endDir, 'heads', 'u-end--c-end.json');
      await until('the reply’s end to be saved', () =>
        existsSync(headFile) && readFileSync(headFile, 'utf8').includes('"status":"done"')
          ? true
          : undefined
      );
      first.process.kill('SIGKILL');
      await new Promise((resolve) => first.process.once('exit', resolve));
      expect(calls().map((line) => line.split(' ')[0])).toEqual(['record']);

      const second = await startRunner(db.url, 'executor-end', endDir, { FIXTURE_SCRIPT: 'short' });
      children.push(second.process);
      children2.push(second);
      const entries = await readEvents(
        `http://127.0.0.1:${second.port}/runs/${runId}/events`,
        { authorization: headers.authorization },
        { timeoutMs: 45_000 }
      );
      expect(entries.filter(({ event }) => event.type === 'run-ended')).toHaveLength(1);
      expect(entries.at(-1)!.event).toMatchObject({ type: 'run-ended', status: 'done' });
      // The model was not asked again, so the tool did not run again.
      expect(calls().map((line) => line.split(' ')[0])).toEqual(['record']);
      expect(readFileSync(headFile, 'utf8')).toContain('"status":"done"');
      const exited = new Promise((resolve) => second.process.once('exit', resolve));
      second.process.kill('SIGTERM');
      await exited;
    } catch (error) {
      const output = children2
        .map((child, index) => `\n[runner ${index}]\n${child.output()}`)
        .join('');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${output}`);
    } finally {
      // A runner left alive would dequeue the next test's run.
      for (const child of children2) {
        if (child.process.exitCode !== null || child.process.signalCode !== null) continue;
        const exited = new Promise((resolve) => child.process.once('exit', resolve));
        child.process.kill('SIGKILL');
        await exited;
      }
      rmSync(endDir, { recursive: true, force: true });
    }
  }, 240_000);

  it('a runner killed mid-tool is recovered under the same executor id, and no tool that ran runs again', async () => {
    let first: Child | undefined;
    let second: Child | undefined;
    try {
      ({ first, second } = await crashAndRecover((child) => {
        if (!first) first = child;
        else second = child;
      }));
    } catch (error) {
      // The runners' own output is the only record of why a recovery did not happen.
      const output = `\n[first runner]\n${first?.output() ?? ''}\n[second runner]\n${
        second?.output() ?? ''
      }`;
      throw new Error(`${error instanceof Error ? error.message : String(error)}${output}`);
    }
  }, 240_000);

  async function crashAndRecover(
    started: (child: Child) => void
  ): Promise<{ first: Child; second: Child }> {
    const headers = { authorization: 'Bearer user:u-crash', 'content-type': 'application/json' };
    const grant = await signGrant(keys, {
      userId: 'u-crash',
      conversationId: 'c-crash',
      idempotencyKey: 'crash-1',
    });
    const grantLookups = () =>
      existsSync(join(dir, 'grants.log'))
        ? readFileSync(join(dir, 'grants.log'), 'utf8').trim().split('\n')
        : [];
    const calls = () =>
      existsSync(join(dir, 'calls.log'))
        ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
        : [];

    const first = await startRunner(db.url, 'executor-a', dir);
    children.push(first.process);
    started(first);
    const start = await fetch(`http://127.0.0.1:${first.port}/runs`, {
      method: 'POST',
      headers: { ...headers, 'x-run-grant': grant },
      body: JSON.stringify({
        v: 1,
        idempotencyKey: 'crash-1',
        conversationId: 'c-crash',
        turn: { seq: 1, user: { content: 'Build it.', attachments: [] } },
        model: 'scripted',
        settings: {
          maxOutputTokens: 1024,
          tier: 'auto',
          allowMature: false,
          autoRunLimit: 0,
          spokenReplies: false,
        },
      }),
    });
    expect(start.status).toBe(201);
    const { runId } = (await start.json()) as { runId: string };

    // Killed while the second tool runs, once its start is saved with the reply's progress.
    await until('the slow tool to start', () =>
      calls().some((line) => line.startsWith('slow ')) ? true : undefined
    );
    const headFile = join(dir, 'heads', `u-crash--c-crash.json`);
    await until('the slow call to be saved', () =>
      existsSync(headFile) && readFileSync(headFile, 'utf8').includes('"toolName":"slow"')
        ? true
        : undefined
    );
    first.process.kill('SIGKILL');
    await new Promise((resolve) => first.process.once('exit', resolve));
    expect(calls().map((line) => line.split(' ')[0])).toEqual(['record', 'slow']);

    const second = await startRunner(db.url, 'executor-a', dir);
    children.push(second.process);
    started(second);
    const entries = await readEvents(
      `http://127.0.0.1:${second.port}/runs/${runId}/events`,
      { authorization: headers.authorization },
      { timeoutMs: 45_000 }
    );
    const last = entries.at(-1)!.event;
    expect(last).toMatchObject({ type: 'run-ended', status: 'done' });

    // Neither the finished tool nor the interrupted one ran in the second process.
    expect(calls().map((line) => line.split(' ')[0])).toEqual(['record', 'slow']);
    expect(new Set(calls().map((line) => line.split(' ')[1])).size).toBe(1);

    // One journal across both processes, and a client reading it from the start rebuilds a consistent reply.
    expect(entries.map((entry) => entry.id)).toEqual(entries.map((_, index) => index));
    expect(entries.filter(({ event }) => event.type === 'run-started')).toHaveLength(1);
    const parts: TurnPart[] = [];
    for (const { event } of entries) expect(applyRunEvent(parts, event)).toBe(true);
    expect(parts.find((part) => part.kind === 'tool' && part.toolName === 'slow')).toMatchObject({
      state: 'error',
    });
    expect(parts.at(-1)).toEqual({ kind: 'text', text: 'All done.' });

    // The recovered run still had its grant to mint with: it lives in the runner's table, not in
    // the process that died. Every model request in both processes found it.
    const lookups = grantLookups();
    expect(new Set(lookups.map((line) => line.split(' ')[1])).size).toBe(2);
    expect(lookups.every((line) => line.startsWith('present '))).toBe(true);

    const exited = new Promise((resolve) => second.process.once('exit', resolve));
    second.process.kill('SIGTERM');
    await exited;
    return { first, second };
  }
});
