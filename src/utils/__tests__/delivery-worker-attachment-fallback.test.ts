import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver endpoint and internal token are read at module load, so this
// file mocks env with both set (delivery-worker.test.ts runs with the resolver
// disabled).
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      DELIVERY_WORKER_ENDPOINT: 'https://delivery.example.com/',
      DELIVERY_WORKER_TOKEN: 'tok',
      STORAGE_RESOLVER_ENDPOINT: 'https://resolver.example.com',
      STORAGE_RESOLVER_AUTH: '',
      STORAGE_RESOLVER_INTERNAL_TOKEN: 'internal-tok',
      S3_UPLOAD_ENDPOINT: 'https://storage.example.com',
      LOGGING: [],
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        return prop in target ? target[prop] : undefined;
      },
    }
  ),
}));

import {
  DeliveryWorkerError,
  StorageResolverError,
  getDownloadUrl,
  isDefiniteNotFound,
  resolveDownloadUrl,
} from '../delivery-worker';

const DELIVERY = 'https://delivery.example.com/';
const ATTACHMENT_ROUTE = 'https://resolver.example.com/resolve-attachment';
const KEY = 'default/7/my%20report.pdf';
// A stored file URL in path style on the configured upload host (bucket first).
const STORED_URL = 'https://storage.example.com/some-bucket/default/7/my%20report.pdf';

type Reply = { status: number; body?: unknown } | Error;

function reply(r: Reply): Response {
  if (r instanceof Error) throw r;
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: `status ${r.status}`,
    json: async () => r.body,
    text: async () => JSON.stringify(r.body ?? ''),
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** Route fetch by URL: the delivery worker, the attachment route, or /resolve. */
function routes({
  delivery,
  attachment = { status: 404 },
  resolve = { status: 404 },
}: {
  delivery: Reply;
  attachment?: Reply;
  resolve?: Reply;
}) {
  fetchMock.mockImplementation(async (input: string) => {
    if (input.startsWith(DELIVERY)) return reply(delivery);
    if (input === ATTACHMENT_ROUTE) return reply(attachment);
    if (input === 'https://resolver.example.com/resolve') return reply(resolve);
    throw new Error(`unexpected fetch ${input}`);
  });
}

const attachmentCalls = () => fetchMock.mock.calls.filter(([u]) => u === ATTACHMENT_ROUTE);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err) => err
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getDownloadUrl — moved-attachment fallback on a delivery-worker 404', () => {
  it('returns the resolver URL when the delivery worker 404s and the key is registered', async () => {
    routes({
      delivery: { status: 404 },
      attachment: {
        status: 200,
        body: {
          url: 'https://signed.example.com/a',
          urlExpiryDate: '2030-01-01T00:00:00.000Z',
          backend: 'secondary',
        },
      },
    });

    const result = await getDownloadUrl(STORED_URL, 'my%20report.pdf');

    expect(result.url).toBe('https://signed.example.com/a');
    expect(new Date(result.urlExpiryDate).toISOString()).toBe('2030-01-01T00:00:00.000Z');

    // The delivery worker gets the parsed key...
    const dwBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(dwBody.key).toBe('default/7/my report.pdf');

    const calls = attachmentCalls();
    expect(calls).toHaveLength(1);
    const init = calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    // Bounded: these callers never waited on the resolver before.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer internal-tok');
    // ...the resolver gets the file URL exactly as stored (it normalises it itself),
    // and the decoded download name the delivery worker also gets.
    expect(JSON.parse(init.body as string)).toEqual({
      path: STORED_URL,
      fileName: 'my report.pdf',
    });
  });

  it('passes a bare key through unchanged', async () => {
    routes({
      delivery: { status: 404 },
      attachment: { status: 200, body: { url: 'https://signed.example.com/b' } },
    });

    await getDownloadUrl(KEY);

    expect(JSON.parse(attachmentCalls()[0][1].body as string).path).toBe(KEY);
  });

  it.each([400, 403, 429, 500, 503])(
    'keeps a delivery-worker %i as-is and never asks the resolver',
    async (status) => {
      routes({
        delivery: { status },
        attachment: { status: 200, body: { url: 'https://signed.example.com/should-not-be-used' } },
      });

      const err = await rejection(getDownloadUrl(KEY));

      expect(err).toBeInstanceOf(DeliveryWorkerError);
      expect((err as DeliveryWorkerError).statusCode).toBe(status);
      expect(attachmentCalls()).toHaveLength(0);
    }
  );

  it.each<[string, Reply]>([
    ['404 (key not registered)', { status: 404 }],
    ['500', { status: 500 }],
    ['401', { status: 401 }],
    ['a transport reject', new TypeError('fetch failed')],
    [
      'a timeout',
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    ],
    ['200 without a url', { status: 200, body: { backend: 'secondary' } }],
  ])(
    'throws the original delivery-worker 404 when the resolver answers %s',
    async (_label, attachment) => {
      routes({ delivery: { status: 404 }, attachment });

      const err = await rejection(getDownloadUrl(KEY));

      expect(err).toBeInstanceOf(DeliveryWorkerError);
      expect((err as DeliveryWorkerError).statusCode).toBe(404);
      expect(attachmentCalls()).toHaveLength(1);
    }
  );

  it('does not ask the resolver when the delivery worker succeeds', async () => {
    routes({
      delivery: {
        status: 200,
        body: { url: 'https://cdn.example.com/primary', urlExpiryDate: 'x' },
      },
    });

    const result = await getDownloadUrl(KEY);

    expect(result.url).toBe('https://cdn.example.com/primary');
    expect(attachmentCalls()).toHaveLength(0);
  });
});

describe('resolveDownloadUrl — model files keep their not-found semantics', () => {
  it('a resolver 404 + delivery-worker 404 is still a definite not-found', async () => {
    routes({ delivery: { status: 404 }, resolve: { status: 404 }, attachment: { status: 404 } });

    const err = await rejection(
      resolveDownloadUrl(1, 'model/1/x.safetensors', undefined, {
        caller: 'orchestrator-preflight',
        actor: 'internal',
      })
    );

    expect(err).toBeInstanceOf(DeliveryWorkerError);
    expect((err as DeliveryWorkerError).resolverError).toBeInstanceOf(StorageResolverError);
    expect(isDefiniteNotFound(err)).toBe(true);
  });

  it('a resolver 503 + delivery-worker 404 is still transient', async () => {
    routes({ delivery: { status: 404 }, resolve: { status: 503 }, attachment: { status: 404 } });

    const err = await rejection(
      resolveDownloadUrl(1, 'model/1/x.safetensors', undefined, {
        caller: 'orchestrator-preflight',
        actor: 'internal',
      })
    );

    expect(isDefiniteNotFound(err)).toBe(false);
  });
});
