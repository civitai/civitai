import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

export async function registerFileLocation(params: {
  fileId: number;
  modelVersionId: number;
  modelId: number;
  backend: string;
  path: string;
  sizeKb: number;
}) {
  if (!env.STORAGE_RESOLVER_INTERNAL_URL || !env.STORAGE_RESOLVER_INTERNAL_TOKEN) {
    // Surface misconfig to Axiom — silently skipping here breaks downloads
    // just as surely as a thrown error, and callers' catch blocks never fire.
    logToAxiom({
      type: 'warning',
      name: 'register-file-location-skipped',
      reason: 'storage-resolver-not-configured',
      ...params,
    }).catch(() => undefined);
    return;
  }

  const response = await fetch(`${env.STORAGE_RESOLVER_INTERNAL_URL}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.STORAGE_RESOLVER_INTERNAL_TOKEN}`,
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`Failed to register file location: ${response.status} ${text}`);
  }

  return response.json();
}
