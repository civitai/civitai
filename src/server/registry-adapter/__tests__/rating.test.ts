import * as grpc from '@grpc/grpc-js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { Principal, Recheck } from '~/server/registry-adapter/auth';
import {
  ANONYMOUS_AUDIENCE,
  audienceAdmits,
  audienceForUser,
} from '~/server/registry-adapter/audience';
import { watchPrincipal } from '~/server/registry-adapter/auth';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import {
  SERVED_SCHEMAS,
  appContentRating,
  buildEntities,
  readableBy,
} from '~/server/registry-adapter/entities';
import {
  REGISTRY_SERVICE,
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

/**
 * The one listed app, whose `notes` collection is exported at @v1. Its listing is rated `rating`
 * and its block `blockRating`, the same by default. The block's column is never null, so a block
 * with no rating is `''`.
 */
function app(rating: string | null, blockRating: string = rating ?? ''): CatalogApp {
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
      contentRating: blockRating,
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
function source(world: { rating: string | null; blockRating?: string }) {
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
  const readApps = async () => [app(world.rating, world.blockRating)];
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
  // X readable at connect; then the user switches mature content off (the site serves them PG).
  if (token.startsWith('lowered-after-first:')) {
    const first = !verified.has(token);
    verified.add(token);
    return {
      subject: 'user:8/client:a',
      user: { showNsfw: first, browsingLevel: ALL_LEVELS },
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

  // A rating this source does not know may be a mature one, so it fails closed: only an audience
  // that may read R and X is sent the app's documents.
  it.each([
    [null, 'unrated', false],
    ['r-token', 'unrated', false],
    ['x-off-token', 'unrated', false],
    ['x-token', 'unrated', true],
    [null, '', false],
    ['x-token', '', true],
    // No rating at all: the listing's is null and the block's column is empty.
    [null, null, false],
    ['r-token', null, false],
    ['x-token', null, true],
  ])(
    'token %s, app rated %j (not a known rating): documents sent = %s',
    async (token, rating, sent) => {
      const port = await httpServer(source({ rating }).adapter);
      const res = await get(port, q(NOTES), token ? bearer(token) : {});
      expect(res.status).toBe(200);
      expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
      expect(res.text.includes(DOC)).toBe(sent);
    }
  );

  // A listing rating that is empty, whitespace or unknown falls through to the block's, so it
  // never hides a valid one; only when neither is known does the app fail closed.
  it.each<[string, string, string | null, boolean]>([
    ['', 'g', null, true],
    ['  ', 'pg', null, true],
    ['unrated', 'g', null, true],
    ['', 'r', null, false],
    ['', 'r', 'r-token', true],
    ['', '', 'r-token', false],
  ])(
    'listing rated %j, block rated %j, token %s: documents sent = %s',
    async (rating, blockRating, token, sent) => {
      const port = await httpServer(source({ rating, blockRating }).adapter);
      const res = await get(port, q(NOTES), token ? bearer(token) : {});
      expect(res.status).toBe(200);
      expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
      expect(res.text.includes(DOC)).toBe(sent);
    }
  );

  // Each re-rating below is made when the stream reaches `live`, from the reader's own progress,
  // never on a wall-clock timer: the snapshot is the old rating's, and every poll after `live`
  // reads the new one.
  it('🔴 an app re-rated upward past what the token may read: its documents arrive as deletes', async () => {
    const world = { rating: 'r' };
    const port = await httpServer(source(world).adapter);
    const res = await get(port, q(NOTES), bearer('r-token'), (t) => {
      if (t.includes('event: live')) world.rating = 'x';
      return t.includes('event: delete');
    });
    expect(events(res.text)).toEqual(['upsert', 'live', 'delete']);
    expect(res.text).toContain(`data: {"urn":"${DOC}"`);
  });

  it('positive control: the same re-rating leaves an X token’s stream alone', async () => {
    const world = { rating: 'r' };
    const { adapter, cat } = source(world);
    const port = await httpServer(adapter);
    // Re-rated at `live`; once the stream carries the edit made after that, edit again. The poll
    // that sends the second edit began after the first edit was received, so after the re-rating:
    // reaching it proves the stream was polled under the new rating, with no clock involved.
    let step = 0;
    const res = await get(port, q(NOTES), bearer('x-token'), (t) => {
      if (step === 0 && t.includes('event: live')) {
        step = 1;
        world.rating = 'x';
        edit(cat, 'second');
      }
      if (step === 1 && t.includes('"second"')) {
        step = 2;
        edit(cat, 'third');
      }
      return t.includes('"third"') || t.includes('event: delete');
    });
    expect(events(res.text)).toEqual(['upsert', 'live', 'upsert', 'upsert']);
    expect(res.text).toContain('"third"');
  });

  it('an app re-rated down to one the token may read: its documents arrive as upserts', async () => {
    const world = { rating: 'x' };
    const port = await httpServer(source(world).adapter);
    const res = await get(port, q(NOTES), bearer('r-token'), (t) => {
      if (t.includes('event: live')) world.rating = 'r';
      return t.includes('event: upsert');
    });
    expect(events(res.text)).toEqual(['live', 'upsert']);
    expect(res.text).toContain(DOC);
  });
});

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const RELEASES = 'urn:schema:apps.civitai.com:app-release@v1';
const SERVICES = 'urn:schema:apps.civitai.com:service@v1';
const APP_URN = 'urn:apps.civitai.com:app/orbit-notes';
const RELEASE_URN = 'urn:apps.civitai.com:app/orbit-notes@1.0.0';
const deleted = (text: string) =>
  [...text.matchAll(/^event: delete\n(?:id:.*\n)?data: (.*)$/gm)].map(
    (m) => (JSON.parse(m[1]) as { urn: string }).urn
  );

describe('🔴 the catalog’s app and release streams carry an app only to a token that may read its rating', () => {
  it.each([
    [APPS, 'g', true],
    [APPS, 'pg', true],
    [APPS, 'pg13', true],
    [APPS, 'r', false],
    [APPS, 'x', false],
    [RELEASES, 'pg', true],
    [RELEASES, 'r', false],
    [RELEASES, 'x', false],
  ])('anonymous, %s, app rated %s: sent = %s', async (schema, rating, sent) => {
    const port = await httpServer(source({ rating }).adapter);
    const res = await get(port, q(schema));
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
    // Not even named: the release body names its app, and the app its release.
    expect(res.text.includes('orbit-notes')).toBe(sent);
  });

  it.each([
    [APPS, 'r-token', 'r', true],
    [APPS, 'r-token', 'x', false],
    [APPS, 'x-token', 'x', true],
    [APPS, 'x-off-token', 'r', false],
    [RELEASES, 'r-token', 'r', true],
    [RELEASES, 'r-token', 'x', false],
    [RELEASES, 'x-token', 'x', true],
  ])('%s, %s, app rated %s: sent = %s', async (schema, token, rating, sent) => {
    const port = await httpServer(source({ rating }).adapter);
    const res = await get(port, q(schema), bearer(token));
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(sent ? ['upsert', 'live'] : ['live']);
    expect(res.text.includes(schema === APPS ? `"urn":"${APP_URN}"` : RELEASE_URN)).toBe(sent);
  });

  it('the R token’s app entity is still tagged with its rating', async () => {
    const port = await httpServer(source({ rating: 'r' }).adapter);
    const res = await get(port, q(APPS), bearer('r-token'));
    expect(res.text).toContain('"contentRating":"r"');
  });

  it('the service stream holds no app, so it is the same for anonymous as for an X token', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const anon = await get(port, q(SERVICES));
    const x = await get(port, q(SERVICES), bearer('x-token'));
    expect(events(anon.text)).toEqual(['upsert', 'live']);
    expect(anon.text).toContain('urn:apps.civitai.com:runtime/iframe@1');
    expect(events(x.text)).toEqual(events(anon.text));
  });

  it.each([
    [APPS, APP_URN],
    [RELEASES, RELEASE_URN],
  ])(
    '🔴 %s: an app re-rated from pg to r reaches the anonymous stream as a delete',
    async (schema, urn) => {
      const world = { rating: 'pg' };
      const port = await httpServer(source(world).adapter);
      // Re-rated once the stream is live, so the snapshot is pg's and the change is the poll's.
      const res = await get(port, q(schema), {}, (t) => {
        if (t.includes('event: live')) world.rating = 'r';
        return t.includes('event: delete');
      });
      expect(events(res.text)).toEqual(['upsert', 'live', 'delete']);
      expect(deleted(res.text)).toEqual([urn]);
    }
  );

  it('positive control: the same re-rating removes nothing from an R token’s app stream, which is sent the new tag', async () => {
    const world = { rating: 'pg' };
    const port = await httpServer(source(world).adapter);
    const res = await get(port, q(APPS), bearer('r-token'), (t) => {
      if (t.includes('event: live')) world.rating = 'r';
      return t.includes('"contentRating":"r"');
    });
    expect(events(res.text)).toEqual(['upsert', 'live', 'upsert']);
    expect(deleted(res.text)).toEqual([]);
  });

  it.each([
    [APPS, APP_URN],
    [RELEASES, RELEASE_URN],
  ])(
    '%s: an app re-rated from r to pg reaches the anonymous stream as an upsert',
    async (schema, urn) => {
      const world = { rating: 'r' };
      const port = await httpServer(source(world).adapter);
      const res = await get(port, q(schema), {}, (t) => {
        if (t.includes('event: live')) world.rating = 'pg';
        return t.includes('event: upsert');
      });
      expect(events(res.text)).toEqual(['live', 'upsert']);
      expect(res.text).toContain(`"urn":"${urn}"`);
    }
  );

  it('🔴 a cursor issued to an R token, re-bound to the anonymous request, is cursor_expired and names no app', async () => {
    const port = await httpServer(source({ rating: 'r' }).adapter);
    const issued = await get(port, q(APPS), bearer('r-token'));
    expect(events(issued.text)).toEqual(['upsert', 'live']);
    const inner = liveCursor(issued.text).replace(/^b1\.[0-9a-f]{24}\./, '');
    const rebound = bindCursor(inner, requestBinding({ schema: APPS, urns: [] }));
    const res = await get(port, q(APPS, `&cursor=${encodeURIComponent(rebound)}`));
    expect([res.status, JSON.parse(res.text).error]).toEqual([410, 'cursor_expired']);
    expect(res.text).not.toContain('orbit-notes');
  });

  it('positive control: the R token resumes its own app cursor', async () => {
    const port = await httpServer(source({ rating: 'r' }).adapter);
    const issued = await get(port, q(APPS), bearer('r-token'));
    const res = await get(
      port,
      q(APPS, `&cursor=${encodeURIComponent(liveCursor(issued.text))}`),
      bearer('r-token')
    );
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(['live']);
  });

  it('the same served set names a different cursor per audience', async () => {
    // A pg app: anonymous and an X token are sent the same entities, under their own cursors.
    const port = await httpServer(source({ rating: 'pg' }).adapter);
    const anon = await get(port, q(APPS));
    const x = await get(port, q(APPS), bearer('x-token'));
    const inner = (t: string) => liveCursor(t).replace(/^b1\.[0-9a-f]{24}\./, '');
    expect(events(anon.text)).toEqual(events(x.text));
    expect(inner(anon.text)).not.toBe(inner(x.text));
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

  it('🔴 a user who lowers their ratings mid-stream has the stream ended with cursor_expired, and re-snapshots under the new ones', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const token = `lowered-after-first:${Math.random()}`;
    const res = await get(port, q(NOTES), bearer(token), (t) => t.includes('event: error'));
    expect(events(res.text)).toEqual(['upsert', 'live', 'error']);
    expect(errorOf(res.text)).toBe('cursor_expired');
    // Starting over, as cursor_expired tells the consumer to: the x app's document is gone.
    const again = await get(port, q(NOTES), bearer(token));
    expect(events(again.text)).toEqual(['live']);
  });

  it('positive control: a re-check that finds the same ratings leaves the stream open', async () => {
    const port = await httpServer(source({ rating: 'x' }).adapter);
    const started = Date.now();
    // Many re-checks (every ~50ms) pass in this window.
    const res = await get(
      port,
      q(NOTES),
      bearer('x-token'),
      (t) => t.includes('event: error') || Date.now() - started > 600
    );
    expect(events(res.text)).toEqual(['upsert', 'live']);
  });
});

const Client = grpc.makeGenericClientConstructor(REGISTRY_SERVICE, 'Registry');
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

  it.each([
    [APPS, null, []],
    [APPS, 'r-token', [`upsert ${APP_URN}`]],
    [RELEASES, null, []],
    [RELEASES, 'r-token', [`upsert ${RELEASE_URN}`]],
  ])('catalog %s, app rated r, token %s: sent %j', async (schema, token, sent) => {
    const res = await viaGrpc(source({ rating: 'r' }).adapter, schema, token);
    expect(shapes(res.events)).toEqual([...sent, 'live']);
  });

  it('🔴 catalog: an app re-rated from pg to r reaches the anonymous call as a delete', async () => {
    const world = { rating: 'pg' };
    const res = await viaGrpc(source(world).adapter, APPS, null, (es) => {
      if (es.some((e) => e.type === 'live')) world.rating = 'r';
      return es.some((e) => e.type === 'delete');
    });
    expect(shapes(res.events)).toEqual([`upsert ${APP_URN}`, 'live', 'delete']);
    expect(res.events.flatMap((e) => (e.type === 'delete' ? [e.urn] : []))).toEqual([APP_URN]);
  });

  it('catalog: an app re-rated from r to pg reaches the anonymous call as an upsert', async () => {
    const world = { rating: 'r' };
    const res = await viaGrpc(source(world).adapter, RELEASES, null, (es) => {
      if (es.some((e) => e.type === 'live')) world.rating = 'pg';
      return es.some((e) => e.type === 'upsert');
    });
    expect(shapes(res.events)).toEqual(['live', `upsert ${RELEASE_URN}`]);
  });
});

describe('the re-check is jittered, so streams opened together do not re-check together', () => {
  it.each([
    [0, 800],
    [0.5, 1000],
    [1, 1200],
  ])(
    'random() = %s: the first re-check runs at %sms of a 1000ms period, not before',
    async (r, at) => {
      vi.useFakeTimers();
      try {
        let calls = 0;
        const principal: Principal = {
          subject: 'user:9/client:a',
          audience: ANONYMOUS_AUDIENCE,
          expiresAt: null,
          recheck: async (): Promise<Recheck> => {
            calls++;
            return 'active';
          },
        };
        const stop = watchPrincipal(principal, () => undefined, {
          recheckMs: 1000,
          random: () => r,
        });
        await vi.advanceTimersByTimeAsync(at - 1);
        expect(calls).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls).toBe(1);
        stop();
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

// The schema stream: the root, JSON Schema 2020-12's own meta-schema.
const SCHEMAS = 'https://json-schema.org/draft/2020-12/schema';
const FIXED_SCHEMA_URNS = [APPS, RELEASES, SERVICES];
const urnOfApp = (slug: string) => `urn:apps.civitai.com:app/${slug}`;
const releaseOf = (slug: string) => `urn:apps.civitai.com:app/${slug}@1.0.0`;
const notesSchemaOf = (slug: string) => `urn:schema:apps.civitai.com:${slug}/notes@v1`;

/** A listed on-site app with one approved release and an exported `notes` collection. */
function listedApp(slug: string, rating: string, forkOf: string | null = null): CatalogApp {
  const m = { blockId: slug, storage: { collections: { notes } } };
  const base = app(rating);
  return {
    listing: { ...base.listing, slug, name: slug, forkOf },
    block: { ...base.block!, id: `ab_${slug}`, blockId: slug, manifest: m },
    approved: base.approved.map((r) => ({ ...r, id: `pubreq_${slug}`, manifest: m })),
  };
}

/** The entity streams alone, over whatever apps `apps()` returns at each read. */
function catalogSource(apps: () => CatalogApp[]): Adapter {
  return createPollingAdapter({
    namespace: 'apps.civitai.com',
    serves: SERVED_SCHEMAS,
    read: async () =>
      buildEntities(apps(), { baseUrl: 'https://civitai.example', features: SWITCH_ON }),
    store: createMemorySnapshotStore(),
    pollMs: 5,
    sleep: abortableSleep,
  });
}

type Sent = { event: string; urn: string; body?: Record<string, unknown> };
/** Every complete event in order, with the URN it names (and an upsert's entity body). */
const sent = (text: string): Sent[] =>
  [...text.matchAll(/^event: (\w+)\n(?:id:.*\n)?data: (.*)\n\n/gm)].map((m) => {
    const data = JSON.parse(m[2]) as {
      urn?: string;
      entity?: { urn: string; body: Record<string, unknown> };
    };
    return m[1] === 'upsert'
      ? { event: 'upsert', urn: data.entity!.urn, body: data.entity!.body }
      : { event: m[1], urn: data.urn ?? '' };
  });
const upsertedUrns = (text: string) =>
  sent(text)
    .filter((s) => s.event === 'upsert')
    .map((s) => s.urn)
    .sort();
/** What was sent after `live`; nothing while `live` has not been sent. */
const afterLive = (text: string) => {
  const all = sent(text);
  const live = all.findIndex((s) => s.event === 'live');
  return live < 0 ? [] : all.slice(live + 1);
};

const X_AUDIENCE = audienceForUser({ showNsfw: true, browsingLevel: ALL_LEVELS });

describe('🔴 two apps of different ratings: each audience is sent exactly the ones it may read', () => {
  const both = () => [listedApp('sun-notes', 'pg'), listedApp('moon-notes', 'r')];

  it.each([
    [APPS, null, [urnOfApp('sun-notes')]],
    [APPS, 'r-token', [urnOfApp('moon-notes'), urnOfApp('sun-notes')]],
    [RELEASES, null, [releaseOf('sun-notes')]],
    [RELEASES, 'r-token', [releaseOf('moon-notes'), releaseOf('sun-notes')]],
  ])('%s, token %s: sent exactly %j', async (schema, token, urns) => {
    const port = await httpServer(catalogSource(both));
    const res = await get(port, q(schema), token ? bearer(token) : {});
    expect(upsertedUrns(res.text)).toEqual(urns);
    if (token === null) expect(res.text).not.toContain('moon-notes');
  });
});

describe('🔴 readableBy fails closed on a release whose app is not in the read', () => {
  it('a release naming an absent app is not returned, even to the widest audience', () => {
    const sets = buildEntities([listedApp('sun-notes', 'pg')], {
      baseUrl: 'https://civitai.example',
      features: SWITCH_ON,
    });
    const ghost = releaseOf('ghost-notes');
    sets.get(RELEASES)!.push({
      urn: ghost,
      schemas: [RELEASES],
      rev: '0123456789abcdef',
      body: { app: urnOfApp('ghost-notes'), version: '1.0.0' },
    });
    // Positive control: the same set's release of a present app is returned.
    expect(readableBy(sets, RELEASES, X_AUDIENCE).map((e) => e.urn)).toEqual([
      releaseOf('sun-notes'),
    ]);
    expect(readableBy(sets, RELEASES, ANONYMOUS_AUDIENCE).map((e) => e.urn)).toEqual([
      releaseOf('sun-notes'),
    ]);
  });
});

describe('🔴 the schema stream carries an app’s collection schemas only to a token that may read its rating', () => {
  const both = () => [listedApp('sun-notes', 'pg'), listedApp('moon-notes', 'r')];

  it('anonymous: the fixed entity schemas and the pg app’s collection schema, and the r app is never named', async () => {
    const port = await httpServer(catalogSource(both));
    const res = await get(port, q(SCHEMAS));
    expect(upsertedUrns(res.text)).toEqual(
      [...FIXED_SCHEMA_URNS, notesSchemaOf('sun-notes')].sort()
    );
    expect(res.text).not.toContain('moon-notes');
  });

  it('an R token: both apps’ collection schemas and the fixed ones', async () => {
    const port = await httpServer(catalogSource(both));
    const res = await get(port, q(SCHEMAS), bearer('r-token'));
    expect(upsertedUrns(res.text)).toEqual(
      [...FIXED_SCHEMA_URNS, notesSchemaOf('moon-notes'), notesSchemaOf('sun-notes')].sort()
    );
  });

  it('🔴 an app re-rated from pg to r: its collection schema reaches the anonymous stream as a delete', async () => {
    const world = { rating: 'pg' };
    const port = await httpServer(
      catalogSource(() => [listedApp('sun-notes', 'pg'), listedApp('moon-notes', world.rating)])
    );
    const res = await get(port, q(SCHEMAS), {}, (t) => {
      if (t.includes('event: live')) world.rating = 'r';
      return t.includes('event: delete');
    });
    expect(afterLive(res.text)).toEqual([{ event: 'delete', urn: notesSchemaOf('moon-notes') }]);
  });

  it('🔴 a schema-stream cursor issued to an R token, re-bound to the anonymous request, is cursor_expired and names no app', async () => {
    const port = await httpServer(catalogSource(both));
    const issued = await get(port, q(SCHEMAS), bearer('r-token'));
    expect(issued.text).toContain(notesSchemaOf('moon-notes'));
    const inner = liveCursor(issued.text).replace(/^b1\.[0-9a-f]{24}\./, '');
    const rebound = bindCursor(inner, requestBinding({ schema: SCHEMAS, urns: [] }));
    const res = await get(port, q(SCHEMAS, `&cursor=${encodeURIComponent(rebound)}`));
    expect([res.status, JSON.parse(res.text).error]).toEqual([410, 'cursor_expired']);
    expect(res.text).not.toContain('moon-notes');
  });

  it('positive control: the R token resumes its own schema-stream cursor', async () => {
    const port = await httpServer(catalogSource(both));
    const issued = await get(port, q(SCHEMAS), bearer('r-token'));
    const res = await get(
      port,
      q(SCHEMAS, `&cursor=${encodeURIComponent(liveCursor(issued.text))}`),
      bearer('r-token')
    );
    expect(res.status).toBe(200);
    expect(events(res.text)).toEqual(['live']);
  });
});

describe('🔴 a fork names its parent only to an audience that may read the parent', () => {
  // The fork's URN sorts before its parent's, so in one poll's batch the fork's change comes
  // first: reading until the parent's change has been sent has seen the fork's, if there is one.
  const FORK = urnOfApp('echo-fork');
  const PARENT = urnOfApp('moon-notes');
  const world = (parent: string) => ({ parent });
  const apps = (w: { parent: string }) => () =>
    [listedApp('echo-fork', 'pg', 'moon-notes'), listedApp('moon-notes', w.parent)];
  const forkBody = (text: string) =>
    sent(text).find((s) => s.event === 'upsert' && s.urn === FORK)!.body!;

  it.each([
    [null, false],
    ['r-token', true],
  ])('parent rated r, token %s: forkOf sent = %s', async (token, named) => {
    const port = await httpServer(catalogSource(apps(world('r'))));
    const res = await get(port, q(APPS), token ? bearer(token) : {});
    expect(upsertedUrns(res.text)).toEqual(named ? [FORK, PARENT] : [FORK]);
    expect(forkBody(res.text).forkOf).toBe(named ? PARENT : undefined);
    expect(res.text.includes('moon-notes')).toBe(named);
  });

  it('positive control: a pg parent is named to anonymous', async () => {
    const port = await httpServer(catalogSource(apps(world('pg'))));
    const res = await get(port, q(APPS));
    expect(forkBody(res.text).forkOf).toBe(PARENT);
  });

  it('🔴 the parent re-rated from pg to r: anonymous is sent the parent’s delete and the fork without forkOf', async () => {
    const w = world('pg');
    const port = await httpServer(catalogSource(apps(w)));
    const res = await get(port, q(APPS), {}, (t) => {
      if (t.includes('event: live')) w.parent = 'r';
      return afterLive(t).some((s) => s.event === 'upsert');
    });
    const after = afterLive(res.text);
    expect(after.map((s) => `${s.event} ${s.urn}`)).toEqual([`delete ${PARENT}`, `upsert ${FORK}`]);
    expect(after[1].body).not.toHaveProperty('forkOf');
    expect(after[1].body).toMatchObject({ slug: 'echo-fork', contentRating: 'pg' });
  });

  it('the parent re-rated from r to pg: anonymous is sent the fork with forkOf, and the parent', async () => {
    const w = world('r');
    const port = await httpServer(catalogSource(apps(w)));
    const res = await get(port, q(APPS), {}, (t) => {
      if (t.includes('event: live')) w.parent = 'pg';
      return afterLive(t).some((s) => s.urn === PARENT);
    });
    const after = afterLive(res.text);
    expect(after.map((s) => `${s.event} ${s.urn}`)).toEqual([`upsert ${FORK}`, `upsert ${PARENT}`]);
    expect(after[0].body!.forkOf).toBe(PARENT);
  });

  it('positive control: the same pg-to-r re-rating re-sends an R token only the parent, whose fork body is unchanged', async () => {
    const w = world('pg');
    const port = await httpServer(catalogSource(apps(w)));
    const res = await get(port, q(APPS), bearer('r-token'), (t) => {
      if (t.includes('event: live')) w.parent = 'r';
      return afterLive(t).some((s) => s.urn === PARENT);
    });
    expect(afterLive(res.text).map((s) => `${s.event} ${s.urn}`)).toEqual([`upsert ${PARENT}`]);
    expect(forkBody(res.text).forkOf).toBe(PARENT);
  });
});

describe('🔴 audienceAdmits fails closed on a rating this source does not know', () => {
  const R_AUDIENCE = audienceForUser({ showNsfw: true, browsingLevel: UP_TO_R });
  const audiences = { anonymous: ANONYMOUS_AUDIENCE, r: R_AUDIENCE, x: X_AUDIENCE };
  it.each<[string | null | undefined, boolean, boolean, boolean]>([
    // [rating, anonymous, r, x]
    ['g', true, true, true],
    ['pg13', true, true, true],
    ['PG', true, true, true],
    ['r', false, true, true],
    ['R', false, true, true],
    ['x', false, false, true],
    [null, false, false, true],
    [undefined, false, false, true],
    ['', false, false, true],
    ['unrated', false, false, true],
    ['pg-13', false, false, true],
  ])('rating %j: anonymous %s, R %s, X %s', (rating, anon, r, x) => {
    expect([
      audienceAdmits(audiences.anonymous, rating),
      audienceAdmits(audiences.r, rating),
      audienceAdmits(audiences.x, rating),
    ]).toEqual([anon, r, x]);
  });
});

describe('appContentRating: the listing’s rating when known, else the block’s', () => {
  const rated = (listing: string | null, block: string | null) =>
    appContentRating({
      listing: { ...app('pg').listing, contentRating: listing },
      block: block === null ? null : { ...app('pg').block!, contentRating: block },
    });
  it.each<[string | null, string | null, string | null]>([
    // [listing, block, published]
    ['x', 'pg13', 'x'],
    [null, 'pg13', 'pg13'],
    ['', 'g', 'g'],
    ['   ', 'g', 'g'],
    ['unrated', 'g', 'g'],
    ['R', 'g', 'R'],
    ['pg', null, 'pg'],
    // Neither known: the first one set, else null; both fail closed (`audienceAdmits`).
    ['unrated', '', 'unrated'],
    ['', 'pg-13', 'pg-13'],
    ['', '', null],
    [null, null, null],
  ])('listing %j, block %j: %j', (listing, block, published) => {
    expect(rated(listing, block)).toBe(published);
  });
});

describe('🔴 an app with no rating reaches only an audience that may read every rating', () => {
  // An off-site listing whose rating was never set: no block to fall back to, so the app entity's
  // `contentRating` is null.
  const unrated = (slug: string, rating: string | null): CatalogApp => {
    const base = app('pg');
    return {
      listing: {
        ...base.listing,
        slug,
        name: slug,
        kind: 'offsite',
        contentRating: rating,
        externalUrl: `https://${slug}.example`,
      },
      block: null,
      approved: [],
    };
  };
  const apps = (rating: string | null) => () =>
    [listedApp('sun-notes', 'pg'), unrated('tide-log', rating)];

  it.each([
    [null, false],
    ['r-token', false],
    ['x-off-token', false],
    ['x-token', true],
  ])('an off-site app rated null, token %s: sent = %s', async (token, sent) => {
    const port = await httpServer(catalogSource(apps(null)));
    const res = await get(port, q(APPS), token ? bearer(token) : {});
    expect(upsertedUrns(res.text)).toEqual(
      sent ? [urnOfApp('sun-notes'), urnOfApp('tide-log')] : [urnOfApp('sun-notes')]
    );
    expect(res.text.includes('tide-log')).toBe(sent);
  });

  it('positive control: the same off-site app rated pg is sent to anonymous', async () => {
    const port = await httpServer(catalogSource(apps('pg')));
    const res = await get(port, q(APPS));
    expect(upsertedUrns(res.text)).toEqual([urnOfApp('sun-notes'), urnOfApp('tide-log')]);
  });
});
