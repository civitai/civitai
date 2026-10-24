import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';

// An orchestrator 429 on an image-scan submit is "wait", not a failed attempt: it must not
// spend the retry ceilings that terminalize a scan, and the next send waits for Retry-After.

const { mockCreateImageIngestionRequest } = vi.hoisted(() => ({
  mockCreateImageIngestionRequest: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mockCreateImageIngestionRequest,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { ingestImage } from '~/server/services/image.service';

const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png';
const image = { id: 4242, url: STORAGE_KEY, type: 'image' as const, width: 100, height: 100 };

const failedSubmit = (status: number, detail: string, retryAfter?: number) =>
  mockCreateImageIngestionRequest.mockResolvedValue({
    data: undefined,
    error: { title: status === 429 ? 'Too Many Requests' : 'Error', status, detail },
    status,
    retryAfter,
    useImageScanning: false,
  });

/** The failure stamp's interpolated values, each keyed by the SQL just before it. */
async function submitAndReadStamp() {
  const writes: { strings: TemplateStringsArray; values: unknown[] }[] = [];
  dbMock.dbWrite.$executeRaw.mockImplementation(((strings: TemplateStringsArray, ...values) => {
    writes.push({ strings, values });
    return Promise.resolve(1);
  }) as never);

  const before = Date.now();
  expect(await ingestImage({ image })).toBe(false);
  expect(writes).toHaveLength(1);

  const { strings, values } = writes[0];
  const after = (fragment: string) =>
    values[strings.findIndex((s) => s.trimEnd().endsWith(fragment))];
  const errorJson = JSON.parse(String(values.find((v) => String(v).includes('send-fail'))));
  // The increment is interpolated, or a literal in the SQL text.
  const retryCountSql = 'COALESCE(("scanJobs"->>\'retryCount\')::int, 0) +';
  const literal = strings.join('?').match(/retryCount'\)::int, 0\) \+ (\d+)/)?.[1];
  return {
    before,
    errorJson,
    scanRequestedAt: after('"scanRequestedAt" =') as Date,
    retryIncrement: after(retryCountSql) ?? (literal === undefined ? undefined : Number(literal)),
  };
}

beforeEach(() => {
  mockCreateImageIngestionRequest.mockReset();
  dbMock.dbWrite.$executeRaw.mockReset();
});

describe('ingestImage — orchestrator 429', () => {
  it('keeps the retry count, classes it transient, and holds the next send for Retry-After', async () => {
    failedSubmit(429, "Free tier quota for 'x' is exhausted", 600);

    const stamp = await submitAndReadStamp();

    expect(stamp.errorJson.failureClass).toBe('transient');
    expect(stamp.errorJson.responseStatus).toBe(429);
    expect(stamp.retryIncrement).toBe(0);
    expect(stamp.scanRequestedAt.getTime()).toBeGreaterThanOrEqual(stamp.before + 600_000);
    expect(stamp.scanRequestedAt.getTime()).toBeLessThan(stamp.before + 660_000);
  });

  it('without Retry-After, still spends no retry and uses the ordinary cooldown', async () => {
    failedSubmit(429, 'Too many requests');

    const stamp = await submitAndReadStamp();

    expect(stamp.retryIncrement).toBe(0);
    expect(stamp.scanRequestedAt.getTime()).toBeLessThan(stamp.before + 60_000);
  });

  it('control: a 500 still counts as a failed attempt with the ordinary cooldown', async () => {
    failedSubmit(500, 'boom', 600);

    const stamp = await submitAndReadStamp();

    expect(stamp.errorJson.failureClass).not.toBe('permanent');
    expect(stamp.retryIncrement).toBe(1);
    expect(stamp.scanRequestedAt.getTime()).toBeLessThan(stamp.before + 60_000);
  });
});
