import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEVER_BATCH_PROCEDURES, setTrpcBatchingEnabled, trpcVanilla } from '~/utils/trpc';
import {
  GO_TRANSPORT_PROCEDURES,
  GO_TRANSPORT_URL,
  setFeedGoTransportEnabled,
  setFeedGoTransportInfiniteEnabled,
  setFeedGoTransportModelGetAllEnabled,
} from '~/utils/trpc-go-transport';

/**
 * WIRE-LEVEL coverage for the Go-transport flags (`feedGoTransport`, `feedGoTransportModelGetAll`,
 * `feedGoTransportInfinite`): with one on, a signed-in browser sends THAT procedure to
 * `/api/trpc-go/…` instead of `/api/trpc/…`; everything else is unchanged. Drives the real `trpcVanilla` link chain over a stubbed `fetch` and asserts on the URL it
 * actually requested, as trpc-block-token-transport.test.ts does.
 */

type Sent = { url: string; method: string };
let sent: Sent[] = [];

const FEED = 'image.getImagesAsPostsInfinite';
const FEED_INPUT = { modelId: 1, modelVersionId: 2, limit: 50 };
const ORDINARY = 'model.getById';
const ORDINARY_INPUT = { id: 1 };
const MODELS = 'model.getAll';
const MODELS_INPUT = { sort: 'Newest', limit: 20, browsingLevel: 1 };
const IMAGES = 'image.getInfinite';
const IMAGES_INPUT = { limit: 50, browsingLevel: 1, period: 'Week' };

beforeEach(() => {
  sent = [];
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  setFeedGoTransportInfiniteEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });
      return new Response(JSON.stringify({ result: { data: { json: null } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  setFeedGoTransportInfiniteEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

async function callQuery(path: string, input: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.query(input);
  } catch {
    // Only the request matters.
  }
}

const signIn = () => {
  (globalThis as { window?: unknown }).window = { isAuthed: true };
};

// The path the edge route matches: the talos-infra IngressRoute feed-go routes exactly
// `/api/trpc-go/<procedure>` to the Go service, so this constant must stay that literal.
it('GO_TRANSPORT_URL is the edge route prefix /api/trpc-go', () => {
  expect(GO_TRANSPORT_URL).toBe('/api/trpc-go');
});

// Literal: each of these has its own flag and its own exact edge route; a procedure added or dropped
// here without its route (or route without it) must be a visible change.
it('the Go-transport procedures are exactly these three', () => {
  expect([...GO_TRANSPORT_PROCEDURES].sort()).toEqual([
    'image.getImagesAsPostsInfinite',
    'image.getInfinite',
    'model.getAll',
  ]);
});

it('every Go-transport procedure is also never batched (a batched path cannot be routed)', () => {
  expect(GO_TRANSPORT_PROCEDURES.size).toBeGreaterThan(0);
  for (const path of GO_TRANSPORT_PROCEDURES) expect(NEVER_BATCH_PROCEDURES.has(path)).toBe(true);
});

/**
 * The `next.config.mjs` rewrite that sends `GO_TRANSPORT_URL` back to `/api/trpc`. Reads the real
 * config export and runs Next's own path matcher, so the check is on what Next will serve, not on
 * the file's text. A wildcard source would make `/api/trpc-go/*` an alias of every procedure.
 */
describe('the /api/trpc-go rewrite', () => {
  type Rewrite = { source: string; destination: string };
  const loadRewrites = async (): Promise<Rewrite[]> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextConfig = (await import('../../../next.config.mjs')).default as any;
    return (await nextConfig.rewrites()) as Rewrite[];
  };
  const goRewrites = (rewrites: Rewrite[]) =>
    rewrites.filter((r) => r.source.startsWith(`${GO_TRANSPORT_URL}/`));
  const rewriteFor = (rewrites: Rewrite[], pathname: string) =>
    goRewrites(rewrites).find((r) => getPathMatch(r.source)(pathname) !== false);

  it('covers exactly GO_TRANSPORT_PROCEDURES, each back to its own /api/trpc path', async () => {
    const rewrites = goRewrites(await loadRewrites());
    expect(rewrites.length).toBeGreaterThan(0);
    expect(rewrites.map((r) => r.source).sort()).toEqual(
      [...GO_TRANSPORT_PROCEDURES].map((p) => `${GO_TRANSPORT_URL}/${p}`).sort()
    );
    for (const p of GO_TRANSPORT_PROCEDURES) {
      expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${p}`)?.destination).toBe(`/api/trpc/${p}`);
    }
  });

  it('does not alias any other procedure under /api/trpc-go', async () => {
    const rewrites = await loadRewrites();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${FEED}`)).toBeDefined(); // positive control
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${ORDINARY}`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/user.getSettings`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${FEED},${ORDINARY}`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${MODELS},${ORDINARY}`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/model.getAllPagedSimple`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${IMAGES},${ORDINARY}`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/image.getInfiniteImages`)).toBeUndefined();
    expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/image.get`)).toBeUndefined();
  });

  it('sends /api/trpc-go/image.getInfinite back to /api/trpc/image.getInfinite (literal paths)', async () => {
    const rewrites = await loadRewrites();
    expect(rewriteFor(rewrites, '/api/trpc-go/image.getInfinite')?.destination).toBe(
      '/api/trpc/image.getInfinite'
    );
  });

  it('sends /api/trpc-go/model.getAll back to /api/trpc/model.getAll (literal paths)', async () => {
    const rewrites = await loadRewrites();
    expect(rewriteFor(rewrites, '/api/trpc-go/model.getAll')?.destination).toBe(
      '/api/trpc/model.getAll'
    );
    expect(rewriteFor(rewrites, '/api/trpc-go/image.getImagesAsPostsInfinite')?.destination).toBe(
      '/api/trpc/image.getImagesAsPostsInfinite'
    );
  });

  // Local dev: `pnpm dev` (scripts/dev-feed-go/launcher.mjs) sets FEED_GO_LOCAL_URL to its loopback
  // proxy in front of a local feed-go. `rewrites()` reads it per call, so each case sets it first.
  describe('with FEED_GO_LOCAL_URL (local dev feed-go)', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('sends each procedure to <local>/api/trpc/<procedure> (literal paths)', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('FEED_GO_LOCAL_URL', 'http://127.0.0.1:43123');
      const rewrites = await loadRewrites();
      expect(rewriteFor(rewrites, '/api/trpc-go/image.getImagesAsPostsInfinite')?.destination).toBe(
        'http://127.0.0.1:43123/api/trpc/image.getImagesAsPostsInfinite'
      );
      expect(rewriteFor(rewrites, '/api/trpc-go/model.getAll')?.destination).toBe(
        'http://127.0.0.1:43123/api/trpc/model.getAll'
      );
      expect(rewriteFor(rewrites, '/api/trpc-go/image.getInfinite')?.destination).toBe(
        'http://127.0.0.1:43123/api/trpc/image.getInfinite'
      );
      // Still exact sources: no other procedure is aliased to feed-go.
      expect(rewriteFor(rewrites, `${GO_TRANSPORT_URL}/${ORDINARY}`)).toBeUndefined();
    });

    it('is ignored in production (a built app never carries it)', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('FEED_GO_LOCAL_URL', 'http://127.0.0.1:43123');
      const rewrites = await loadRewrites();
      expect(rewriteFor(rewrites, '/api/trpc-go/image.getImagesAsPostsInfinite')?.destination).toBe(
        '/api/trpc/image.getImagesAsPostsInfinite'
      );
    });

    it('is ignored unless it is a bare loopback http origin', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      for (const url of [
        'http://feed-go.example.com:8080',
        'https://127.0.0.1:43123',
        'http://127.0.0.1',
        'http://127.0.0.1:43123/elsewhere',
        'http://user:pw@127.0.0.1:43123',
        'not a url',
      ]) {
        vi.stubEnv('FEED_GO_LOCAL_URL', url);
        const rewrites = await loadRewrites();
        expect(rewriteFor(rewrites, '/api/trpc-go/model.getAll')?.destination, url).toBe(
          '/api/trpc/model.getAll'
        );
      }
      // Positive control in the same loop shape: localhost and [::1] are honoured.
      vi.stubEnv('FEED_GO_LOCAL_URL', 'http://localhost:43124/');
      expect(rewriteFor(await loadRewrites(), '/api/trpc-go/model.getAll')?.destination).toBe(
        'http://localhost:43124/api/trpc/model.getAll'
      );
      vi.stubEnv('FEED_GO_LOCAL_URL', 'http://[::1]:43125');
      expect(rewriteFor(await loadRewrites(), '/api/trpc-go/model.getAll')?.destination).toBe(
        'http://[::1]:43125/api/trpc/model.getAll'
      );
    });
  });
});

describe('feedGoTransport', () => {
  it('OFF (the default): the feed goes to /api/trpc as before', async () => {
    signIn();
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain(`/api/trpc/${FEED}?`);
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });

  it('ON, signed in: the feed goes to the Go transport path as a GET', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain(`${GO_TRANSPORT_URL}/${FEED}?`);
    expect(sent[0].url).toContain('input=');
  });

  it('ON, signed in, in the batch cohort: still unbatched on the Go path', async () => {
    signIn();
    setTrpcBatchingEnabled(true);
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`${GO_TRANSPORT_URL}/${FEED}?`);
    expect(sent[0].url).not.toContain('batch=1');
  });

  it('ON, signed out: the feed stays on /api/trpc (edge-cacheable path)', async () => {
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`/api/trpc/${FEED}?`);
  });

  it('ON, signed in: other procedures are unaffected', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(ORDINARY, ORDINARY_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`/api/trpc/${ORDINARY}?`);
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });

  it('ON, signed in: an input too large for a GET stays on /api/trpc as POST', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, {
      ...FEED_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });
});

/**
 * `feedGoTransportModelGetAll`: the same transport for `model.getAll`, behind its OWN flag. Literal
 * paths, so a change to the shared constants cannot move these expectations with them.
 */
describe('feedGoTransportModelGetAll', () => {
  it('OFF (the default): model.getAll goes to /api/trpc as before', async () => {
    signIn();
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON, signed in: model.getAll goes to /api/trpc-go/model.getAll as a GET', async () => {
    signIn();
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('/api/trpc-go/model.getAll?');
    expect(sent[0].url).toContain('input=');
  });

  it('ON, signed in, in the batch cohort: still unbatched on the Go path', async () => {
    signIn();
    setTrpcBatchingEnabled(true);
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc-go/model.getAll?');
    expect(sent[0].url).not.toContain('batch=1');
  });

  it('OFF, in the batch cohort: model.getAll stays unbatched on /api/trpc', async () => {
    signIn();
    setTrpcBatchingEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(sent[0].url).not.toContain('batch=1');
  });

  it('ON, signed out: model.getAll stays on /api/trpc (edge-cacheable path)', async () => {
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON, signed in: an input too large for a GET stays on /api/trpc as POST', async () => {
    signIn();
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, {
      ...MODELS_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON: the gallery feed is not moved (it has its own flag)', async () => {
    signIn();
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc/image.getImagesAsPostsInfinite?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('the gallery flag ON does not move model.getAll', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(2);
    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(sent[1].url).toContain('/api/trpc-go/image.getImagesAsPostsInfinite?'); // positive control
  });
});

/**
 * `feedGoTransportInfinite`: the same transport for `image.getInfinite`, behind its OWN flag. Literal
 * paths, so a change to the shared constants cannot move these expectations with them.
 */
describe('feedGoTransportInfinite', () => {
  it('OFF (the default): image.getInfinite goes to /api/trpc as before', async () => {
    signIn();
    await callQuery(IMAGES, IMAGES_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('/api/trpc/image.getInfinite?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON, signed in: image.getInfinite goes to /api/trpc-go/image.getInfinite as a GET', async () => {
    signIn();
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(IMAGES, IMAGES_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('/api/trpc-go/image.getInfinite?');
    expect(sent[0].url).toContain('input=');
  });

  it('ON, signed in, in the batch cohort: still unbatched on the Go path', async () => {
    signIn();
    setTrpcBatchingEnabled(true);
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(IMAGES, IMAGES_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc-go/image.getInfinite?');
    expect(sent[0].url).not.toContain('batch=1');
  });

  it('ON, signed out: image.getInfinite stays on /api/trpc (edge-cacheable path)', async () => {
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(IMAGES, IMAGES_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc/image.getInfinite?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON, signed in: an input too large for a GET stays on /api/trpc as POST', async () => {
    signIn();
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(IMAGES, {
      ...IMAGES_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain('/api/trpc-go');
  });

  it('ON: the gallery feed and model.getAll are not moved (each has its own flag)', async () => {
    signIn();
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(FEED, FEED_INPUT);
    await callQuery(MODELS, MODELS_INPUT);
    await callQuery(IMAGES, IMAGES_INPUT);

    expect(sent).toHaveLength(3);
    expect(sent[0].url).toContain('/api/trpc/image.getImagesAsPostsInfinite?');
    expect(sent[1].url).toContain('/api/trpc/model.getAll?');
    expect(sent[2].url).toContain('/api/trpc-go/image.getInfinite?'); // positive control
  });

  it('the gallery and model.getAll flags ON do not move image.getInfinite', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(IMAGES, IMAGES_INPUT);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(2);
    expect(sent[0].url).toContain('/api/trpc/image.getInfinite?');
    expect(sent[0].url).not.toContain('/api/trpc-go');
    expect(sent[1].url).toContain('/api/trpc-go/model.getAll?'); // positive control
  });
});
