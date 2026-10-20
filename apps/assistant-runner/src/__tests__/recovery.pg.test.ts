import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TurnPart } from '@civitai/components-chat/core';
import { applyRunEvent } from '@civitai/components-chat/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { freshDatabase, TEST_DATABASE_URL } from '../test-support/pg';
import { readEvents } from '../test-support/sse';

const describePg = TEST_DATABASE_URL ? describe : describe.skip;

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const fixture = fileURLToPath(new URL('../test-support/fixture-server.ts', import.meta.url));

interface Child {
  process: ChildProcess;
  port: number;
  output: () => string;
}

/** A runner process on `databaseUrl` under `executorId`; resolves once it listens. */
function startRunner(databaseUrl: string, executorId: string, dir: string): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: appDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        RUNNER_EXECUTOR_ID: executorId,
        FIXTURE_DIR: dir,
        NODE_ENV: 'test',
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

  it('a runner killed mid-tool is recovered under the same executor id, and no tool that ran runs again', async () => {
    const headers = { authorization: 'Bearer user:u-crash', 'content-type': 'application/json' };
    const calls = () =>
      existsSync(join(dir, 'calls.log'))
        ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
        : [];

    const first = await startRunner(db.url, 'executor-a', dir);
    children.push(first.process);
    const start = await fetch(`http://127.0.0.1:${first.port}/runs`, {
      method: 'POST',
      headers,
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

    second.process.kill('SIGTERM');
  });
});
