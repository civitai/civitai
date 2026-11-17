import { describe, expect, it, vi } from 'vitest';

vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      S3_UPLOAD_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
      S3_UPLOAD_BUCKET: 'civitai-modelfiles',
    } as Record<string, unknown>,
    { get: (target, prop: string) => target[prop] }
  ),
}));

const signed = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }));
vi.mock('@aws-sdk/s3-request-presigner', () => {
  const getSignedUrl = async (_client: unknown, command: { input: Record<string, unknown> }) => {
    signed.inputs.push(command.input);
    return 'https://signed.example/x';
  };
  return { getSignedUrl, default: { getSignedUrl } };
});

import { S3Client } from '~/utils/s3-client';
import { getGetUrl, getGetUrlByKey } from '~/utils/s3-utils';

// Pins that every presigned model download builds its Content-Disposition with the shared helper.
const hostile = 'a"\r\nb.safetensors';
const client = {} as never;

async function dispositionFrom(sign: () => Promise<unknown>) {
  signed.inputs.length = 0;
  await sign();
  return String(signed.inputs[0]?.ResponseContentDisposition);
}

describe.each([
  [
    's3-utils getGetUrl',
    () => getGetUrl('s3://civitai-modelfiles/a.safetensors', { s3: client, fileName: hostile }),
  ],
  [
    's3-utils getGetUrlByKey',
    () => getGetUrlByKey('a.safetensors', { s3: client, fileName: hostile }),
  ],
  [
    's3-client getGetUrl',
    () =>
      new S3Client({
        name: 'test',
        uploadKey: 'k',
        uploadSecret: 's',
        uploadEndpoint: 'https://s3.example',
        uploadRegion: 'auto',
      }).getGetUrl({
        bucket: 'b',
        key: 'a.safetensors',
        expiresIn: 60,
        filename: hostile,
      }),
  ],
])('%s', (_label, sign) => {
  it('signs a disposition with no raw quote or line break, carrying filename*', async () => {
    const disposition = await dispositionFrom(sign);
    expect(disposition).toBe(
      `attachment; filename="a_b.safetensors"; filename*=UTF-8''a%22b.safetensors`
    );
  });
});
