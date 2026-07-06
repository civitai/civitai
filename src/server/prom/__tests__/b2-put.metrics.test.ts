import { describe, it, expect, beforeEach, vi } from 'vitest';
import client from 'prom-client';
import {
  b2PutMetricsMiddleware,
  opForCommand,
  classifyErrorResult,
  recordB2PresignIssued,
  __resetB2PutMetricsForTest,
} from '~/server/prom/b2-put.metrics';

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
  const match = values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val)
  );
  return match?.value ?? 0;
}

// An AWS-SDK error carries a $metadata bag; model just enough of it.
function sdkError(opts: { httpStatusCode?: number; name?: string; attempts?: number }) {
  const err = new Error(opts.name ?? 'SdkError') as Error & {
    name: string;
    $metadata?: { httpStatusCode?: number; attempts?: number };
  };
  if (opts.name) err.name = opts.name;
  err.$metadata = { httpStatusCode: opts.httpStatusCode, attempts: opts.attempts };
  return err;
}

beforeEach(() => {
  __resetB2PutMetricsForTest();
});

describe('opForCommand', () => {
  it('maps PutObject → upload, Copy → copy, multipart commands → multipart', () => {
    expect(opForCommand('PutObjectCommand')).toBe('upload');
    expect(opForCommand('CopyObjectCommand')).toBe('copy');
    expect(opForCommand('CreateMultipartUploadCommand')).toBe('multipart');
    expect(opForCommand('UploadPartCommand')).toBe('multipart');
  });

  it('returns null for non-PUT-class commands', () => {
    expect(opForCommand('GetObjectCommand')).toBeNull();
    expect(opForCommand('HeadObjectCommand')).toBeNull();
    expect(opForCommand('DeleteObjectCommand')).toBeNull();
    expect(opForCommand('CompleteMultipartUploadCommand')).toBeNull();
    expect(opForCommand(undefined)).toBeNull();
  });
});

describe('classifyErrorResult', () => {
  it('classifies HTTP 429 as throttled', () => {
    expect(classifyErrorResult(sdkError({ httpStatusCode: 429 }))).toBe('throttled');
  });
  it('classifies 503 SlowDown / TooManyRequests as throttled', () => {
    expect(classifyErrorResult(sdkError({ httpStatusCode: 503, name: 'SlowDown' }))).toBe(
      'throttled'
    );
    expect(classifyErrorResult(sdkError({ httpStatusCode: 503, name: 'TooManyRequests' }))).toBe(
      'throttled'
    );
  });
  it('classifies a generic 500 / unknown error as error', () => {
    expect(classifyErrorResult(sdkError({ httpStatusCode: 500, name: 'InternalError' }))).toBe(
      'error'
    );
    expect(classifyErrorResult(new Error('boom'))).toBe('error');
  });
});

describe('b2PutMetricsMiddleware — send() outcome counting', () => {
  it('(a) success → increments b2_put_requests_total with correct bucket/op/result', async () => {
    const next = vi.fn(async () => ({ output: { $metadata: { attempts: 1 } } }));
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    const out = await handler({ input: { Bucket: 'civitai-media-uploads' } });

    expect(next).toHaveBeenCalledOnce();
    expect(out).toEqual({ output: { $metadata: { attempts: 1 } } });
    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-media-uploads',
        op: 'upload',
        result: 'success',
      })
    ).toBe(1);
    // No retries on a single-attempt success.
    expect(
      await countFor('b2_put_retries_total', {
        service: 'civitai-web',
        bucket: 'civitai-media-uploads',
      })
    ).toBe(0);
  });

  it('(b) throttled: a 429 SlowDown throw → increments result="throttled" and re-throws', async () => {
    const err = sdkError({ httpStatusCode: 429, name: 'SlowDown' });
    const next = vi.fn(async () => {
      throw err;
    });
    const handler = b2PutMetricsMiddleware(next, { commandName: 'CreateMultipartUploadCommand' });

    await expect(handler({ input: { Bucket: 'civitai-modelfiles' } })).rejects.toBe(err);

    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
        op: 'multipart',
        result: 'throttled',
      })
    ).toBe(1);
  });

  it('(c) generic error throw → increments result="error" and re-throws', async () => {
    const err = sdkError({ httpStatusCode: 500, name: 'InternalError' });
    const next = vi.fn(async () => {
      throw err;
    });
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    await expect(handler({ input: { Bucket: 'civitai-media-uploads' } })).rejects.toBe(err);

    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'civitai-media-uploads',
        op: 'upload',
        result: 'error',
      })
    ).toBe(1);
  });

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

  it('also counts retries when the final outcome is an error', async () => {
    const err = sdkError({ httpStatusCode: 429, attempts: 4 });
    const next = vi.fn(async () => {
      throw err;
    });
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    await expect(handler({ input: { Bucket: 'civitai-modelfiles' } })).rejects.toBe(err);

    expect(
      await countFor('b2_put_retries_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
      })
    ).toBe(3);
  });

  it('passes non-PUT-class commands straight through without counting', async () => {
    const next = vi.fn(async () => ({ output: { $metadata: { attempts: 1 } } }));
    const handler = b2PutMetricsMiddleware(next, { commandName: 'GetObjectCommand' });

    await handler({ input: { Bucket: 'civitai-media-uploads' } });

    expect(next).toHaveBeenCalledOnce();
    const values = await readCounter('b2_put_requests_total');
    expect(values).toHaveLength(0);
  });

  it('falls back to bucket="unknown" when the command input has no Bucket', async () => {
    const next = vi.fn(async () => ({ output: { $metadata: { attempts: 1 } } }));
    const handler = b2PutMetricsMiddleware(next, { commandName: 'PutObjectCommand' });

    await handler({ input: {} });

    expect(
      await countFor('b2_put_requests_total', {
        service: 'civitai-web',
        bucket: 'unknown',
        op: 'upload',
        result: 'success',
      })
    ).toBe(1);
  });
});

describe('recordB2PresignIssued', () => {
  it('increments b2_presign_issued_total for the given bucket', async () => {
    recordB2PresignIssued('civitai-modelfiles');
    recordB2PresignIssued('civitai-modelfiles');
    expect(
      await countFor('b2_presign_issued_total', {
        service: 'civitai-web',
        bucket: 'civitai-modelfiles',
      })
    ).toBe(2);
  });
});
