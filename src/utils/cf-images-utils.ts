import { env } from '~/env/server.mjs';

type DirectUploadResponse = {
  success: boolean;
  result?: {
    uploadURL: string;
    id: string;
  };
  result_info: unknown;
  errors: string[];
  messages: string[];
};

const missingEnvs = (): string[] => {
  const keys = [];
  if (!env.CF_ACCOUNT_ID) keys.push('CF_ACCOUNT_ID');
  if (!env.CF_IMAGES_TOKEN) keys.push('CF_IMAGES_TOKEN');
  return keys;
};

export async function getUploadUrl(
  userId: number,
  metadata: Record<string, unknown> | null = null
) {
  const missing = missingEnvs();
  if (missing.length > 0)
    throw new Error(`CloudFlare Image Upload: Missing ENVs ${missing.join(', ')}`);

  metadata ??= {};
  const body = new FormData();
  body.append('requireSignedURLs', 'false');
  body.append('metadata', JSON.stringify({ userId, ...metadata }));

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v2/direct_upload`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_IMAGES_TOKEN}`,
      },
      body,
    }
  );

  if (!response.ok) throw new Error(response.statusText);
  const result = (await response.json()) as DirectUploadResponse;
  if (!result.success) throw new Error(result.errors.join('\n'));

  return result.result;
}

type DeleteImageResponse = {
  success: boolean;
  errors: { code: number; message: string }[];
};

export async function deleteImage(id: string) {
  const missing = missingEnvs();
  if (missing.length > 0)
    throw new Error(`CloudFlare Image Upload: Missing ENVs ${missing.join(', ')}`);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1/${id}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${env.CF_IMAGES_TOKEN}`,
      },
    }
  );

  if (!response.ok) throw new Error(response.statusText);
  const result = (await response.json()) as DeleteImageResponse;
  if (!result.success) throw new Error(result.errors.map((x) => x.message).join('\n'));

  return result.success;
}

export async function uploadViaUrl(url: string, metadata: Record<string, unknown> | null = null) {
  const missing = missingEnvs();
  if (missing.length > 0)
    throw new Error(`CloudFlare Image Upload: Missing ENVs ${missing.join(', ')}`);

  metadata ??= {};
  const body = new FormData();
  body.append('url', url);
  body.append('requireSignedURLs', 'false');
  body.append('metadata', JSON.stringify(metadata));

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_IMAGES_TOKEN}`,
      },
      body,
    }
  );

  const result = (await response.json()) as UploadViaUrlResponse;
  if (!result.success) throw new Error(result.errors.join('\n'));

  return result.result;
}

type UploadViaUrlResponse = {
  result: {
    id: string;
  };
  success: boolean;
  errors: string[];
};
