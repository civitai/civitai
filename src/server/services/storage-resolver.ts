import { env } from '~/env/server';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import type { ImageUploadBackend } from '~/utils/s3-utils';

const STORAGE_RESOLVER_URL =
  env.STORAGE_RESOLVER_INTERNAL_URL ?? 'http://storage-resolver.storage-resolver.svc.cluster.local';
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
      signal: fetchTimeoutSignal(60_000),
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
      signal: fetchTimeoutSignal(60_000),
    });
    if (!res.ok) return null;
    // `await` is load-bearing, not style. `return res.json()` inside a try returns the promise and
    // leaves the try before it settles, so the async function adopts a REJECTION that this catch
    // never sees — and the signature says `| null`, so every caller is written as if it cannot
    // throw. A 200 carrying a non-JSON body (an ingress/proxy error page) is exactly that case.
    return (await res.json()) as { backend: ImageUploadBackend; url: string };
  } catch {
    return null;
  }
}
