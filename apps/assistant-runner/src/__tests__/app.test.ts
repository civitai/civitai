import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { RunEvent, StartRunRequest } from '@civitai/components-chat/runner-protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, lastEventId, loggerOptions } from '../app';
import type { JournalEntry, RunService, StartOutcome } from '../service';
import { MintRefusedError } from '../minter';
import { createTokenVerifier } from '../tokens';
import { bearerAuthenticator } from '../test-support/fakes';
import { signGrant, signViewer, testKeys } from '../test-support/keys';
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
    start: async (userId, request, grant) => {
      note('start')(userId, request, grant);
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
      return userId === 'u1' && runId === 'r1';
    },
    stopByKey: async (userId, key) => {
      note('stopByKey')(userId, key);
    },
    patch: async (userId, conversationId, patch, grant) => {
      note('patch')(userId, conversationId, patch, grant);
      return userId === 'u1' && conversationId === 'c1';
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

// TEST-ONLY keys standing in for civitai's (see test-support/keys.ts).
const keys = testKeys();
const grants = createTokenVerifier(keys.publicPem);
const grantFor = (
  fields: Partial<{ userId: string; conversationId: string; idempotencyKey: string }> = {},
  expiresIn?: number
) =>
  signGrant(
    keys,
    {
      userId: 'u1',
      conversationId: startRequest.conversationId,
      idempotencyKey: startRequest.idempotencyKey,
      ...fields,
    },
    expiresIn
  );
/** user1's headers for a start: their sign-in and a grant for `startRequest`. */
const startHeaders = async () => ({
  ...user1,
  'x-run-grant': await grantFor(),
  'content-type': 'application/json',
});

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
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const headers = await startHeaders();
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(startRequest),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ v: 1, runId: 'r1', conversationId: 'c1', seq: 1 });
    expect(seen).toEqual([
      {
        method: 'start',
        userId: 'u1',
        args: [
          startRequest,
          expect.objectContaining({
            token: headers['x-run-grant'],
            userId: 'u1',
            conversationId: 'c1',
            idempotencyKey: 'key-1',
          }),
        ],
      },
    ]);
    const { authorization: _signIn, ...grantOnly } = headers;
    expect(
      (
        await fetch(`${base}/runs`, {
          method: 'POST',
          headers: grantOnly,
          body: JSON.stringify(startRequest),
        })
      ).status
    ).toBe(401);
  });

  it('refuses a start whose grant is missing, or is for another user, chat or start, and starts nothing', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const cases: [string, string | undefined][] = [
      ['no grant', undefined],
      ['another user', await grantFor({ userId: 'u2' })],
      ['another chat', await grantFor({ conversationId: 'c2' })],
      ['another start', await grantFor({ idempotencyKey: 'key-2' })],
      ['expired', await grantFor({}, -120)],
      ['a viewer token', await signViewer(keys, 'u1')],
      [
        'another signer',
        await signGrant(testKeys(), {
          userId: 'u1',
          conversationId: 'c1',
          idempotencyKey: 'key-1',
        }),
      ],
    ];
    for (const [name, grant] of cases) {
      const response = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: {
          ...user1,
          'content-type': 'application/json',
          ...(grant ? { 'x-run-grant': grant } : {}),
        },
        body: JSON.stringify(startRequest),
      });
      expect(response.status, name).toBe(403);
      expect(await response.json(), name).toMatchObject({ v: 1, error: 'refused' });
    }
    expect(seen).toEqual([]);
  });

  it('starts nothing when no grant verifier is configured', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator });
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: await startHeaders(),
      body: JSON.stringify(startRequest),
    });
    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('serves the run API under its base path, and health at the root', async () => {
    const { service } = fakeService();
    const base = await serve({
      service,
      authenticator: bearerAuthenticator,
      grants,
      basePath: '/api/assistant-runner',
    });
    const start = await fetch(`${base}/api/assistant-runner/runs`, {
      method: 'POST',
      headers: await startHeaders(),
      body: JSON.stringify(startRequest),
    });
    expect(start.status).toBe(201);
    expect(
      (await fetch(`${base}/api/assistant-runner/runs?conversationId=c1`, { headers: user1 }))
        .status
    ).toBe(200);
    expect((await fetch(`${base}/runs?conversationId=c1`, { headers: user1 })).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('hands a patch the grant it carries, and refuses one for another chat', async () => {
    const { service, seen } = fakeService();
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const patch = (grant?: string) =>
      fetch(`${base}/conversations/c1/patch`, {
        method: 'POST',
        headers: {
          ...user1,
          'content-type': 'application/json',
          ...(grant ? { 'x-run-grant': grant } : {}),
        },
        body: JSON.stringify({ v: 1, title: 'New' }),
      });
    const good = await grantFor({ idempotencyKey: 'any' });
    expect((await patch(good)).status).toBe(204);
    expect((await patch(await grantFor({ conversationId: 'c2' }))).status).toBe(403);
    expect((await patch(await grantFor({ userId: 'u2' }))).status).toBe(403);
    expect((await patch()).status).toBe(204);
    expect(seen.map((call) => (call.args[2] as { token?: string } | undefined)?.token)).toEqual([
      good,
      undefined,
    ]);
  });

  it('answers a refused start with the protocol error and its status', async () => {
    const { service } = fakeService({
      start: async () => ({ ok: false, error: 'run-active', message: 'busy', runId: 'r0' }),
    });
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const response = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: await startHeaders(),
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
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
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
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
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
    const base = await serve({
      service,
      authenticator: bearerAuthenticator,
      grants,
      keepaliveMs: 20,
    });
    const response = await fetch(`${base}/runs/r1/events`, {
      headers: user1,
      signal: AbortSignal.timeout(2000),
    });
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
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const post = (path: string, body: unknown, headers: Record<string, string> = user1) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const user2 = { authorization: 'Bearer user:u2' };
    expect((await post('/runs/r1/stop', { v: 1 })).status).toBe(202);
    expect((await post('/runs/r9/stop', { v: 1 })).status).toBe(404);
    expect((await post('/runs/r1/stop', { v: 1 }, user2)).status).toBe(404);
    expect((await post('/conversations/c1/patch', { v: 1, title: 'x' }, user2)).status).toBe(404);
    expect(
      (await post('/runs/stop', { v: 1, idempotencyKey: 'k1', conversationId: 'c1' })).status
    ).toBe(202);
    expect((await post('/conversations/c1/patch', { v: 1, title: 'New' })).status).toBe(204);
    expect((await post('/conversations/c2/patch', { v: 1, title: 'New' })).status).toBe(404);
    expect(seen.filter((call) => call.method === 'stopByKey')).toEqual([
      { method: 'stopByKey', userId: 'u1', args: ['k1'] },
    ]);
  });

  it('answers each refusal with its protocol status, and hides internal failures', async () => {
    const forbidden = await serve({
      service: fakeService().service,
      authenticator: { authenticate: async () => ({ ok: false, status: 403, message: 'Banned.' }) },
    });
    const refused = await fetch(`${forbidden}/runs?conversationId=c1`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ v: 1, error: 'refused', message: 'Banned.' });
    await app?.close();

    const anonymous = await serve({
      service: fakeService().service,
      authenticator: { authenticate: async () => ({ ok: true, userId: '' }) },
    });
    expect((await fetch(`${anonymous}/runs?conversationId=c1`)).status).toBe(401);
    await app?.close();

    const { service } = fakeService({
      start: async () => ({ ok: false, error: 'unavailable', message: 'Busy.' }),
      lookup: async () => {
        throw new Error('internal detail 7f3a');
      },
    });
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const start = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: await startHeaders(),
      body: JSON.stringify(startRequest),
    });
    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({ v: 1, error: 'unavailable', message: 'Busy.' });

    const failed = await fetch(`${base}/runs?conversationId=c1`, { headers: user1 });
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(JSON.parse(body)).toMatchObject({ v: 1, error: 'unavailable' });
    expect(body).not.toContain('7f3a');

    // A body that is not JSON is the client's to fix: 4xx, which the client does not retry.
    const garbled = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { ...user1, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toMatchObject({ v: 1, error: 'bad-request' });
  });

  // A regression guard: the error handler once called `code.startsWith` on every error, so one whose
  // code is a number (a DOMException's, e.g. an AbortSignal.timeout) threw inside the handler and was
  // answered a bare 500 with the original error never logged.
  it('answers a failure whose error code is not a string as unavailable, and logs the original error', async () => {
    const failures: [string, () => Error][] = [
      ['a numeric code', () => Object.assign(new Error('numeric code 5b1d'), { code: 23 })],
      ['a DOMException', () => new DOMException('timeout 9e2c', 'TimeoutError')],
    ];
    for (const [name, failure] of failures) {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      });
      const { service } = fakeService({
        start: async () => {
          throw failure();
        },
      });
      const logger = { ...(loggerOptions('info') as object), stream };
      const base = await serve({ service, authenticator: bearerAuthenticator, grants, logger });
      const response = await fetch(`${base}/runs`, {
        method: 'POST',
        headers: await startHeaders(),
        body: JSON.stringify(startRequest),
      });
      expect(response.status, name).toBe(503);
      expect(await response.json(), name).toEqual({
        v: 1,
        error: 'unavailable',
        message: 'The runner could not do that just now.',
      });
      const failedLine = lines.find((line) => line.includes('request failed'));
      expect(failedLine, name).toBeDefined();
      expect(failedLine, name).toContain(failure().message);
      await app?.close();
      app = undefined;
    }
  });

  // An invariant guard: Fastify's default request serializer already logs no headers. It fails if a
  // serializer that does is ever configured.
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
    const base = await serve({ service, authenticator: bearerAuthenticator, grants, logger });
    const secret = 'sentinel-header-value-41c7';
    await fetch(`${base}/runs?conversationId=c1`, {
      headers: { authorization: `Bearer user:u1:${secret}`, cookie: `s=${secret}` },
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).toContain('/runs?conversationId=c1');
    expect(lines.join('')).not.toContain(secret);
  });
});

describe('a patch with nothing to write it with', () => {
  it('is refused as the client’s to fix (a grant), not answered as an outage', async () => {
    const { service } = fakeService({
      patch: async () => {
        throw new MintRefusedError('invalid_grant', 'no grant', 401);
      },
    });
    const base = await serve({ service, authenticator: bearerAuthenticator, grants });
    const response = await fetch(`${base}/conversations/c1/patch`, {
      method: 'POST',
      headers: { ...user1, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, title: 'New' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ v: 1, error: 'refused' });
  });
});

describe('a patch whose mint civitai refuses', () => {
  it('answers 403 with the reason when the user is refused or turned the assistant off', async () => {
    for (const code of ['refused', 'consent_required'] as const) {
      const { service } = fakeService({
        patch: async () => {
          throw new MintRefusedError(code, `why: ${code}`, 403);
        },
      });
      const base = await serve({ service, authenticator: bearerAuthenticator, grants });
      const response = await fetch(`${base}/conversations/c1/patch`, {
        method: 'POST',
        headers: { ...user1, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, title: 'New' }),
      });
      expect(response.status, code).toBe(403);
      expect(await response.json(), code).toEqual({
        v: 1,
        error: 'refused',
        message: `why: ${code}`,
      });
      await app?.close();
      app = undefined;
    }
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
