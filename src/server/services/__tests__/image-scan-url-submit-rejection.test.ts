import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';

const { mockCreateImageIngestionRequest, probeMock } = vi.hoisted(() => ({
  mockCreateImageIngestionRequest: vi.fn(),
  probeMock: vi.fn(),
}));

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: probeMock,
}));

// Spread the original: image.service also consumes `imageIngestionLogName` from this
// module, and the real module is load-safe in the test runtime (the ingestion-error
// suites already import it transitively).
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createImageIngestionRequest: mockCreateImageIngestionRequest,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { imageScanSubmittedCounter } from '~/server/prom/client';
import { createImage, enqueueImageIngestion, ingestImage } from '~/server/services/image.service';
import type { IngestImageInput } from '~/server/schema/image.schema';

const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png';
const EVIL_URL = 'https://evil.com/scan-me.png';

const image = (url: string, id = 4242): IngestImageInput => ({
  id,
  url,
  type: 'image' as IngestImageInput['type'],
  width: 100,
  height: 100,
});

/**
 * 🔴 A DEFAULT resolution, not a bare `mockReset()`. With no default the mocked funnel
 * returns `undefined`, and `ingestImage` destructures it — so deleting the guard under test
 * makes these tests die on `TypeError: Cannot destructure property 'data'` BEFORE any
 * assertion runs. They then go red for the wrong reason, printing nothing about an
 * allowlist, and a maintainer reads it as a broken mock. The id is deliberately
 * accusatory: if it ever appears, the guard let a submit through.
 */
const allowSubmitByDefault = () =>
  mockCreateImageIngestionRequest.mockReset().mockResolvedValue({
    data: { id: 'must-not-happen' },
    error: undefined,
    status: 200,
    useImageScanning: false,
  });

beforeEach(() => {
  allowSubmitByDefault();
  dbMock.dbWrite.$executeRaw.mockClear();
  loggingMock.logToAxiom.mockClear();
  vi.mocked(imageScanSubmittedCounter.inc).mockClear();
});

describe('ingestImage URL allowlist (submit seam)', () => {
  it('rejects an off-allowlist absolute URL without submitting anything to the orchestrator', async () => {
    const captured: unknown[][] = [];
    dbMock.dbWrite.$executeRaw.mockImplementation((...args: unknown[]) => {
      captured.push(args);
      return Promise.resolve(1);
    });

    const result = await ingestImage({ image: image(EVIL_URL) });

    expect(result).toBe(false);
    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();

    // The one write is the submit-failure stamp: permanent class -> ingestion=Error,
    // so the cron terminalizes on this attempt instead of retrying forever.
    expect(captured).toHaveLength(1);
    // Args: (template, isPermanent, ImageIngestionStatus.Error, at, errorJson, imageId).
    expect(captured[0][1]).toBe(true);
    expect(captured[0][2]).toBe('Error');
    const errorJson = JSON.parse(String(captured[0][4]));
    expect(errorJson.failureType).toBe('send-fail');
    expect(errorJson.responseStatus).toBe(400);
    expect(errorJson.failureClass).toBe('permanent');
    expect(errorJson.reason).toContain('not on the ingestion allowlist');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'url-not-allowed', imageId: 4242, type: 'error' })
    );
    // The `rejected` label is a documented alerting contract (its help text advertises it),
    // so pin it. `lane: 'unknown'` is deliberate — the real lane comes from a Flipt read this
    // rejection returns before, so attributing it to a concrete lane would skew a per-lane
    // rejection rate. toHaveBeenCalledTimes(1) matters: a doubled inc is otherwise invisible.
    expect(imageScanSubmittedCounter.inc).toHaveBeenCalledTimes(1);
    expect(imageScanSubmittedCounter.inc).toHaveBeenCalledWith({
      lane: 'unknown',
      result: 'rejected',
    });
  });

  it('rejects a blob: url the same way — the failed-submit fold-in', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    const result = await ingestImage({
      image: image('blob:https://civitai.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    });

    expect(result).toBe(false);
    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('submits a relative storage key unchanged — no false positive on the ordinary upload path', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-1' },
      error: undefined,
      status: 200,
      useImageScanning: false,
    });

    const result = await ingestImage({ image: image(STORAGE_KEY) });

    expect(result).toBe(true);
    expect(mockCreateImageIngestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 4242, url: STORAGE_KEY, type: 'image' })
    );
    // The scanJobs stamp on success.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('submits the avatar-host urls that legitimately appear in Image data', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-2' },
      error: undefined,
      status: 200,
      useImageScanning: false,
    });

    const result = await ingestImage({
      image: image('https://cdn.discordapp.com/avatars/123/abc.png'),
    });

    expect(result).toBe(true);
    expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 The ARTICLE content-media-node path does NOT go through `createImage` — it writes via
 * `tx.image.createManyAndReturn` and ingests via `enqueueImageIngestion`
 * (article.service.ts:1837, `name: 'article-image-ingest'`). So the `createImage` block
 * below cannot stand in for it, and a test that only drove `createImage` would leave the
 * article path's wiring unpinned while reading as coverage for it.
 */
describe('enqueueImageIngestion funnel — the article content-media-node path', () => {
  beforeEach(() => {
    allowSubmitByDefault();
    dbMock.dbWrite.$executeRaw.mockClear();
  });

  it('submits nothing to the orchestrator for an off-allowlist article media node', async () => {
    enqueueImageIngestion({
      images: [image(EVIL_URL, 5150)],
      name: 'article-image-ingest',
      userId: 7,
      lowPriority: true,
    });
    // enqueueImageIngestion is fire-and-forget; let its ingest promises settle.
    await vi.waitFor(() => expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalled());

    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    const stamps = dbMock.dbWrite.$executeRaw.mock.calls.map((c) => JSON.stringify(c));
    expect(stamps.some((s) => s.includes('not on the ingestion allowlist'))).toBe(true);
  });

  it('submits a relative storage key from the same funnel', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-art' },
      error: undefined,
      status: 200,
      useImageScanning: false,
    });

    enqueueImageIngestion({
      images: [image(STORAGE_KEY, 5151)],
      name: 'article-image-ingest',
      userId: 7,
      lowPriority: true,
    });
    await vi.waitFor(() => expect(mockCreateImageIngestionRequest).toHaveBeenCalledTimes(1));

    expect(mockCreateImageIngestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: STORAGE_KEY })
    );
  });
});

describe('createImage funnel — the comics and model3d-seed write path', () => {
  beforeEach(() => {
    probeMock.mockReset().mockResolvedValue('present');
    dbMock.dbWrite.image.create.mockReset().mockResolvedValue({ id: 90210 } as never);
    allowSubmitByDefault();
    dbMock.dbWrite.$executeRaw.mockClear();
  });

  it('an off-allowlist coverUrl creates the row but submits nothing to the orchestrator', async () => {
    const result = await createImage({
      url: EVIL_URL,
      type: 'image',
      userId: 7,
    } as never);

    // The row itself is written (the failure is a scan status, not a write rejection)…
    expect(result).toEqual({ id: 90210 });
    // …but nothing reaches the orchestrator, and the rejection stamp carries the reason.
    expect(mockCreateImageIngestionRequest).not.toHaveBeenCalled();
    const stamps = dbMock.dbWrite.$executeRaw.mock.calls.map((c) => JSON.stringify(c));
    expect(stamps.some((s) => s.includes('not on the ingestion allowlist'))).toBe(true);
  });

  it('a relative storage key flows through createImage into a real submit', async () => {
    mockCreateImageIngestionRequest.mockResolvedValue({
      data: { id: 'wf-9' },
      error: undefined,
      status: 200,
      useImageScanning: false,
    });

    await createImage({
      url: STORAGE_KEY,
      type: 'image',
      userId: 7,
    } as never);

    expect(mockCreateImageIngestionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: STORAGE_KEY })
    );
    // One $executeRaw: the scanJobs success stamp.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
