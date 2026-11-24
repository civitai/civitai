import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationClient from '@civitai/orchestration-client';
import type * as OrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as ConsumerBlobUpload from '~/server/services/orchestrator/consumerBlobUpload';

const orchestrator = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
}));
vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  ...orchestrator,
}));

const tokens = vi.hoisted(() => ({ getOrchestratorToken: vi.fn(async () => 'seller-token') }));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorToken>()),
  ...tokens,
}));

const presign = vi.hoisted(() => ({ getConsumerBlobUploadUrlService: vi.fn() }));
vi.mock('~/server/services/orchestrator/consumerBlobUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsumerBlobUpload>()),
  ...presign,
}));

const { buildWatermarkedVideoPreview } = await import(
  '~/server/services/creator-service-deal-video-preview'
);
const { PreviewRejectedError } = await import('~/server/utils/service-deal-preview');

const SELLER = 42;
const BLOB_URL = 'https://orchestration.example/v2/consumer/blobs/source.mp4?sig=x';
const OUTPUT_URL = 'https://orchestration.example/v2/consumer/blobs/out.mp4?sig=y';
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const workflow = (status: string, url: string | null = OUTPUT_URL) => ({
  data: { status, steps: [{ status, output: url ? { url } : null }] },
});

beforeEach(() => {
  orchestrator.submitWorkflow.mockReset();
  presign.getConsumerBlobUploadUrlService.mockResolvedValue({
    uploadUrl: 'https://orchestration.example/upload?sig=z',
    expiresAt: '',
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    url === OUTPUT_URL
      ? new Response(Buffer.from('marked clip'))
      : new Response(JSON.stringify({ url: BLOB_URL }), { status: 201 })
  );
});

const submittedInput = () => orchestrator.submitWorkflow.mock.calls[0][0].body.steps[0].input;

describe('buildWatermarkedVideoPreview', () => {
  it('transcodes from an uploaded blob to a 480px, 15s, metadata-free clip with the mark burned in', async () => {
    orchestrator.submitWorkflow.mockResolvedValue(workflow('succeeded'));

    const result = await buildWatermarkedVideoPreview(Buffer.from('original'), 'video/mp4', SELLER);

    expect(result.data.toString()).toBe('marked clip');
    // The seller's media is uploaded under the seller's own token, never the system credentials.
    expect(tokens.getOrchestratorToken).toHaveBeenCalledWith(SELLER);
    expect(presign.getConsumerBlobUploadUrlService).toHaveBeenCalledWith({ token: 'seller-token' });
    const [uploadUrl, upload] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe('https://orchestration.example/upload?sig=z');
    expect(upload).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'video/mp4' } });

    const input = submittedInput();
    expect(input.sourceUrl).toBe(BLOB_URL);
    expect(input.width).toBe(480);
    expect(input.maxDuration).toBe(15);
    expect(input.hideMetadata).toBe(true);
    expect(input.watermark.image).toMatch(/^data:image\/png;base64,.{100,}/);
    expect(input.watermark.opacity).toBeGreaterThan(0);
  });

  it('rejects, without uploading, for a seller whose account is restricted', async () => {
    tokens.getOrchestratorToken.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'restricted' })
    );
    await expect(
      buildWatermarkedVideoPreview(Buffer.from('original'), 'video/mp4', SELLER)
    ).rejects.toThrow(new PreviewRejectedError('Preview unavailable right now.'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orchestrator.submitWorkflow).not.toHaveBeenCalled();
  });

  it('puts a failed transcode on the file, for the seller to replace', async () => {
    orchestrator.submitWorkflow.mockResolvedValue(workflow('failed', null));
    await expect(
      buildWatermarkedVideoPreview(Buffer.from('not a video'), 'video/mp4', SELLER)
    ).rejects.toBeInstanceOf(PreviewRejectedError);
  });

  it('rejects a file the blob upload refuses, without submitting a transcode', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad media', { status: 400 }));
    await expect(
      buildWatermarkedVideoPreview(Buffer.from('not a video'), 'video/mp4', SELLER)
    ).rejects.toBeInstanceOf(PreviewRejectedError);
    expect(orchestrator.submitWorkflow).not.toHaveBeenCalled();
  });

  it('throws a retryable error, not a rejection, when the transcode is still running', async () => {
    orchestrator.submitWorkflow.mockResolvedValue(workflow('processing', null));
    const error = await buildWatermarkedVideoPreview(
      Buffer.from('original'),
      'video/mp4',
      SELLER
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PreviewRejectedError);
  });
});
