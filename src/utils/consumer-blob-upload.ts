import type { Blob as OrchestratorBlob, ConsumerBlobPresignResponse } from '@civitai/client';

export type UploadConsumerBlobResponse = OrchestratorBlob;

const MAX_UPLOAD_SIZE = 64 * 1024 * 1024; // 64MB
const SUPPORTED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;

type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

/**
 * Fetches a presigned URL for uploading a blob to the orchestrator.
 * The returned URL points to POST /v2/consumer/blobs with a signature for authentication.
 */
export async function getConsumerBlobUploadUrl(): Promise<ConsumerBlobPresignResponse> {
  const response = await fetch('/api/orchestrator/getConsumerBlobUploadUrl');

  if (!response.ok) {
    throw new Error(response.status === 403 ? await response.text() : 'Failed to get upload URL');
  }

  return response.json();
}

/**
 * Uploads a blob/file to the orchestrator using a presigned URL.
 * This performs the upload directly from the browser.
 *
 * @param data - The binary data to upload (Blob or File)
 * @returns The uploaded blob metadata
 * @throws Error if file exceeds 64MB or has unsupported content type
 */
export async function uploadConsumerBlob(data: Blob | File): Promise<UploadConsumerBlobResponse> {
  // Validate file size
  if (data.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File size exceeds maximum of 64MB`);
  }

  // Validate content type
  const contentType = data.type as SupportedContentType;
  if (!SUPPORTED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(
      `Unsupported content type: ${
        data.type || 'unknown'
      }. Supported types: ${SUPPORTED_CONTENT_TYPES.join(', ')}`
    );
  }

  // Get the presigned upload URL
  const { uploadUrl } = await getConsumerBlobUploadUrl();

  // Upload to the presigned URL
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Length': data.size.toString(),
    },
    body: data,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Failed to upload blob: ${errorText}`);
  }

  return response.json();
}
