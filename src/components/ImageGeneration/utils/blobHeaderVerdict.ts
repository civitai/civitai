import type { NsfwLevel } from '@civitai/client';

import { isMature, isPrivateMature } from '~/shared/constants/orchestrator.constants';

export type BlobHeaderVerdict = { nsfwLevel?: NsfwLevel; blockedReason?: string };

/** `null` when the response settles nothing, so the caller keeps the output hidden. */
export function parseBlobHeaderVerdict(
  response: Pick<Response, 'ok' | 'headers'>
): BlobHeaderVerdict | null {
  const level = response.headers.get('X-NSFW-Level')?.toLowerCase() as NsfwLevel | undefined;
  const blockedReason = response.headers.get('X-Blocked-Reason') || undefined;
  if (blockedReason) return { nsfwLevel: level || undefined, blockedReason };
  if (!response.ok) return null;
  // An absent rating is not a safe one, unless the orchestrator says no scan applies.
  if (level) return { nsfwLevel: level };
  return response.headers.get('X-Scan-Status') === 'NotRequired' ? {} : null;
}

/** Mirrors the green mapping in `BlobData` (workflow-data.ts); keep the two in sync. */
export function greenBlockedReason(
  { nsfwLevel, blockedReason }: BlobHeaderVerdict,
  isPrivateGeneration: boolean
) {
  if (blockedReason === 'MatureContent') return 'siteRestricted';
  if (blockedReason) return blockedReason;
  if (isPrivateGeneration && isPrivateMature(nsfwLevel)) return 'privateGen';
  if (isMature(nsfwLevel)) return 'siteRestricted';
  return undefined;
}
