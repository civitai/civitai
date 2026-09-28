import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SEAM test: `ingestImage` against the REAL `createImageIngestionRequest`.
 *
 * 🔴 Why this exists separately. Every other suite in this arc mocks the funnel away, so
 * each enforcement point is only ever verified in isolation — and the two behave
 * DIFFERENTLY. `ingestImage`'s pre-check stamps the row permanent and returns `false`; the
 * funnel's backstop THROWS, and neither `ingestImage` nor `createImage` wraps that call.
 * So "the backstop covers us if the pre-check goes" is false: removing the pre-check turns
 * a comics / model3d-seed `createImage` into an uncaught throw — a 5xx to the caller, with
 * the `Image` row left un-stamped instead of terminalized. A suite that mocks the funnel
 * cannot see any of that.
 *
 * Only `submitWorkflowWithRetry` is mocked here, so the real allowlist runs at both points.
 */
const { mockSubmitWorkflowWithRetry, mockIsFlipt, probeMock } = vi.hoisted(() => ({
  mockSubmitWorkflowWithRetry: vi.fn(),
  mockIsFlipt: vi.fn(),
  probeMock: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: mockSubmitWorkflowWithRetry,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_INGESTION_IMAGE_SCANNING: 'image_ingestion_image_scanning' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: probeMock,
}));
// NOTE: `@civitai/client` is deliberately NOT mocked. Narrowly stubbing it breaks this
// suite at COLLECTION (`No "BuzzClientAccount" export is defined on the mock`) because
// `image.service` reaches far more of that surface than the orchestrator-only suites do,
// and the real module is load-safe in this runtime — `image-scan-url-submit-rejection`
// imports `image.service` without stubbing it at all.
// Pin the edge host so the resolved mediaUrl does not depend on a checkout's `.env`.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { ingestImage } from '~/server/services/image.service';
import type { IngestImageInput } from '~/server/schema/image.schema';

const image = (url: string, id = 777): IngestImageInput => ({
  id,
  url,
  type: 'image' as IngestImageInput['type'],
  width: 100,
  height: 100,
});

beforeEach(() => {
  mockSubmitWorkflowWithRetry.mockReset().mockResolvedValue({
    data: { id: 'wf-seam' },
    response: undefined,
    attempts: 1,
  });
  mockIsFlipt.mockReset().mockResolvedValue(false);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
});

describe('ingestImage + the real createImageIngestionRequest (composed seam)', () => {
  it('the pre-check wins: returns false, stamps once, and never throws', async () => {
    // If the pre-check were removed, the real funnel's throw would escape here — this
    // assertion is what pins graceful terminalization rather than a 5xx.
    let result: boolean | undefined;
    await expect(
      (async () => {
        result = await ingestImage({ image: image('https://evil.com/scan-me.png') });
      })()
    ).resolves.toBeUndefined();

    expect(result).toBe(false);
    expect(mockSubmitWorkflowWithRetry).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('the parser-ambiguous authority is refused through the composed path too', async () => {
    const result = await ingestImage({
      image: image(String.raw`https://image.civitai.com\@127.0.0.1:6379/x`),
    });

    expect(result).toBe(false);
    expect(mockSubmitWorkflowWithRetry).not.toHaveBeenCalled();
  });

  it('an allowed relative key reaches the real funnel and submits the resolved edge url', async () => {
    const result = await ingestImage({
      image: image('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png'),
    });

    expect(result).toBe(true);
    expect(mockSubmitWorkflowWithRetry).toHaveBeenCalledTimes(1);
    const body = mockSubmitWorkflowWithRetry.mock.calls[0][0].body;
    expect(String(body.arguments.mediaUrl)).toContain('https://image.test/');
  });
});
