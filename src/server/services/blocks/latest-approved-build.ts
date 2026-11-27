import { dbRead } from '~/server/db/client';

/**
 * The app block's latest APPROVED publish request that names a build-repo commit (the sha the
 * platform wrote on approve, never a branch head): that commit and its version, or `null`.
 * Newest review first, then newest submit. The one definition of "the latest approved build"
 * (fork start, the fork backfill, a staff platform update's base).
 */
export async function latestApprovedBuild(
  appBlockId: string
): Promise<{ commitSha: string; version: string } | null> {
  const approved = await dbRead.appBlockPublishRequest.findFirst({
    where: { appBlockId, status: 'approved', forgejoCommitSha: { not: null } },
    orderBy: [{ reviewedAt: 'desc' }, { submittedAt: 'desc' }],
    select: { forgejoCommitSha: true, version: true },
  });
  return approved?.forgejoCommitSha
    ? { commitSha: approved.forgejoCommitSha, version: approved.version }
    : null;
}

/** {@link latestApprovedBuild}'s commit, or `null`. */
export async function latestApprovedCommitSha(appBlockId: string): Promise<string | null> {
  return (await latestApprovedBuild(appBlockId))?.commitSha ?? null;
}
