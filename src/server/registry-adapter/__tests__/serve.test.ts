import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';

const APPS = 'urn:schema:civitai-schemas:app@v1';
const one: Entity = {
  urn: 'urn:civitai-apps:app/orbit-notes',
  schemas: [APPS],
  rev: 'rev-7a',
  body: { slug: 'orbit-notes' },
};

/** A source whose change feed has one delete and then ends, so every stream closes. */
function adapter(over: Partial<Adapter> = {}): Adapter {
  return {
    namespace: 'civitai-apps',
    serves: (schema) => schema === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'c1.snapshot-cursor', entities: [one] }),
    async *changes(): AsyncGenerator<Change> {
      yield { delete: 'urn:civitai-apps:app/tide-log', cursor: 'c1.after-delete' };
    },
    ...over,
  };
}

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
);

async function get(a: Adapter, query: string) {
  server = createRegistryServer(a);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${query}`);
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
}

const sub = (schema: string, extra = '') =>
  `/subscribe?schema=${encodeURIComponent(schema)}${extra}`;

describe('the HTTP/SSE binding', () => {
  it('snapshot upserts with an empty cursor, then live, then changes, then end', async () => {
    const res = await get(adapter(), sub(APPS));
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/event-stream');
    expect(res.text).toBe(
      'event: upsert\n' +
        `data: ${JSON.stringify({ entity: one, cursor: '' })}\n\n` +
        'event: live\ndata: {"cursor":"c1.snapshot-cursor"}\n\n' +
        'event: delete\ndata: {"urn":"urn:civitai-apps:app/tide-log","cursor":"c1.after-delete"}\n\n' +
        'event: end\ndata: {}\n\n'
    );
  });

  it('a cursor skips the snapshot', async () => {
    const res = await get(adapter(), sub(APPS, '&cursor=c1.resume-here'));
    expect(res.text.startsWith('event: live\ndata: {"cursor":"c1.resume-here"}')).toBe(true);
  });

  it('a urn filter drops other entities', async () => {
    const res = await get(
      adapter(),
      sub(APPS, `&urn=${encodeURIComponent('urn:civitai-apps:app/other')}`)
    );
    expect(res.text).toBe(
      'event: live\ndata: {"cursor":"c1.snapshot-cursor"}\n\nevent: end\ndata: {}\n\n'
    );
  });

  it('a schema it does not serve is `end` first', async () => {
    const res = await get(adapter(), sub('urn:schema:civitai-schemas:model@v1'));
    expect(res.text).toBe('event: end\ndata: {}\n\n');
  });

  it('cursor_expired on resume arrives as an error event naming it, as the SDK sends it', async () => {
    const res = await get(
      adapter({
        // eslint-disable-next-line require-yield
        async *changes() {
          throw new ProtocolError('cursor_expired', 'gone');
        },
      }),
      sub(APPS, '&cursor=c1.stale')
    );
    // `live` precedes the first read of the change feed, so the stream has started.
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: error\ndata: {"error":"cursor_expired","message":"gone"}');
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

describe('a request filter', () => {
  const filter = (f: unknown) => `&filter=${encodeURIComponent(JSON.stringify(f))}`;
  const changed: Entity = { ...one, rev: 'rev-8b', body: { slug: 'renamed-orbit' } };
  const withChange = adapter({
    async *changes(): AsyncGenerator<Change> {
      yield { upsert: changed, cursor: 'c1.after-rename' };
    },
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
      'event: delete\ndata: {"urn":"urn:civitai-apps:app/orbit-notes","cursor":"c1.after-rename"}'
    );
    expect(res.text).not.toContain('renamed-orbit');
  });

  it('a filter that is not a schema is bad_request', async () => {
    const res = await get(withChange, sub(APPS, filter({ type: 12 })));
    expect([res.status, JSON.parse(res.text).error]).toEqual([400, 'bad_request']);
  });
});
