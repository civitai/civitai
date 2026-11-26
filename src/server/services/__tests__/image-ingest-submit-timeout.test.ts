import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Image ingestion (`source: 'imageIngest'`) against a scan submit that never answers.
 *
 * Its per-attempt backstop (15s) used to be followed by up to two more attempts. A timed-out
 * attempt may have been accepted, and may still be in flight, so the retry wrapper no longer
 * retries a real submit that ended by timeout — the per-image `externalId` notwithstanding. The
 * image is not lost: `ingestImage` records a TRANSIENT send failure (`markImageScanSubmitFailure`),
 * which leaves the row's ingestion status alone and re-queues it for the next cron run.
 *
 * Composed on purpose: the REAL `ingestImage`, `createImageIngestionRequest` and retry wrapper,
 * with only the generated client's `submitWorkflow` replaced by a stub that settles only when
 * its abort signal fires.
 */

const { mockIsFlipt, probeMock, mockClientSubmit } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
  probeMock: vi.fn(),
  mockClientSubmit: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  submitWorkflow: mockClientSubmit,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_INGESTION_IMAGE_SCANNING: 'image_ingestion_image_scanning' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: {},
  createOrchestratorClient: vi.fn(() => ({})),
}));
vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: probeMock,
}));
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

import type * as OrchestrationClient from '@civitai/orchestration-client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ingestImage } from '~/server/services/image.service';
import type { IngestImageInput } from '~/server/schema/image.schema';

type StubOptions = { signal?: AbortSignal; body?: { externalId?: string } };

const image: IngestImageInput = {
  id: 777,
  url: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png',
  type: 'image' as IngestImageInput['type'],
  width: 100,
  height: 100,
};

beforeEach(() => {
  vi.useFakeTimers();
  mockIsFlipt.mockReset().mockResolvedValue(false);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  mockClientSubmit.mockReset().mockImplementation(
    ({ signal }: StubOptions) =>
      new Promise((resolve) => {
        if (!signal) return; // never settles: an unbounded submit hangs here forever
        signal.addEventListener(
          'abort',
          () => resolve({ data: undefined, response: undefined, error: signal.reason }),
          { once: true }
        );
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingestImage — a scan submit that times out', () => {
  it('is not retried, and the image is left (transient) for the next cron run', async () => {
    const start = Date.now();
    let result: boolean | undefined;
    let done = false;
    ingestImage({ image }).then((r) => {
      result = r;
      done = true;
    });
    for (let i = 0; i < 120 && !done; i++) await vi.advanceTimersByTimeAsync(1_000);

    expect(done, 'ingestImage never settled within 120s of fake time').toBe(true);
    expect(result).toBe(false);
    // One attempt, bounded by the 15s backstop, keyed — and not retried.
    expect(mockClientSubmit).toHaveBeenCalledTimes(1);
    const call = mockClientSubmit.mock.calls[0][0] as StubOptions;
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(typeof call.body?.externalId).toBe('string');
    expect(Date.now() - start).toBeLessThanOrEqual(16_000);

    // markImageScanSubmitFailure: exactly one write, and NOT permanent (its first bound value is
    // `isPermanent`), so the row keeps its ingestion status and is picked up again.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    const [, isPermanent] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown[];
    expect(isPermanent).toBe(false);
  });
});
