import { describe, it, expect, beforeEach, vi } from 'vitest';
import client from 'prom-client';
import { b2PutMetricsMiddleware, __resetB2PutMetricsForTest } from '~/server/prom/b2-put.metrics';

// Pure unit test: this module imports only prom-client (no env / Prisma / DB), so
// nothing here boots the app graph. We drive the AWS-SDK-shaped middleware directly
// with a mocked `next` handler and read counter values back off the default registry.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

async function readCounter(name: string): Promise<MetricJSON['values']> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<MetricJSON>;
  };
  const data = await metric.get();
  return data.values;
}

async function countFor(name: string, labels: Record<string, string>): Promise<number> {
  const values = await readCounter(name);
  const match = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

beforeEach(() => {
  __resetB2PutMetricsForTest();
});

describe('b2PutMetricsMiddleware — send() outcome counting', () => {
  it('counts SDK retry attempts from $metadata.attempts (attempts=3 → retries+2)', async () => {
    const next = vi.fn(async () => ({ output: { $metadata: { attempts: 3 } } }));
    const handler = b2PutMetricsMiddleware(next, { commandName: 'UploadPartCommand' });

    await handler({ input: { Bucket: 'civitai-modelfiles' } });

    expect(
      await countFor('b2_put_retries_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
      })
    ).toBe(2);
    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
        op: 'multipart',
        result: 'success',
      })
    ).toBe(1);
  });
});

describe('b2PutMetricsMiddleware — telemetry can never throw into an upload', () => {
  // The middleware evaluates classifyErrorResult / retriesFromMetadata as arguments
  // to the guarded recordB2PutSend. These helpers only do optional-chaining reads and
  // realistically can't throw — but the guard must be STRUCTURAL, not empirical. We
  // force the telemetry argument-evaluation to throw (a metadata object whose accessed
  // property throws) and assert the middleware still behaves as if telemetry is a no-op:
  // the ORIGINAL SDK error is re-thrown on the error path, and the SDK result is still
  // returned on the success path — never a telemetry error, and the upload never crashes.

  it('error path: re-throws the ORIGINAL SDK error even if classifyErrorResult/retriesFromMetadata throw', async () => {
    const err = new Error('original sdk failure') as Error & { $metadata?: unknown };
    // Reading $metadata (done by both classifyErrorResult and retriesFromMetadata)
    // throws — simulating a telemetry helper blowing up on a hostile metadata bag.
    Object.defineProperty(err, '$metadata', {
      get() {
        throw new Error('telemetry classify boom — must NOT surface');
      },
    });
    const next = vi.fn(async () => {
      throw err;
    });
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    // Rejects with the ORIGINAL err (not the telemetry error) and does not crash.
    await expect(handler({ input: { Bucket: 'civitai-modelfiles' } })).rejects.toBe(err);
    // Telemetry swallowed the throw, so nothing was counted for this send.
    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
        op: 'upload',
        result: 'error',
      })
    ).toBe(0);
  });

  it('success path: returns the SDK result even if retriesFromMetadata arg-eval throws', async () => {
    const result = { output: {} as { $metadata?: unknown } };
    // Reading result.output.$metadata (the retriesFromMetadata argument) throws.
    Object.defineProperty(result.output, '$metadata', {
      get() {
        throw new Error('telemetry retries boom — must NOT surface');
      },
    });
    const next = vi.fn(async () => result);
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    // Resolves to the original SDK result — the successful upload is untouched.
    await expect(handler({ input: { Bucket: 'civitai-modelfiles' } })).resolves.toBe(result);
    // Telemetry swallowed the throw, so no success row was recorded either.
    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
        op: 'upload',
        result: 'success',
      })
    ).toBe(0);
  });
});
