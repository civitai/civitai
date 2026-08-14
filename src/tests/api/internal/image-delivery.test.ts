import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
// The DB fake narrows each fixture row to the columns the statement actually SELECTs, the way
// a real database does. Without it, a fake returns the whole fixture regardless of the query,
// so an assertion about a newly selected column passes even against code that never selects
// it — which is exactly how these media-type assertions first went green against unchanged
// production code.
import { respondWithRows } from '~/test-utils/queryRawProjection';
import type * as RedisClientModule from '~/server/redis/client';

/**
 * Coverage for GET /api/internal/image-delivery/[id] — the per-request lookup the image
 * delivery service makes to learn how to serve a stored file.
 *
 * The body used to carry only `hideMeta`, which left the caller unable to tell a video from
 * an image: everything looked like an image, so videos were handed to an image-only
 * conversion path and failed. The body now also carries `type` (the discriminator) and
 * `mimeType` (the container, nullable).
 *
 * Deliberately NOT mocking `image-delivery.service` — that would make the media-type
 * assertions a pass-through tautology, green whether or not the service actually reads the
 * columns. Only the DB and Redis are faked, so this runs the REAL lookup end to end and the
 * assertions below are genuine regression coverage: they fail on the pre-change service,
 * which never selects `type`/`mimeType`.
 */

const { store, dbReadQueryRaw, dbWriteQueryRaw } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  dbReadQueryRaw: vi.fn(),
  dbWriteQueryRaw: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: dbReadQueryRaw },
  dbWrite: { $queryRaw: dbWriteQueryRaw },
}));

// Keep the real REDIS_KEYS (so the key prefix matches the real one) and swap only the client.
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisClientModule>();
  return {
    ...actual,
    redis: {
      del: vi.fn(async (key: string) => (store.delete(key), 1)),
      packed: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: unknown) => {
          store.set(key, value);
        }),
      },
    },
  };
});

// WebhookEndpoint wraps the handler with the shared internal-auth check we don't exercise
// here — pass it through so the route's own logic (query validation, 404, body shape) is
// what's under test. Mirrors the PublicEndpoint pass-through in ping.test.ts.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: any) => handler,
}));

vi.mock('~/server/prom/client', () => ({
  registerCounterWithLabels: () => ({ inc: vi.fn() }),
  dbReadFallbackCounter: { inc: vi.fn() },
}));

function makeRes() {
  const res = {} as NextApiResponse & { _status?: number; _body?: any };
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  }) as any;
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  }) as any;
  return res;
}

const makeReq = (id: string) => ({ method: 'GET', query: { id } } as unknown as NextApiRequest);

const VIDEO_URL = 'vid987/clip.mp4';
const IMAGE_URL = 'abc123/def456.jpeg';

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe('GET /api/internal/image-delivery/[id]', () => {
  it('returns the media type alongside hideMeta for a VIDEO row', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 77, url: VIDEO_URL, hideMeta: true, type: 'video', mimeType: 'video/mp4' },
      ])
    );
    const res = makeRes();

    await handler(makeReq(VIDEO_URL) as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res._body.type).toBe('video');
    expect(res._body.mimeType).toBe('video/mp4');
    expect(res._body.hideMeta).toBe(true); // pre-existing field unchanged
  });

  it('returns the media type alongside hideMeta for an IMAGE row', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 42, url: IMAGE_URL, hideMeta: false, type: 'image', mimeType: 'image/jpeg' },
      ])
    );
    const res = makeRes();

    await handler(makeReq(IMAGE_URL) as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res._body.type).toBe('image');
    expect(res._body.mimeType).toBe('image/jpeg');
    expect(res._body.hideMeta).toBe(false);
  });

  it('serializes an absent mimeType as an explicit null key, not a dropped field', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 3, url: 'legacy/old.jpeg', hideMeta: false, type: 'image', mimeType: null },
      ])
    );
    const res = makeRes();

    await handler(makeReq('legacy/old.jpeg') as any, res);

    // What the caller actually parses off the wire — `undefined` would be dropped here.
    const wire = JSON.parse(JSON.stringify(res._body));
    expect(wire).toHaveProperty('mimeType', null);
    expect(wire.type).toBe('image'); // the discriminator survives a missing mimeType
  });

  it('is additive — the response still carries every field it carried before', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 42, url: IMAGE_URL, hideMeta: false, type: 'image', mimeType: 'image/jpeg' },
      ])
    );
    const res = makeRes();

    await handler(makeReq(IMAGE_URL) as any, res);

    // A caller that reads only `hideMeta` (and `id`/`url`) is unaffected: same names, same
    // types, same values.
    expect(res._body).toMatchObject({ id: 42, url: IMAGE_URL, hideMeta: false });
  });

  /**
   * WIRE CONTRACT — the key name is load-bearing and is pinned here deliberately.
   *
   * The caller binds the media type from the JSON key `type` and treats an absent/null value
   * as "unknown", falling back to today's behaviour. So renaming this key does NOT fail
   * anywhere: the caller quietly reads null forever and the fix becomes inert. A silently
   * inert fix is the worst outcome available, hence a test on the literal key rather than
   * only on the value.
   */
  it('emits the media type under the literal JSON key "type"', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 77, url: VIDEO_URL, hideMeta: true, type: 'video', mimeType: 'video/mp4' },
      ])
    );
    const res = makeRes();

    await handler(makeReq(VIDEO_URL) as any, res);

    // Assert against the SERIALIZED body — that is what the caller parses.
    const wire = JSON.parse(JSON.stringify(res._body));
    expect(Object.keys(wire)).toContain('type');
    // Bare enum value, not a full mime string: 'video', not 'video/mp4'.
    expect(wire.type).toBe('video');
    expect(['image', 'video', 'audio']).toContain(wire.type);
  });

  it('emits "image" for an image so the caller can tell the two apart', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(
      respondWithRows([
        { id: 42, url: IMAGE_URL, hideMeta: false, type: 'image', mimeType: 'image/jpeg' },
      ])
    );
    const res = makeRes();

    await handler(makeReq(IMAGE_URL) as any, res);

    // The whole point of the field: these two must be distinguishable, not both "unknown".
    expect(JSON.parse(JSON.stringify(res._body)).type).toBe('image');
  });

  // --- Invariant guards (NOT regression coverage): these pass on the pre-change code too.
  // They pin the error shape the widening must not disturb.
  it('[invariant] still 404s an unknown url', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    dbReadQueryRaw.mockImplementation(respondWithRows([]));
    const res = makeRes();

    await handler(makeReq('missing/url.jpg') as any, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res._body).toEqual({ error: 'Image not found' });
  });

  it('[invariant] still 400s a request with no id, without querying', async () => {
    const handler = (await import('~/pages/api/internal/image-delivery/[id]')).default;
    const res = makeRes();

    await handler({ method: 'GET', query: {} } as unknown as NextApiRequest, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(dbReadQueryRaw).not.toHaveBeenCalled();
  });
});
