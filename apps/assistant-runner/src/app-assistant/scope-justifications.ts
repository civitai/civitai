import { BLOCK_SLUG } from '@civitai/app-assistant';
import { unjustifiedSensitiveScopes } from '@civitai/shared/sensitive-block-scopes';

import { manifestOf } from './preview';
import type { SdkPinSandbox } from './sdk-pin';

/**
 * The sensitive scopes the open app's `block.manifest.json` declares without a justification, by
 * the rule civitai's submit applies. Empty when no app is open or the manifest cannot be read: the
 * submit itself still refuses such a manifest.
 */
export async function unjustifiedManifestScopes(
  sandbox: SdkPinSandbox,
  signal?: AbortSignal
): Promise<string[]> {
  const app = sandbox.active?.app;
  if (!app || !BLOCK_SLUG.test(app)) return [];
  try {
    const read = await sandbox.call('read_file', { path: `${app}/block.manifest.json` }, signal);
    const manifest = read.isError ? null : manifestOf(read.text);
    return manifest ? unjustifiedSensitiveScopes(manifest) : [];
  } catch {
    return [];
  }
}
