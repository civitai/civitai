/**
 * What an orchestrator blob HEAD says about its scan verdict.
 *
 * - `pending`: no verdict yet. A 503 (scan pending or failed), or a success that
 *   carries neither a level nor a block.
 * - `rated`: a verdict. `nsfwLevel` keeps `na` distinct from no verdict. A block
 *   shows as `X-Blocked-Reason` or as a `Location` to the blocked placeholder;
 *   🔴 reading only `X-NSFW-Level` misses blocks.
 * - `unavailable`: any other failure.
 */
export type BlobVerdictHeaders =
  | { status: 'pending' }
  | {
      status: 'rated';
      nsfwLevel: string | null;
      blockedReason: string | null;
      location: string | null;
    }
  | { status: 'unavailable'; httpStatus: number };

type HeaderReader = { get(name: string): string | null };

const BLOCKED_PLACEHOLDER_PATH = /\/blocked(\/|$|\?)/i;

export function parseBlobVerdictHeaders(
  headers: HeaderReader,
  httpStatus: number
): BlobVerdictHeaders {
  if (httpStatus === 503) return { status: 'pending' };
  if (httpStatus < 200 || httpStatus >= 400) return { status: 'unavailable', httpStatus };

  const nsfwLevel = headers.get('X-NSFW-Level')?.trim().toLowerCase() || null;
  const location = headers.get('Location') || null;
  const blockedHeader = headers.get('X-Blocked-Reason')?.trim() || null;
  const blockedReason =
    blockedHeader ?? (location && BLOCKED_PLACEHOLDER_PATH.test(location) ? 'blocked' : null);

  if (!nsfwLevel && !blockedReason) return { status: 'pending' };
  return { status: 'rated', nsfwLevel, blockedReason, location };
}
