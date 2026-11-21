import { Air } from '@civitai/orchestration-client';
import { ORCHESTRATOR_PROXY_HOST } from '~/server/orchestrator/region-proxy';
import { isWorkflowOwnedBy } from '~/server/services/orchestrator/assert-workflow-owner';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';

// The one decision on what an app-built step may name at a media input besides a URL or a reference.

// An orchestrator AIR the AIR grammar cannot read is still one to the orchestrator.
const ORCHESTRATOR_SOURCE_RE = /(^|:)orchestrator:/i;
// A URL only as http(s):// or a media data URI; any other scheme is held to the AIR rule.
const URL_VALUE_RE = /^(https?:\/\/|data:(image|video|audio)\/[a-z0-9.+-]+(;[^,]*)?,)/i;
// An orchestrator blob key, with or without a file extension, and a training blob key.
const BLOB_KEY_RE = /^([0-9a-z]{26}(\.[0-9a-z]{1,10})?|[0-9a-f]{32}(\.[0-9a-z]{1,10})?)$/i;
// The orchestrator reads a blob from this path on any host.
const BLOB_PATH_RE = /\/consumer\/blobs\//i;
const BARE_ID_RE = /^\d+$/;

export type MediaReferenceRefusal = 'air' | 'blob-key' | 'bare-id' | 'blob-url';

/** A URL whose path names an orchestrator blob, on a host that is not the orchestrator's. */
function isForeignHostBlobUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  let path = parsed.pathname;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    } catch {
      return true;
    }
  }
  if (!BLOB_PATH_RE.test(path.replace(/\\/g, '/'))) return false;
  return !isTrustedOrchestratorUrl(value) && parsed.host.toLowerCase() !== ORCHESTRATOR_PROXY_HOST;
}

/** Whether `value` names the orchestrator source at all (an AIR, or a token in text). */
export function namesOrchestratorSource(value: string): boolean {
  return ORCHESTRATOR_SOURCE_RE.test(value);
}

/** A job file is `orchestrator:<jobId>@<file>`, owned by the user its id names. A blob names no
 *  owner, so it is never the viewer's own. */
export function isOwnOrchestratorFile(value: string, viewerId: number): boolean {
  const parsed = Air.parseSafe(value);
  return (
    parsed?.source.toLowerCase() === 'orchestrator' &&
    parsed.id.toLowerCase() !== 'blob' &&
    isWorkflowOwnedBy(parsed.id, viewerId)
  );
}

/** Why a value at a media input is refused, or null. URLs are otherwise the source gate's to judge. */
export function mediaReferenceRefusal(raw: string, viewerId: number): MediaReferenceRefusal | null {
  const value = raw.trim();
  if (BARE_ID_RE.test(value)) return 'bare-id';
  if (BLOB_KEY_RE.test(value)) return 'blob-key';
  if (URL_VALUE_RE.test(value)) return isForeignHostBlobUrl(value) ? 'blob-url' : null;
  // Anything else naming a scheme or source (an AIR in any spelling) is refused.
  if (value.includes(':')) return isOwnOrchestratorFile(value, viewerId) ? null : 'air';
  return null;
}
