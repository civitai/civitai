import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { FILTER_MAX_BYTES, filterRefusal } from '~/server/registry-adapter/json-schema';
import { createSubscriptionLimiter } from '~/server/registry-adapter/limits';
import type { VerifyToken } from '~/server/registry-adapter/auth';
import type { ServeOptions } from '~/server/registry-adapter/serve';
import { createRegistryServer, handleRequest } from '~/server/registry-adapter/serve';
import { bindCursor, requestBinding } from '~/server/registry-adapter/subscription';

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const one: Entity = {
  urn: 'urn:apps.civitai.com:app/orbit-notes',
  schemas: [APPS],
  rev: 'rev-7a',
  body: { slug: 'orbit-notes' },
};

/** A source whose change feed has one delete and then ends, so every stream closes. */
function adapter(over: Partial<Adapter> = {}): Adapter {
  return {
    namespace: 'apps.civitai.com',
    serves: (schema) => schema === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'c1.snapshot-cursor', entities: [one] }),
    changes: async () =>
      feed({ delete: 'urn:apps.civitai.com:app/tide-log', cursor: 'c1.after-delete' }),
    ...over,
  };
}

/** A change feed of `changes`, then its end. */
async function* feed(...changes: Change[]): AsyncGenerator<Change> {
  yield* changes;
}

/** A change feed that fails on its first read, once the stream is live. */
// eslint-disable-next-line require-yield
async function* failing(err: Error): AsyncGenerator<Change> {
  throw err;
}

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
);

/**
 * The response, its text with each cursor's request binding (`b1.<digest>.`) taken out: these
 * cases are about the frames, and `subscription.test.ts` pins the binding.
 */
async function get(a: Adapter, query: string, headers: Record<string, string> = {}) {
  server = createRegistryServer(a);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${query}`, { headers });
  const text = (await res.text()).replace(/b1\.[0-9a-f]{24}\./g, '');
  return { status: res.status, type: res.headers.get('content-type'), text };
}

/** `cursor` as this source hands it out for an unfiltered request of `APPS`. */
const issued = (cursor: string) => bindCursor(cursor, requestBinding({ schema: APPS, urns: [] }));

const asFilter = (f: unknown) => `&filter=${encodeURIComponent(JSON.stringify(f))}`;
const sub = (schema: string, extra = '') =>
  `/subscribe?schema=${encodeURIComponent(schema)}${extra}`;

describe('the HTTP/SSE binding', () => {
  it('🔴 snapshot upserts with an empty cursor and an EMPTY id, then live, then changes, then end', async () => {
    const res = await get(adapter(), sub(APPS));
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/event-stream');
    expect(res.text).toBe(
      'event: upsert\nid:\n' +
        `data: ${JSON.stringify({ entity: one, cursor: '' })}\n\n` +
        'event: live\nid: c1.snapshot-cursor\ndata: {"cursor":"c1.snapshot-cursor"}\n\n' +
        'event: delete\nid: c1.after-delete\n' +
        'data: {"urn":"urn:apps.civitai.com:app/tide-log","cursor":"c1.after-delete"}\n\n' +
        'event: end\ndata: {}\n\n'
    );
  });

  it('a cursor skips the snapshot', async () => {
    const res = await get(adapter(), sub(APPS, `&cursor=${issued('c1.resume-here')}`));
    expect(res.text.startsWith('event: live\nid: c1.resume-here\n')).toBe(true);
  });

  it('🔴 Last-Event-ID resumes as a cursor does', async () => {
    const res = await get(adapter(), sub(APPS), { 'last-event-id': issued('c1.resume-here') });
    expect(res.text.startsWith('event: live\nid: c1.resume-here\n')).toBe(true);
  });

  it('🔴 with both, Last-Event-ID wins: it is the later position an EventSource reconnects with', async () => {
    const res = await get(adapter(), sub(APPS, `&cursor=${issued('c1.in-the-url')}`), {
      'last-event-id': issued('c1.last-received'),
    });
    expect(res.text.startsWith('event: live\nid: c1.last-received\n')).toBe(true);
  });

  it('a urn filter drops other entities', async () => {
    const res = await get(
      adapter(),
      sub(APPS, `&urn=${encodeURIComponent('urn:apps.civitai.com:app/other')}`)
    );
    expect(res.text).toBe(
      'event: live\nid: c1.snapshot-cursor\ndata: {"cursor":"c1.snapshot-cursor"}\n\n' +
        'event: progress\nid: c1.after-delete\ndata: {"cursor":"c1.after-delete"}\n\n' +
        'event: end\ndata: {}\n\n'
    );
  });

  it('a schema it does not serve is `end` first', async () => {
    const res = await get(adapter(), sub('urn:schema:civitai-schemas:model@v1'));
    expect(res.text).toBe('event: end\ndata: {}\n\n');
  });

  it('a cursor the source refuses is answered with its own status, before any event', async () => {
    const res = await get(
      adapter({
        changes: async () => {
          throw new ProtocolError('cursor_expired', 'gone');
        },
      }),
      sub(APPS, `&cursor=${issued('c1.stale')}`)
    );
    expect([res.status, res.type, JSON.parse(res.text)]).toEqual([
      410,
      'application/json',
      { error: 'cursor_expired', message: 'gone' },
    ]);
  });

  it('a feed that fails once live arrives as an error event naming it, after live', async () => {
    const res = await get(
      adapter({
        changes: async () => failing(new ProtocolError('cursor_expired', 'gone later')),
      }),
      sub(APPS, `&cursor=${issued('c1.resume-here')}`)
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe(
      'event: live\nid: c1.resume-here\ndata: {"cursor":"c1.resume-here"}\n\n' +
        'event: error\ndata: {"error":"cursor_expired","message":"gone later"}\n\n'
    );
  });

  it('🔴 an unexpected error is `unavailable` and its text never reaches the client', async () => {
    const res = await get(
      adapter({
        snapshot: async () => {
          throw new Error('password authentication failed for db-canary-31');
        },
      }),
      sub(APPS)
    );
    expect([res.status, JSON.parse(res.text)]).toEqual([
      503,
      { error: 'unavailable', message: 'unavailable' },
    ]);
  });

  it('a missing schema is bad_request', async () => {
    const res = await get(adapter(), '/subscribe');
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});

describe('🔴 each HTTP subscription logs its region decision once, and no address', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const META_DE = `&meta=${encodeURIComponent('{"country":"DE"}')}`;

  /**
   * One subscription from the edge's CA, with meta DE, read to its end; its region lines and the
   * error code it was refused with, if any.
   */
  async function lines(
    trustMeta: string | undefined,
    {
      query = sub(APPS, META_DE),
      headers = {},
      opts = {},
    }: { query?: string; headers?: Record<string, string>; opts?: ServeOptions } = {}
  ) {
    vi.stubEnv('REGISTRY_ADAPTER_TRUST_META', trustMeta);
    const logged: string[] = [];
    server = createRegistryServer(adapter(), { ...opts, onRegion: (line) => logged.push(line) });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${query}`, {
      headers: {
        'cf-ipcountry': 'CA',
        'cf-connecting-ip': '192.0.2.7',
        'x-forwarded-for': '198.51.100.1',
        ...headers,
      },
    });
    const text = await res.text();
    const error = res.status === 200 ? undefined : (JSON.parse(text) as { error: string }).error;
    return { status: res.status, error, logged };
  }

  it('flag on: the meta country, one line', async () => {
    const { status, logged } = await lines('1');
    expect(status).toBe(200);
    expect(logged).toEqual([
      'subscription region: binding=http country=DE region=none source=meta restricted=false principal=anonymous client=none act=none audience=m',
    ]);
    for (const address of ['192.0.2.7', '198.51.100.1', '127.0.0.1']) {
      expect(logged[0]).not.toContain(address);
    }
  });

  it('flag off: the header country, one line', async () => {
    const { logged } = await lines(undefined);
    expect(logged).toEqual([
      'subscription region: binding=http country=CA region=none source=header restricted=false principal=anonymous client=none act=none audience=m',
    ]);
  });

  it('an injected regionRestricted is the restricted logged, not the site rule', async () => {
    const { status, logged } = await lines(undefined, { opts: { regionRestricted: () => true } });
    expect(status).toBe(200);
    expect(logged).toEqual([
      'subscription region: binding=http country=CA region=none source=header restricted=true principal=anonymous client=none act=none audience=m',
    ]);
  });

  it('🔴 the line records the audience decision, client and relay: a service reads every rating with no hold, a user is held', async () => {
    const service: VerifyToken = async () => ({
      subject: 'service:7e3a1c55-2b4d-4f60-9a8e-1c2d3e4f5a6b',
      userId: null,
      clientId: '7e3a1c55-2b4d-4f60-9a8e-1c2d3e4f5a6b',
      scope: 0n,
      actor: 'relay-exp-2a',
      service: true,
      expiresAt: null,
    });
    const user: VerifyToken = async () => ({
      subject: 'user:3301/client:app-5d1f',
      userId: 3301,
      clientId: 'app-5d1f',
      scope: 0n,
      actor: null,
      user: { showNsfw: true, browsingLevel: 31 },
      expiresAt: null,
    });
    const asService = await lines(undefined, {
      headers: { authorization: 'Bearer s' },
      opts: { verifyToken: service, regionRestricted: () => true },
    });
    expect(asService.status).toBe(200);
    expect(asService.logged).toEqual([
      'subscription region: binding=http country=CA region=none source=header restricted=false principal=service client=7e3a1c55-2b4d-4f60-9a8e-1c2d3e4f5a6b act=relay-exp-2a audience=mrx+xxx',
    ]);
    const asUser = await lines(undefined, {
      headers: { authorization: 'Bearer u' },
      opts: { verifyToken: user, regionRestricted: () => true },
    });
    expect(asUser.logged).toEqual([
      'subscription region: binding=http country=CA region=none source=header restricted=true principal=user client=app-5d1f act=none audience=m',
    ]);
    // No user id is logged.
    expect(asUser.logged[0]).not.toContain('3301');
  });

  // Each refusal at a later step than the last, so a line moved ahead of any of them shows.
  it('a request refused as malformed logs nothing', async () => {
    const { status, error, logged } = await lines('1', { query: '/subscribe' });
    expect([status, error]).toEqual([400, 'bad_request']);
    expect(logged).toEqual([]);
  });

  it('a request refused over the subscription cap logs nothing', async () => {
    const limiter = createSubscriptionLimiter({ total: 0, perSubject: 100, perAddress: 100 });
    const { status, error, logged } = await lines('1', { opts: { limiter } });
    expect([status, error]).toEqual([503, 'unavailable']);
    expect(logged).toEqual([]);
  });

  it('a request refused for its token logs nothing', async () => {
    // No verifyToken: any token is invalid_token.
    const { status, error, logged } = await lines('1', {
      headers: { authorization: 'Bearer x' },
    });
    expect([status, error]).toEqual([401, 'invalid_token']);
    expect(logged).toEqual([]);
  });
});

describe('🔴 an authorized stream belongs to one consumer (auth extension, relay rule 2)', () => {
  async function head(headers: Record<string, string>) {
    server = createRegistryServer(adapter(), {
      verifyToken: async () => ({
        subject: 'user:6120/client:oc-cache-3d9e',
        userId: 6120,
        clientId: 'oc-cache-3d9e',
        scope: 0n,
        actor: null,
        user: { showNsfw: false, browsingLevel: 1 },
        expiresAt: null,
      }),
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${sub(APPS)}`, { headers });
    await res.text();
    return {
      status: res.status,
      cacheControl: res.headers.get('cache-control'),
      vary: res.headers.get('vary'),
    };
  }

  it('a stream with a token is private, no-store, varying on Authorization', async () => {
    expect(await head({ authorization: 'Bearer tok-6120' })).toEqual({
      status: 200,
      cacheControl: 'private, no-store',
      vary: 'Authorization',
    });
  });

  it('an anonymous stream keeps no-cache (POSITIVE CONTROL: the header is per subscription)', async () => {
    expect(await head({})).toEqual({ status: 200, cacheControl: 'no-cache', vary: null });
  });
});

describe('🔴 a snapshot slower than the heartbeat', () => {
  // Like Node's: anything written before writeHead sends default headers, and a writeHead
  // after that throws ERR_HTTP_HEADERS_SENT.
  function fakeRes() {
    const out: string[] = [];
    const listeners: Record<string, () => void> = {};
    let headersSent = false;
    const res = {
      out,
      closed: false,
      writableEnded: false,
      get headersSent() {
        return headersSent;
      },
      writeHead() {
        if (headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
        headersSent = true;
        out.push('<head>');
        return res;
      },
      write(chunk: string) {
        headersSent = true;
        out.push(chunk);
        return true;
      },
      end(chunk?: string) {
        if (chunk) out.push(chunk);
        res.writableEnded = true;
        listeners.close?.();
        return res;
      },
      on(event: string, fn: () => void) {
        listeners[event] = fn;
        return res;
      },
    };
    return res;
  }

  it('sends the head before any heartbeat, and never an error for it', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = adapter({
        snapshot: async () => {
          await gate;
          // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
          return { cursor: 'c1.slow', entities: [one] };
        },
      });
      const res = fakeRes();
      const done = handleRequest(slow)(
        { url: sub(APPS), headers: {} } as unknown as IncomingMessage,
        res as unknown as ServerResponse
      );
      await vi.advanceTimersByTimeAsync(20_000);
      release();
      await done;
      expect(res.out[0]).toBe('<head>');
      expect(res.out.join('')).not.toContain('event: error');
      expect(res.out.join('')).toContain('event: end');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('🔴 a consumer that stops reading (rule 8)', () => {
  /**
   * A response whose socket never drains, as Node's behaves: `end()` does NOT emit `close` while
   * the socket is stalled (only `destroy()` does, later), and a write after `end()` emits `error`,
   * which throws when nothing listens for it (the process would exit).
   */
  class StalledRes extends EventEmitter {
    out: string[] = [];
    writesAfterEnd = 0;
    closed = false;
    destroyed = false;
    writableEnded = false;
    headersSent = false;
    writeHead() {
      this.headersSent = true;
      return this;
    }
    write(chunk: string) {
      if (this.writableEnded) {
        this.writesAfterEnd++;
        this.emit(
          'error',
          Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })
        );
        return false;
      }
      this.out.push(chunk);
      return false;
    }
    end(chunk?: string) {
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      return this;
    }
    destroy() {
      this.destroyed = true;
      setImmediate(() => {
        this.closed = true;
        this.emit('close');
      });
      return this;
    }
  }

  it('is ended with slow_consumer, its socket freed, and no timer ever writes to it again', async () => {
    vi.useFakeTimers();
    try {
      const res = new StalledRes();
      const done = handleRequest(adapter(), { slowConsumerMs: 20 })(
        { url: sub(APPS), headers: {} } as unknown as IncomingMessage,
        res as unknown as ServerResponse
      );
      await vi.advanceTimersByTimeAsync(50);
      await done;
      // Well past several heartbeat periods: before the fix, the first one wrote after end.
      await vi.advanceTimersByTimeAsync(60_000);
      // The first frame filled the buffer: nothing after it but the error.
      expect(res.out).toEqual([
        `event: upsert\nid:\ndata: ${JSON.stringify({ entity: one, cursor: '' })}\n\n`,
        'event: error\ndata: {"error":"slow_consumer","message":"the consumer did not keep up with the stream"}\n\n',
      ]);
      expect([res.writesAfterEnd, res.destroyed, vi.getTimerCount()]).toEqual([0, true, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a socket error on the response is never unhandled', async () => {
    vi.useFakeTimers();
    try {
      const res = new StalledRes();
      const done = handleRequest(adapter(), { slowConsumerMs: 60_000 })(
        { url: sub(APPS), headers: {} } as unknown as IncomingMessage,
        res as unknown as ServerResponse
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(() => res.emit('error', new Error('ECONNRESET'))).not.toThrow();
      res.destroy();
      await vi.advanceTimersByTimeAsync(60_000);
      await done;
      expect([res.writesAfterEnd, vi.getTimerCount()]).toEqual([0, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a request filter', () => {
  const filter = (f: unknown) => `&filter=${encodeURIComponent(JSON.stringify(f))}`;
  const changed: Entity = { ...one, rev: 'rev-8b', body: { slug: 'renamed-orbit' } };
  const withChange = adapter({
    changes: async () => feed({ upsert: changed, cursor: 'c1.after-rename' }),
  });

  it('drops a snapshot entity that does not match', async () => {
    const res = await get(withChange, sub(APPS, filter(false)));
    expect(res.text.startsWith('event: live')).toBe(true);
  });

  it('keeps one that does', async () => {
    const res = await get(
      withChange,
      sub(APPS, filter({ properties: { slug: { const: 'orbit-notes' } } }))
    );
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it('🔴 a change that stops matching arrives as a delete', async () => {
    const res = await get(
      withChange,
      sub(APPS, filter({ properties: { slug: { const: 'orbit-notes' } } }))
    );
    expect(res.text).toContain(
      'event: delete\nid: c1.after-rename\n' +
        'data: {"urn":"urn:apps.civitai.com:app/orbit-notes","cursor":"c1.after-rename"}'
    );
    expect(res.text).not.toContain('renamed-orbit');
  });

  // `^orbit` is anchored, so `renamed-orbit` (which holds `orbit`, not at its start) stops
  // matching; `notes` is not, so `orbit-notes` matches it in the middle.
  it('🔴 a change that stops matching a pattern arrives as a delete', async () => {
    const res = await get(
      withChange,
      sub(APPS, filter({ properties: { slug: { pattern: '^orbit' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: upsert')).toBe(true);
    expect(res.text).toContain(
      'event: delete\nid: c1.after-rename\n' +
        'data: {"urn":"urn:apps.civitai.com:app/orbit-notes","cursor":"c1.after-rename"}'
    );
    expect(res.text).not.toContain('renamed-orbit');
  });

  it('a pattern is unanchored: a match in the middle keeps the entity', async () => {
    const res = await get(
      withChange,
      sub(APPS, filter({ properties: { slug: { pattern: 'notes' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it('a filter that is not a schema is bad_request', async () => {
    const res = await get(withChange, sub(APPS, filter({ type: 12 })));
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});

/**
 * The registry spec's rule 6: a registry that accepts a filter applies it in full, and one it
 * does not apply is answered `bad_request`, never ignored (the consumer would take what it got for
 * filtered). The wire contract is the status and `error`; the message only has to name the keyword.
 */

describe('🔴 a filter this source will not evaluate is bad_request, never ignored (rule 6)', () => {
  // A pattern is applied (on a linear-time engine), not refused: the entity it excludes is not
  // sent, and the one it matches is.
  it('🔴 a pattern is applied: one that excludes the entity sends none', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { pattern: '^zzz' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: live')).toBe(true);
  });

  it('🔴 positive control: a pattern that matches the entity sends it', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { pattern: '^orbit-' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it('🔴 a pattern the linear-time engine cannot run (a lookahead) is bad_request, saying why', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { pattern: '^(?!zzz)' } } }))
    );
    const body = JSON.parse(res.text);
    expect([res.status, res.type, body.error]).toEqual([400, 'application/json', 'bad_request']);
    expect(body.message).toContain('a lookahead');
  });

  it.each([
    [
      'dependencies',
      { dependencies: { slug: { properties: { slug: { pattern: '(a)\\1' } } } } },
      'a backreference',
    ],
    [
      'a $ref to a member',
      { $ref: '#/x', x: { properties: { slug: { pattern: '^zzz' } } } },
      '"$ref"',
    ],
  ])('🔴 a refused construct reached through %s is bad_request too', async (_name, f, why) => {
    const res = await get(adapter(), sub(APPS, asFilter(f)));
    const body = JSON.parse(res.text);
    expect([res.status, body.error]).toEqual([400, 'bad_request']);
    expect(body.message).toContain(why);
  });

  it('a filter whose string value merely contains the word "pattern" is still applied', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { const: 'pattern' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: live')).toBe(true);
  });

  it('a filter over the size bound is bad_request', async () => {
    const big = {
      properties: { slug: { const: 'zzz' } },
      description: 'x'.repeat(FILTER_MAX_BYTES),
    };
    const res = await get(adapter(), sub(APPS, asFilter(big)));
    expect([res.status, JSON.parse(res.text)]).toEqual([
      400,
      {
        error: 'bad_request',
        message:
          'filter is longer than 8192 characters as JSON, which this registry does not apply',
      },
    ]);
  });

  it('positive control: a filter just under the size bound is applied', async () => {
    const f = { properties: { slug: { const: 'zzz' } }, description: '' };
    const room = FILTER_MAX_BYTES - JSON.stringify(f).length;
    const res = await get(adapter(), sub(APPS, asFilter({ ...f, description: 'x'.repeat(room) })));
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: live')).toBe(true);
  });
});

describe('🔴 a filter whose data holds a refused key is applied: const, enum, default and examples are data', () => {
  // A filter matching a whole body that has a key named `pattern` (a release body's
  // `manifestHash` schema, say) is not refused.
  it.each([
    [
      'const',
      { properties: { slug: { const: 'zzz' } }, const: { manifestHash: { pattern: 'x' } } },
    ],
    ['enum', { properties: { slug: { const: 'zzz' } }, enum: [{ $ref: '#', $defs: {} }, 1] }],
  ])('a refused key inside %s: applied (the entity it excludes is not sent)', async (_n, f) => {
    const res = await get(adapter(), sub(APPS, asFilter(f)));
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: live')).toBe(true);
  });

  it('positive control: a body matched whole by const is sent', async () => {
    const res = await get(adapter(), sub(APPS, asFilter({ const: { slug: 'orbit-notes' } })));
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it('a real $ref keyword beside the data is still bad_request', async () => {
    const f = { const: { manifestHash: { $ref: '#' } }, properties: { slug: { $ref: '#' } } };
    const res = await get(adapter(), sub(APPS, asFilter(f)));
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});

/** Whether `filterRefusal` refuses `schema`. */
const refused = (schema: unknown) => filterRefusal(schema) !== null;

describe('filterRefusal', () => {
  it.each([
    // `pattern` and `patternProperties` are applied (on a linear-time engine), not refused.
    [{ pattern: 'a' }, false],
    [{ patternProperties: { '^a': {} } }, false],
    [{ dependencies: { a: { properties: { b: { pattern: '^(a+)+$' } } } } }, false],
    [{ allOf: [{ properties: { a: { items: { $ref: '#' } } } }] }, true],
    [{ $defs: { d: { not: { pattern: 'x' } } } }, true],
    // The two shapes a keyword-list walk missed: `dependencies`, and a `$ref` to any member.
    [{ dependencies: { a: { properties: { b: { $ref: '#' } } } } }, true],
    [{ $ref: '#/x', x: { properties: { b: { pattern: '^(a+)+$' } } } }, true],
    // Under `patternProperties` a key is a pattern and its value a schema: walked.
    [{ patternProperties: { '^a': { $ref: '#' } } }, true],
    // Refused too, deliberately: every schema object is walked, whatever the key above.
    [{ properties: { $ref: { const: 'a property named $ref' } } }, true],
    // The value of a data keyword is data, never evaluated: not walked.
    [{ enum: [{ $ref: 'a value, not a keyword' }] }, false],
    [{ const: { manifestHash: { $defs: {} } } }, false],
    [{ default: { $ref: '#' }, examples: [{ $defs: {} }, { definitions: {} }] }, false],
    [{ allOf: [{ const: { $ref: '#' } }, { not: { enum: [{ $ref: '#' }] } }] }, false],
    // But under a name map the same key is a NAME whose value is a schema: walked.
    [{ properties: { const: { $ref: '#' } } }, true],
    [{ properties: { enum: { properties: { a: { $ref: '#' } } } } }, true],
    [{ dependentSchemas: { default: { $ref: '#' } } }, true],
    [{ properties: { a: { properties: { examples: { items: { $ref: '#' } } } } } }, true],
    // A schema named `properties` holds keywords again: its `const` is data.
    [{ properties: { properties: { const: { $ref: '#' } } } }, false],
    // A real keyword beside the data is still refused.
    [{ const: { $ref: '#' }, items: { $ref: '#' } }, true],
    // A string VALUE mentioning the word is not a key.
    [{ properties: { slug: { const: '$ref' } }, description: 'no $defs here' }, false],
    [{ properties: { a: { type: 'string', maxLength: 3 } } }, false],
    // A reference, a definition or a dynamic reference, whatever it points at: references can
    // build a DAG whose evaluation doubles at every level.
    [{ $ref: '#/$defs/a', $defs: { a: { const: 1 } } }, true],
    [{ not: { $ref: '#' } }, true],
    [{ definitions: { a: { const: 1 } } }, true],
    [{ $dynamicRef: '#meta' }, true],
    [{ $recursiveRef: '#' }, true],
    [{ anyOf: [{ const: 1 }, { enum: [2, 3] }], properties: { a: { const: '$ref' } } }, false],
  ])('%o → %s', (schema, expected) => {
    expect(refused(schema)).toBe(expected);
  });
});
