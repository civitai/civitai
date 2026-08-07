import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// queryBitdex collapses "the request failed" and "the query matched nothing" into the
// same null, which is why callers that must choose between serving an empty page and
// falling back to another backend go through queryBitdexOutcome. Both contracts are
// pinned here: queryBitdex's null-on-failure signature is unchanged for its existing
// callers, and queryBitdexOutcome distinguishes the two cases.

// BITDEX_URL is captured at module load, so it has to be set before the import.
process.env.BITDEX_URL = 'http://bitdex.test';

const okBody = { ids: [], total_matched: 0, elapsed_us: 5 };

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);

describe('queryBitdexOutcome', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports ok for a 200 that matched nothing', async () => {
    const { queryBitdexOutcome } = await import('../client');
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await expect(queryBitdexOutcome('civitai', [])).resolves.toEqual({
      status: 'ok',
      result: okBody,
    });
  });

  it('reports failed for a non-2xx response', async () => {
    const { queryBitdexOutcome } = await import('../client');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 503));

    await expect(queryBitdexOutcome('civitai', [])).resolves.toEqual({ status: 'failed' });
  });

  it('reports failed when the request throws (timeout, network)', async () => {
    const { queryBitdexOutcome } = await import('../client');
    fetchMock.mockRejectedValue(new Error('The operation was aborted'));

    await expect(queryBitdexOutcome('civitai', [])).resolves.toEqual({ status: 'failed' });
  });
});

describe('queryBitdex null-on-failure contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the result object on success', async () => {
    const { queryBitdex } = await import('../client');
    fetchMock.mockResolvedValue(jsonResponse(okBody));

    await expect(queryBitdex('civitai', [])).resolves.toEqual(okBody);
  });

  it('returns null on failure', async () => {
    const { queryBitdex } = await import('../client');
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    await expect(queryBitdex('civitai', [])).resolves.toBeNull();
  });
});
