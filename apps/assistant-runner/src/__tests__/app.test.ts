import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { RunEvent, StartRunRequest } from '@civitai/components-chat/runner-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, lastEventId, loggerOptions } from '../app';
import type { JournalEntry, RunService, StartOutcome } from '../service';
import { bearerAuthenticator } from '../test-support/fakes';
import { readEvents } from '../test-support/sse';

const startRequest: StartRunRequest = {
  v: 1,
  idempotencyKey: 'key-1',
  conversationId: 'c1',
  turn: { seq: 1, user: { content: 'hi', attachments: [] } },
  model: 'm',
  settings: {
    maxOutputTokens: 100,
    tier: 'auto',
    allowMature: false,
    autoRunLimit: 0,
    spokenReplies: false,
  },
};

function fakeService(overrides: Partial<RunService> = {}) {
  const seen: { method: string; userId: string; args: unknown[] }[] = [];
  const note =
    (method: string) =>
    (userId: string, ...args: unknown[]) =>
      seen.push({ method, userId, args });
  const service: RunService = {
    start: async (userId, request) => {
      note('start')(userId, request);
      return {
        ok: true,
        response: {
          v: 1,
          runId: 'r1',
          conversationId: request.conversationId,
          seq: request.turn.seq,
        },
      } satisfies StartOutcome;
    },
    lookup: async (userId, conversationId) => {
      note('lookup')(userId, conversationId);
      return null;
    },
    owns: async (userId, runId) => userId === 'u1' && runId === 'r1',
    events: async function* (runId, after): AsyncIterable<JournalEntry> {
      note('events')('', runId, after);
      const journal: RunEvent[] = [
        {
          type: 'run-started',
          v: 1,
          runId,
          conversationId: 'c1',
          seq: 1,
          user: { content: 'hi', attachments: [] },
          parts: [],
        },
        { type: 'text-delta', index: 0, text: 'Hello' },
        { type: 'run-ended', status: 'done', messages: [], steps: 1 },
      ];
      for (let id = after === undefined ? 0 : after + 1; id < journal.length; id++)
        yield { id, event: journal[id]! };
    },
    stop: async (userId, runId) => {
      note('stop')(userId, runId);
      return runId === 'r1';
    },
    stopByKey: async (userId, key) => {
      note('stopByKey')(userId, key);
    },
    patch: async (userId, conversationId, patch) => {
      note('patch')(userId, conversationId, patch);
      return conversationId === 'c1';
    },
    ready: () => true,
    ...overrides,
  };
  return { service, seen };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(options: Parameters<typeof buildApp>[0]): Promise<string> {
  app = buildApp(options);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const user1 = { authorization: 'Bearer user:u1' };

describe('the run API', () => {
  const routes: [string, string, unknown?][] = [
    ['POST', '/runs', startRequest],
    ['GET', '/runs?conversationId=c1'],
    ['GET', '/runs/r1/events'],
    ['POST', '/runs/r1/stop', { v: 1 }],
    ['POST', '/runs/stop', { v: 1, idempotencyKey: 'k', conversationId: 'c1' }],
    ['POST', '/conversations/c1/patch', { v: 1, title: 't' }],
  ];

  it('refuses every run-API request with 401 when no authenticator is configured, and calls the runner for none', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service });
    for (const [method, path, body] of routes) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...user1, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toMatchObject({ v: 1, error: 'unauthorized' });
    }
    expect(seen).toEqual([]);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('acts for the user the authenticator names', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator });
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { ...user1, 'content-type': 'application/json' },
      body: JSON.stringify(startRequest),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ v: 1, runId: 'r1', conversationId: 'c1', seq: 1 });
    expect(seen).toEqual([{ method: 'start', userId: 'u1', args: [startRequest] }]);
    expect(
      (
        await fetch(`${base}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(startRequest),
        })
      ).status
    ).toBe(401);
  });

  it('answers a refused start with the protocol error and its status', async () => {
    const { service } = fakeService({
      start: async () => ({ ok: false, error: 'run-active', message: 'busy', runId: 'r0' }),
    });
    const base = await serve({ service, authenticator: bearerAuthenticator });
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { ...user1, 'content-type': 'application/json' },
      body: JSON.stringify(startRequest),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      v: 1,
      error: 'run-active',
      message: 'busy',
      runId: 'r0',
    });
  });

  it('refuses a start it cannot read as bad-request, without calling the runner', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator });
    for (const body of [
      { ...startRequest, v: 2 },
      { ...startRequest, turn: { seq: 0, user: { content: 'x', attachments: [] } } },
      { ...startRequest, settings: {} },
    ]) {
      const response = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: { ...user1, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ v: 1, error: 'bad-request' });
    }
    expect(seen).toEqual([]);
  });

  it('streams the journal as SSE from after Last-Event-ID, and hides another user’s run', async () => {
    const { service } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator });
    const all = await readEvents(`${base}/runs/r1/events`, user1);
    expect(all.map(({ id, event }) => [id, event.type])).toEqual([
      [0, 'run-started'],
      [1, 'text-delta'],
      [2, 'run-ended'],
    ]);
    const rest = await readEvents(`${base}/runs/r1/events`, user1, { lastEventId: 0 });
    expect(rest.map(({ id }) => id)).toEqual([1, 2]);
    const other = await fetch(`${base}/runs/r1/events`, {
      headers: { authorization: 'Bearer user:u2' },
    });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ v: 1, error: 'not-found' });
  });

  it('sends keep-alive comments while a run is quiet', async () => {
    let release = () => {};
    const { service } = fakeService({
      events: async function* () {
        await new Promise<void>((resolve) => (release = resolve));
        yield { id: 0, event: { type: 'run-ended', status: 'done', messages: [], steps: 0 } };
      },
    });
    const base = await serve({ service, authenticator: bearerAuthenticator, keepaliveMs: 20 });
    const response = await fetch(`${base}/runs/r1/events`, { headers: user1 });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes(': keepalive')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed without a keep-alive: ${text}`);
      text += new TextDecoder().decode(value);
    }
    release();
    await reader.cancel();
  });

  it('answers stops with 202, and 404 for a run the user does not have', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator });
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...user1, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post('/runs/r1/stop', { v: 1 })).status).toBe(202);
    expect((await post('/runs/r9/stop', { v: 1 })).status).toBe(404);
    expect(
      (await post('/runs/stop', { v: 1, idempotencyKey: 'k1', conversationId: 'c1' })).status
    ).toBe(202);
    expect((await post('/conversations/c1/patch', { v: 1, title: 'New' })).status).toBe(204);
    expect((await post('/conversations/c2/patch', { v: 1, title: 'New' })).status).toBe(404);
    expect(seen.find((call) => call.method === 'stopByKey')).toEqual({
      method: 'stopByKey',
      userId: 'u1',
      args: ['k1'],
    });
  });

  it('never logs a request header (they carry the viewer’s credentials)', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { service } = fakeService();
    const logger = { ...(loggerOptions('info') as object), stream };
    const base = await serve({ service, authenticator: bearerAuthenticator, logger });
    const secret = 'sentinel-header-value-41c7';
    await fetch(`${base}/runs?conversationId=c1`, {
      headers: { authorization: `Bearer user:u1:${secret}`, cookie: `s=${secret}` },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).toContain('/runs?conversationId=c1');
    expect(lines.join('')).not.toContain(secret);
  });
});

describe('lastEventId', () => {
  it('reads a journal position, and nothing else', () => {
    expect(lastEventId('12')).toBe(12);
    expect(lastEventId(' 0 ')).toBe(0);
    expect(lastEventId(undefined)).toBeUndefined();
    expect(lastEventId('-1')).toBeUndefined();
    expect(lastEventId('abc')).toBeUndefined();
  });
});
