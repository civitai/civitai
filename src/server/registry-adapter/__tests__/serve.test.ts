import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { FILTER_MAX_BYTES, filterRefusal } from '~/server/registry-adapter/json-schema';
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

  it('a filter that is not a schema is bad_request', async () => {
    const res = await get(withChange, sub(APPS, filter({ type: 12 })));
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});

/**
 * The registry spec's rule 6: a registry that accepts a filter applies it in full, and one it
 * does not apply is answered `bad_request`, never ignored (the consumer would take what it got for
 * filtered). Each refused case was, before, streamed unfiltered: an `upsert` first, then `live`.
 */
const REFUSED_KEYS_NOTE =
  '(it refuses pattern, patternProperties, $ref, $dynamicRef, $recursiveRef, $defs, definitions anywhere in a filter)';

describe('🔴 a filter this source will not evaluate is bad_request, never ignored (rule 6)', () => {
  it('a regular expression is never compiled: bad_request, naming the keyword', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { pattern: '^zzz' } } }))
    );
    expect([res.status, res.type, JSON.parse(res.text)]).toEqual([
      400,
      'application/json',
      {
        error: 'bad_request',
        message: `filter uses "pattern", which this registry does not apply ${REFUSED_KEYS_NOTE}`,
      },
    ]);
  });

  it('positive control: the same filter without the regex is applied', async () => {
    const res = await get(
      adapter(),
      sub(APPS, asFilter({ properties: { slug: { const: 'zzz' } } }))
    );
    expect(res.status).toBe(200);
    expect(res.text.startsWith('event: live')).toBe(true);
  });

  it.each([
    [
      'dependencies',
      { dependencies: { slug: { properties: { slug: { pattern: '^zzz' } } } } },
      'pattern',
    ],
    [
      'a $ref to a member',
      { $ref: '#/x', x: { properties: { slug: { pattern: '^zzz' } } } },
      '$ref',
    ],
  ])('🔴 a regex reached through %s is bad_request too', async (_name, f, key) => {
    const res = await get(adapter(), sub(APPS, asFilter(f)));
    expect([res.status, JSON.parse(res.text)]).toEqual([
      400,
      {
        error: 'bad_request',
        message: `filter uses "${key}", which this registry does not apply ${REFUSED_KEYS_NOTE}`,
      },
    ]);
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
  // Before, the whole JSON was walked, so a filter matching a whole body that has a key named
  // `pattern` (a release body's `manifestHash` schema, say) was refused.
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

  it('a real pattern keyword beside the data is still bad_request', async () => {
    const f = { const: { manifestHash: { pattern: 'x' } }, properties: { slug: { pattern: 'a' } } };
    const res = await get(adapter(), sub(APPS, asFilter(f)));
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});

/** Whether `filterRefusal` refuses `schema`. */
const refused = (schema: unknown) => filterRefusal(schema) !== null;

describe('filterRefusal', () => {
  it.each([
    [{ pattern: 'a' }, true],
    [{ patternProperties: { '^a': {} } }, true],
    [{ allOf: [{ properties: { a: { items: { pattern: 'x' } } } }] }, true],
    [{ $defs: { d: { not: { pattern: 'x' } } } }, true],
    // The two shapes a keyword-list walk missed: `dependencies`, and a `$ref` to any member.
    [{ dependencies: { a: { properties: { b: { pattern: '^(a+)+$' } } } } }, true],
    [{ $ref: '#/x', x: { properties: { b: { pattern: '^(a+)+$' } } } }, true],
    // Refused too, deliberately: every schema object is walked, whatever the key above.
    [{ properties: { pattern: { const: 'a property named pattern' } } }, true],
    // The value of a data keyword is data, never evaluated: not walked.
    [{ enum: [{ pattern: 'a value, not a keyword' }] }, false],
    [{ const: { manifestHash: { pattern: 'x' } } }, false],
    [{ default: { $ref: '#' }, examples: [{ $defs: {} }, { definitions: {} }] }, false],
    [{ allOf: [{ const: { pattern: 'x' } }, { not: { enum: [{ $ref: '#' }] } }] }, false],
    // But under a name map the same key is a NAME whose value is a schema: walked.
    [{ properties: { const: { pattern: 'x' } } }, true],
    [{ properties: { enum: { properties: { a: { pattern: 'x' } } } } }, true],
    [{ dependentSchemas: { default: { pattern: 'x' } } }, true],
    [{ properties: { a: { properties: { examples: { items: { pattern: 'x' } } } } } }, true],
    // A schema named `properties` holds keywords again: its `const` is data.
    [{ properties: { properties: { const: { pattern: 'x' } } } }, false],
    // A real keyword beside the data is still refused.
    [{ const: { pattern: 'x' }, items: { pattern: 'y' } }, true],
    // A string VALUE mentioning the word is not a key.
    [
      { properties: { slug: { const: 'pattern' } }, description: 'no patternProperties here' },
      false,
    ],
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
