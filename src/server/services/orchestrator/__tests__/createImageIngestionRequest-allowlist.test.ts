import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSubmitWorkflowWithRetry, mockIsFlipt, mockSubmitWorkflow } = vi.hoisted(() => ({
  mockSubmitWorkflowWithRetry: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: mockSubmitWorkflowWithRetry,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_INGESTION_IMAGE_SCANNING: 'image_ingestion_image_scanning' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
// 🔴 Pin the edge host. `@prisma/client`'s runtime dotenv-loads `<repo>/.env` into
// process.env at import, so without this the expected `mediaUrl` below depends on whether
// the checkout happens to have a `.env`: empty here (a fresh worktree) but set in any
// standard dev tree, and `.env-example` tells developers to use `http://localhost:3000`.
// MEASURED: forcing the var red-lines the literal at :72. Siblings stub it the same way
// (remix-provenance.test.ts, announcement-media-check.test.ts, cf-images-utils.test.ts).
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));
// Surface enums consumed at module-load time (mirrors createModelFileScanRequest.test).
vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));

import {
  createImageIngestionRequest,
  imageIngestionLogName,
} from '~/server/services/orchestrator/orchestrator.service';

const EVIL_URL = 'https://evil.com/scan-me.png';
const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png';

/**
 * 🔴 A DEFAULT resolution, not a bare `mockReset()`. This suite holds the ONLY assertion
 * guarding the funnel's backstop throw, and with no default the mock returns `undefined`, so
 * removing that throw made the test die on `Cannot destructure property 'data'` — the
 * assertion after it (`mockIsFlipt` must not have been called, i.e. the rejection is not
 * ordered behind the Flipt read) never ran, and the printed cause pointed at a broken mock.
 */
const allowSubmitByDefault = () =>
  mockSubmitWorkflowWithRetry.mockReset().mockResolvedValue({
    data: { id: 'must-not-happen' },
    response: undefined,
    attempts: 1,
  });

beforeEach(() => {
  allowSubmitByDefault();
  mockIsFlipt.mockReset();
  mockSubmitWorkflow.mockReset();
});

describe('createImageIngestionRequest URL allowlist (orchestrator funnel)', () => {
  it('throws before any orchestrator interaction for an off-allowlist absolute URL', async () => {
    await expect(
      createImageIngestionRequest({ imageId: 4242, url: EVIL_URL, type: 'image' })
    ).rejects.toThrow('not on the ingestion allowlist');

    expect(mockSubmitWorkflowWithRetry).not.toHaveBeenCalled();
    // The rejection must not depend on, or be ordered behind, the Flipt read.
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('submits an allowed relative storage key, resolved onto the edge', async () => {
    mockSubmitWorkflowWithRetry.mockResolvedValue({
      data: { id: 'wf-1' },
      response: undefined,
      attempts: 1,
    });

    const { data } = await createImageIngestionRequest({
      imageId: 4242,
      url: STORAGE_KEY,
      type: 'image',
    });

    expect(data?.id).toBe('wf-1');
    expect(mockSubmitWorkflowWithRetry).toHaveBeenCalledTimes(1);
    const body = mockSubmitWorkflowWithRetry.mock.calls[0][0].body;
    // getEdgeUrl with no name passes the src itself as `name`, re-extending it — so the
    // src appears twice. Pinned to the literal getEdgeUrl emits, against the mocked host.
    expect(body.arguments.mediaUrl).toBe(
      'https://image.test/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.png/original=true/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/name.jpeg'
    );
  });

  it('submits the NORMALIZED absolute url, so the fetcher resolves the host we validated', async () => {
    mockSubmitWorkflowWithRetry.mockResolvedValue({
      data: { id: 'wf-3' },
      response: undefined,
      attempts: 1,
    });

    await createImageIngestionRequest({
      imageId: 4242,
      url: 'http:/image.civitai.com/a/b.png',
      type: 'image',
    });

    const body = mockSubmitWorkflowWithRetry.mock.calls[0][0].body;
    // Not the caller's slash-light spelling — the parsed href.
    expect(body.arguments.mediaUrl).toBe('http://image.civitai.com/a/b.png');
  });

  it('submits an allowed avatar url (the only external host class)', async () => {
    mockSubmitWorkflowWithRetry.mockResolvedValue({
      data: { id: 'wf-2' },
      response: undefined,
      attempts: 1,
    });

    const { data } = await createImageIngestionRequest({
      imageId: 4242,
      url: 'https://lh3.googleusercontent.com/a/AAcHTtf=s96-c',
      type: 'image',
    });

    expect(data?.id).toBe('wf-2');
    expect(mockSubmitWorkflowWithRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the per-lane log-name helper untouched', () => {
    expect(imageIngestionLogName(false)).toBe('image-ingestion');
    expect(imageIngestionLogName(true)).toBe('image-scanning-ingestion');
  });
});
