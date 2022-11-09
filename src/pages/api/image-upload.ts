import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
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

async function getUploadUrl(userId: number, metadata: Record<string, unknown> | null = null) {
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

  const result = (await response.json()) as DirectUploadResponse;
  if (!result.success) throw new Error(result.errors.join('\n'));

  return result.result;
}

export default async function imageUpload(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getUploadUrl(userId, req.body.metadata);

  res.status(200).json(result);
}
