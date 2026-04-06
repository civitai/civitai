import { env } from '~/env/server';
import type { ImageUploadBackend } from '~/utils/s3-utils';

const STORAGE_RESOLVER_URL =
  env.STORAGE_RESOLVER_INTERNAL_URL ??
  'http://storage-resolver.storage-resolver.svc.cluster.local';
const STORAGE_RESOLVER_TOKEN = env.STORAGE_RESOLVER_INTERNAL_TOKEN;

export async function registerMediaLocation(
  uuid: string,
  backend: ImageUploadBackend,
  sizeBytes: number
) {
  if (!STORAGE_RESOLVER_TOKEN) return;
  try {
    await fetch(`${STORAGE_RESOLVER_URL}/register-media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${STORAGE_RESOLVER_TOKEN}`,
      },
      body: JSON.stringify({ uuid, backend, sizeBytes }),
    });
  } catch (e) {
    // Fire-and-forget — don't block uploads on registry failure
    console.error('Failed to register media location', uuid, e);
  }
}

export async function resolveMediaLocation(
  uuid: string
): Promise<{ backend: ImageUploadBackend; url: string } | null> {
  try {
    const res = await fetch(`${STORAGE_RESOLVER_URL}/resolve-media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(STORAGE_RESOLVER_TOKEN && { Authorization: `Bearer ${STORAGE_RESOLVER_TOKEN}` }),
      },
      body: JSON.stringify({ uuid }),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ backend: ImageUploadBackend; url: string }>;
  } catch {
    return null;
  }
}
