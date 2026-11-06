import * as grpc from '@grpc/grpc-js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { abortableSleep, createPollingAdapter } from '~/server/registry-adapter/cursor';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import {
  SOURCE_SERVICE,
  createGrpcServer,
  errorInfoOf,
  listenGrpc,
} from '~/server/registry-adapter/grpc';
import type { Adapter, StreamEvent } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { bindCursor, requestBinding } from '~/server/registry-adapter/subscription';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';
import type { FixtureCatalog } from '../../../../scripts/registry-adapter-fixture/fixture-source';
import {
  createMemorySnapshotStore,
  fixtureDocSource,
} from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * Per-token content-rating enforcement (the registry's auth extension, as an origin serves it):
 * a shared document's rating is its app's, so a document stream carries an app's documents only
 * to a token whose user may read that rating, and anonymous reads what anyone may.
 */

const NOTES = 'urn:schema:apps.civitai.com:orbit-notes/notes@v1';
const DOC = 'urn:apps.civitai.com:orbit-notes/notes/n1';
const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };

const notes = {
  visibility: 'shared',
  write: 'own',
  registry: 'public',
  schema: { type: 'object' },
};
const manifest = { blockId: 'orbit-notes', storage: { collections: { notes } } };

/** The one listed app, rated `rating`, whose `notes` collection is exported at @v1. */
function app(rating: string): CatalogApp {
  return {
    listing: {
      slug: 'orbit-notes',
      kind: 'onsite',
      name: 'Orbit Notes',
      tagline: null,
      category: null,
      contentRating: rating,
      iconUrl: null,
      creatorUsername: null,
      externalUrl: null,
      sourceRepoUrl: null,
      forkOf: null,
    },
    block: {
      id: 'ab_orbit_31',
      blockId: 'orbit-notes',
      version: '1.0.0',
      status: 'approved',
      contentRating: rating,
      manifest,
    },
    approved: [
      {
        id: 'pubreq_1',
        version: '1.0.0',
        manifest,
        bundleSha256: null,
        commitSha: null,
        sourceCommit: null,
        reviewedAt: null,
      },
    ],
  };
}

/** The adapter as `main.ts` composes it, over an app whose rating the test may change. */
function source(world: { rating: string }) {
  const store = createMemorySnapshotStore();
  const cat: FixtureCatalog = {
    listings: [],
    documents: [
      {
        appId: 'ab_orbit_31',
        ns: 'prod',
        coll: 'notes',
        scopeUid: 0,
        key: 'n1',
        data: { title: 'first' },
        version: 1,
        seq: 2,
      },
    ],
    lastSeq: { ab_orbit_31: 2 },
  };
  const readApps = async () => [app(world.rating)];
  const entities = createPollingAdapter({
    namespace: 'apps.civitai.com',
    serves: SERVED_SCHEMAS,
    read: async () =>
      buildEntities(await readApps(), { baseUrl: 'https://civitai.example', features: SWITCH_ON }),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
  const docs = createDocFeed({
    source: fixtureDocSource(() => cat),
    resolve: resolveFromCatalog(readApps, SWITCH_ON),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
  return { adapter: composeAdapter(entities, docs), store, cat };
}

/** Rewrites document n1 at the next seq: a change every stream that carries it is sent. */
function edit(cat: FixtureCatalog, title: string) {
  const seq = cat.lastSeq!.ab_orbit_31 + 1;
  cat.documents = cat.documents!.map((d) => (d.key === 'n1' ? { ...d, data: { title }, seq } : d));
  cat.lastSeq = { ab_orbit_31: seq };
}

const ALL_LEVELS = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX;
const UP_TO_R = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R;

/** The site's verification, faked: each token is a user with saved browsing settings. */
const TOKENS: Record<
  string,
  {
    subject: string;
    user: { showNsfw: boolean; browsingLevel: number };
    expiresAt: () => Date | null;
  }
> = {
  'x-token': {
    subject: 'user:1/client:a',
    user: { showNsfw: true, browsingLevel: ALL_LEVELS },
    expiresAt: () => null,
  },
  'r-token': {
    subject: 'user:2/client:a',
    user: { showNsfw: true, browsingLevel: UP_TO_R },
    expiresAt: () => null,
  },
  // Another user who may read exactly what `r-token`'s may.
  'r2-token': {
    subject: 'user:6/client:a',
    user: { showNsfw: true, browsingLevel: UP_TO_R },
    expiresAt: () => null,
  },
  // X in the saved level, but mature content switched off: the site serves such a user PG.
  'x-off-token': {
    subject: 'user:3/client:a',
    user: { showNsfw: false, browsingLevel: ALL_LEVELS },
    expiresAt: () => null,
  },
  // The site's lookup already refuses an expired row; this one is the backstop past it.
  'expired-token': {
    subject: 'user:4/client:a',
    user: { showNsfw: true, browsingLevel: ALL_LEVELS },
    expiresAt: () => new Date(Date.now() - 1_000),
  },
};
/** Tokens revoked after their first verification: `revoked-after-first:<n>`. */
const verified = new Set<string>();
const verifyToken = async (token: string) => {
  if (token.startsWith('revoked-after-first:')) {
    if (verified.has(token)) return null;
    verified.add(token);
    return {
      subject: 'user:7/client:a',
      user: { showNsfw: true, browsingLevel: ALL_LEVELS },
      expiresAt: null,
    };
  }
  if (token.startsWith('soon-token:')) {
    return {
      subject: 'user:5/client:a',
      user: { showNsfw: true, browsingLevel: ALL_LEVELS },
      expiresAt: new Date(Number(token.slice('soon-token:'.length))),
    };
  }
  const t = TOKENS[token];
  return t ? { subject: t.subject, user: t.user, expiresAt: t.expiresAt() } : null;
};

const servers: Server[] = [];
const grpcServers: grpc.Server[] = [];
afterEach(async () => {
  for (const s of grpcServers.splice(0)) s.forceShutdown();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function httpServer(a: Adapter) {
  const server = createRegistryServer(a, { verifyToken, tokenRecheckMs: 50 });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

type Response = { status: number; text: string; wwwAuthenticate: string | null };

/** One HTTP subscription: read until `done(text)` holds, the response ends, or 5s pass. */
async function get(
  port: number,
  query: string,
  headers: Record<string, string> = {},
  done: (text: string) => boolean = (t) => t.includes('event: live')
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let text = '';
  let status = 0;
  let wwwAuthenticate: string | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${query}`, { headers, signal: abort.signal });
    status = res.status;
    wwwAuthenticate = res.headers.get('www-authenticate');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (!done(text)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return { status, text, wwwAuthenticate };
}

const q = (schema: string, extra = '') => `/subscribe?schema=${encodeURIComponent(schema)}${extra}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const events = (text: string) => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
const liveCursor = (text: string) =>
  (JSON.parse(/^event: live\n(?:id:.*\n)?data: (.*)$/m.exec(text)![1]) as { cursor: string })
    .cursor;
const errorOf = (text: string) => {
  const m = /^event: error\ndata: (.*)$/m.exec(text);
  return m ? (JSON.parse(m[1]) as { error: string }).error : null;
};

describe('🔴 a document stream carries an app’s documents only to a token that may read its rating', () => {
  it.each([
    ['g', true],
    ['pg', true],
    // The site never hides a non-mature rating by browsing level, so neither does this.
    ['pg13', true],
    ['r', false],
    ['x', false],
  ])('anonymous, app rated %s: documents sent = %s', async (rating, sent) => {
    const port = await httpServer(source({ rating }).adapter);
    const res = await get(port, q(NOTES));
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
    expect(res.text.includes(DOC)).toBe(sent);
  });

  it.each([
    ['x-token', 'x', true],
    ['x-token', 'r', true],
    ['r-token', 'r', true],
    ['r-token', 'x', false],
    ['x-off-token', 'r', false],
    ['x-off-token', 'x', false],
    ['x-off-token', 'pg', true],
  ])('%s, app rated %s: documents sent = %s', async (token, rating, sent) => {
    const port = await httpServer(source({ rating }).adapter);
    const res = await get(port, q(NOTES), bearer(token));
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
    expect(res.text.includes(DOC)).toBe(sent);
  });

  it('🔴 an app re-rated upward past what the token may read: its documents arrive as deletes', async () => {
    const world = { rating: 'r' };
    const port = await httpServer(source(world).adapter);
    const rerate = setTimeout(() => (world.rating = 'x'), 50);
    try {
      const res = await get(port, q(NOTES), bearer('r-token'), (t) => t.includes('event: delete'));
      expect(events(res.text)).toEqual(['upsert', 'live', 'delete']);
      expect(res.text).toContain(`data: {"urn":"${DOC}"`);
    } finally {
      clearTimeout(rerate);
    }
  });

  it('positive control: the same re-rating leaves an X token’s stream alone', async () => {
    const world = { rating: 'r' };
    const port = await httpServer(source(world).adapter);
    const rerate = setTimeout(() => (world.rating = 'x'), 50);
    try {
      // Read for long enough that the re-rating has been polled many times over (poll is 5ms).
      const started = Date.now();
      const res = await get(
        port,
        q(NOTES),
        bearer('x-token'),
        (t) => t.includes('event: delete') || Date.now() - started > 400
      );
      expect(events(res.text).slice(0, 2)).toEqual(['upsert', 'live']);
      expect(events(res.text)).not.toContain('delete');
    } finally {
      clearTimeout(rerate);
    }
  });

  it('an app re-rated down to one the token may read: its documents arrive as upserts', async () => {
    const world = { rating: 'x' };
    const port = await httpServer(source(world).adapter);
    const rerate = setTimeout(() => (world.rating = 'r'), 50);
    try {
      const res = await get(port, q(NOTES), bearer('r-token'), (t) => t.includes('event: upsert'));
      expect(events(res.text)).toEqual(['live', 'upsert']);
      expect(res.text).toContain(DOC);
    } finally {
      clearTimeout(rerate);
    }
  });

  it('the catalog entities are not narrowed: an anonymous app stream still carries the x-rated app, tagged', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const res = await get(port, q('urn:schema:apps.civitai.com:app@v1'));
    expect(events(res.text)).toEqual(['upsert', 'live']);
    expect(res.text).toContain('"contentRating":"x"');
  });
});

describe('🔴 a cursor is tied to what its token may read', () => {
  it('a cursor issued to an X token, presented anonymously, is cursor_expired', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const issued = await get(port, q(NOTES), bearer('x-token'));
    expect(events(issued.text)).toEqual(['upsert', 'live']);
    const res = await get(port, q(NOTES, `&cursor=${encodeURIComponent(liveCursor(issued.text))}`));
    expect([res.status, JSON.parse(res.text).error]).toEqual([410, 'cursor_expired']);
  });

  it('🔴 re-bound to the anonymous request, it is still cursor_expired, and names no document', async () => {
    // The request binding is a public digest, so a holder of the cursor can re-bind it; what
    // refuses it is the audience its stored state was served to.
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const issued = await get(port, q(NOTES), bearer('x-token'));
    const inner = liveCursor(issued.text).replace(/^b1\.[0-9a-f]{24}\./, '');
    const rebound = bindCursor(inner, requestBinding({ schema: NOTES, urns: [] }));
    const res = await get(port, q(NOTES, `&cursor=${encodeURIComponent(rebound)}`));
    expect([res.status, JSON.parse(res.text).error]).toEqual([410, 'cursor_expired']);
    expect(res.text).not.toContain(DOC);
  });

  it('a cursor issued to one user, presented by another who may read the same, is cursor_expired', async () => {
    // The auth extension ties an authorized stream's cursor to its token's subject.
    const port = await httpServer(source({ rating: 'r' }).adapter);
    const issued = await get(port, q(NOTES), bearer('r-token'));
    const res = await get(
      port,
      q(NOTES, `&cursor=${encodeURIComponent(liveCursor(issued.text))}`),
      bearer('r2-token')
    );
    expect([res.status, JSON.parse(res.text).error]).toEqual([410, 'cursor_expired']);
  });

  it('positive control: the same token resumes its own cursor', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const issued = await get(port, q(NOTES), bearer('x-token'));
    const res = await get(
      port,
      q(NOTES, `&cursor=${encodeURIComponent(liveCursor(issued.text))}`),
      bearer('x-token')
    );
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(['live']);
  });
});

describe('🔴 no visibility leaks between principals through shared state', () => {
  it('an X stream and an anonymous stream open at once on one source: anonymous never sees the document', async () => {
    const { adapter, cat } = source({ rating: 'x' });
    const port = await httpServer(adapter);
    // A document change while both are open: the X stream is sent it, and the anonymous one is
    // sent nothing for it (no upsert, delete or progress).
    const change = setTimeout(() => edit(cat, 'second'), 100);
    try {
      const started = Date.now();
      const [x, anon] = await Promise.all([
        get(port, q(NOTES), bearer('x-token'), (t) => t.includes('second')),
        get(port, q(NOTES), {}, (t) => t.includes('event: live') && Date.now() - started > 600),
      ]);
      expect(events(x.text)).toEqual(['upsert', 'live', 'upsert']);
      expect(events(anon.text)).toEqual(['live']);
      expect(anon.text).not.toContain(DOC);
      expect(liveCursor(anon.text)).not.toBe(liveCursor(x.text));
    } finally {
      clearTimeout(change);
    }
  });

  it('an anonymous subscription to an app it may not read writes no state', async () => {
    const { adapter, store } = source({ rating: 'x' });
    const port = await httpServer(adapter);
    await get(port, q(NOTES));
    expect(store.puts()).toBe(0);
    // Positive control: an X token's snapshot of the same stream does write one.
    await get(port, q(NOTES), bearer('x-token'));
    expect(store.puts()).toBe(1);
  });
});

describe('🔴 tokens: invalid_token for a bad or expired one, over HTTP', () => {
  it.each([
    ['an unknown token', bearer('no-such-token')],
    ['an expired token', bearer('expired-token')],
    ['a scheme other than Bearer', { authorization: 'Basic eC10b2tlbg==' }],
  ])('%s: 401 invalid_token, with WWW-Authenticate, before any event', async (_n, headers) => {
    const port = await httpServer(source({ rating: 'pg' }).adapter);
    const res = await get(port, q(NOTES), headers);
    expect([res.status, JSON.parse(res.text).error]).toEqual([401, 'invalid_token']);
    expect(res.wwwAuthenticate).toMatch(/^Bearer error="invalid_token"/);
  });

  it('positive control: no token is anonymous, not an error', async () => {
    const port = await httpServer(source({ rating: 'pg' }).adapter);
    const res = await get(port, q(NOTES));
    expect([res.status, res.wwwAuthenticate]).toEqual([200, null]);
  });

  it('a token that expires mid-stream ends the stream with an invalid_token error event', async () => {
    const port = await httpServer(source({ rating: 'pg' }).adapter);
    const res = await get(port, q(NOTES), bearer(`soon-token:${Date.now() + 300}`), (t) =>
      t.includes('event: error')
    );
    expect(events(res.text)).toEqual(['upsert', 'live', 'error']);
    expect(errorOf(res.text)).toBe('invalid_token');
  });

  it('a token revoked mid-stream ends the stream at the next re-check, with invalid_token', async () => {
    const port = await httpServer(source({ rating: 'pg' }).adapter);
    const res = await get(port, q(NOTES), bearer(`revoked-after-first:${Math.random()}`), (t) =>
      t.includes('event: error')
    );
    expect(events(res.text)).toEqual(['upsert', 'live', 'error']);
    expect(errorOf(res.text)).toBe('invalid_token');
  });
});

const Client = grpc.makeGenericClientConstructor(SOURCE_SERVICE, 'Source');
interface SourceClient {
  Subscribe(request: unknown, metadata: grpc.Metadata): grpc.ClientReadableStream<StreamEvent>;
}

type Outcome = { events: StreamEvent[]; error?: { code: number; reason: string | null } };

/** One gRPC subscription: its events until `until` holds (then cancelled), it ends, or 5s pass. */
async function viaGrpc(
  a: Adapter,
  schema: string,
  token: string | null,
  until: (events: StreamEvent[]) => boolean = (e) => e.some((x) => x.type === 'live')
): Promise<Outcome> {
  const server = createGrpcServer(a, { verifyToken, tokenRecheckMs: 50 });
  grpcServers.push(server);
  const port = await listenGrpc(server, 0);
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const metadata = new grpc.Metadata();
  if (token !== null) metadata.set('authorization', `Bearer ${token}`);
  const subscribe = (client as unknown as SourceClient).Subscribe;
  return new Promise<Outcome>((resolve) => {
    const out: StreamEvent[] = [];
    let cancelled = false;
    const call = subscribe.call(client, { schema, cursor: '', urns: [], filter: '' }, metadata);
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      client.close();
      resolve(outcome);
    };
    const stop = () => {
      cancelled = true;
      call.cancel();
    };
    const timer = setTimeout(stop, 5_000);
    call.on('data', (e: StreamEvent) => {
      out.push(e);
      if (until(out)) stop();
    });
    call.on('error', (err: grpc.ServiceError) =>
      finish(
        cancelled && err.code === grpc.status.CANCELLED
          ? { events: out }
          : {
              events: out,
              error: { code: err.code, reason: errorInfoOf(err.metadata)?.reason ?? null },
            }
      )
    );
    call.on('end', () => finish({ events: out }));
  });
}

const shapes = (es: StreamEvent[]) =>
  es.map((e) => (e.type === 'upsert' ? `upsert ${e.entity.urn}` : e.type));

describe('🔴 the gRPC binding enforces the same', () => {
  it.each([['no-such-token'], ['expired-token']])(
    '%s: UNAUTHENTICATED with reason invalid_token, before any event',
    async (token) => {
      const res = await viaGrpc(source({ rating: 'pg' }).adapter, NOTES, token);
      expect(res.events).toEqual([]);
      expect(res.error).toEqual({ code: grpc.status.UNAUTHENTICATED, reason: 'invalid_token' });
    }
  );

  it('parity: each principal is sent over gRPC exactly what it is sent over HTTP', async () => {
    const { adapter } = source({ rating: 'x' });
    const port = await httpServer(adapter);
    for (const token of [null, 'r-token', 'x-token']) {
      const overGrpc = await viaGrpc(adapter, NOTES, token);
      const overHttp = await get(port, q(NOTES), token ? bearer(token) : {});
      const httpShapes = [
        ...overHttp.text.matchAll(/^event: (\w+)\n(?:id:.*\n)?data: (.*)$/gm),
      ].map((m) =>
        m[1] === 'upsert'
          ? `upsert ${(JSON.parse(m[2]) as { entity: { urn: string } }).entity.urn}`
          : m[1]
      );
      expect([token, shapes(overGrpc.events)]).toEqual([token, httpShapes]);
    }
    // Positive control on the comparison itself: the principals were not all sent the same.
    expect(shapes((await viaGrpc(adapter, NOTES, 'x-token')).events)).toEqual([
      `upsert ${DOC}`,
      'live',
    ]);
    expect(shapes((await viaGrpc(adapter, NOTES, null)).events)).toEqual(['live']);
  });

  it('a token that expires mid-stream ends the call UNAUTHENTICATED / invalid_token', async () => {
    const res = await viaGrpc(
      source({ rating: 'pg' }).adapter,
      NOTES,
      `soon-token:${Date.now() + 300}`,
      () => false
    );
    expect(shapes(res.events)).toEqual([`upsert ${DOC}`, 'live']);
    expect(res.error).toEqual({ code: grpc.status.UNAUTHENTICATED, reason: 'invalid_token' });
  });
});
