/** The payload of `/api/minor-hash-detail/[modelId]`. */
export type HashDetail = {
  match: {
    minorModelId: number;
    minorModelName: string | null;
    minorModelVersionId: number | null;
    hash: string;
    /** Version of THIS model that carried the matched hash; Pending rows already know their own. */
    modelVersionId: number | null;
    /** This model's file carrying the hash. */
    fileName: string;
    fileSizeKB: number;
  } | null;
  detail: {
    modelCoverUrl: string | null;
    modelCoverType: string | null;
    modelCreatedAt: string | null;
    uploaderModelCount: number;
    uploaderJoinedAt: string | null;
    minorModelCoverUrl: string | null;
    minorModelCoverType: string | null;
    minorModelStatus: string | null;
    minorModelMode: string | null;
    minorModelUnpublishedAt: string | null;
    minorModelUnpublishedReason: string | null;
    minorModelDeletedAt: string | null;
    minorUsername: string | null;
    minorFlaggedAt: string | null;
    minorFlaggedByUsername: string | null;
  } | null;
};

export async function fetchHashDetail(
  modelId: number,
  minorModelId: number | null = null
): Promise<HashDetail> {
  const query = minorModelId ? `?minorModelId=${minorModelId}` : '';
  const res = await fetch(`/api/minor-hash-detail/${modelId}${query}`);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export type SeedOutcome = {
  /** `down` when the seed is off the site. */
  tone: 'down' | 'live';
  /** Reads after "was". */
  text: string;
  at: string | null;
  /** The unpublish reason key from the seed's meta, when one was recorded. */
  reason: string | null;
};

/** Unpublish reasons the site's own sweep writes when a model loses its images, versions or files. */
const SITE_SWEEP_REASONS = new Set(['no-posts', 'no-versions', 'no-files']);

/**
 * `status` alone misleads: a taken-down model can still read Published, and `Unpublished` is not always
 * the owner's, because the site's sweep writes it, with a reason, once a model loses its images.
 */
export function seedOutcome(d: NonNullable<HashDetail['detail']>): SeedOutcome {
  const at = d.minorModelUnpublishedAt;
  const reason = d.minorModelUnpublishedReason;
  if (d.minorModelStatus === 'Deleted' || d.minorModelDeletedAt)
    return { tone: 'down', text: 'deleted', at: d.minorModelDeletedAt, reason: null };
  if (d.minorModelMode === 'TakenDown')
    return { tone: 'down', text: 'taken down', at: null, reason: null };
  switch (d.minorModelStatus) {
    case 'UnpublishedViolation':
      return { tone: 'down', text: 'unpublished as a violation', at, reason };
    case 'Unpublished':
      if (!reason) return { tone: 'down', text: 'unpublished by its owner', at, reason: null };
      if (SITE_SWEEP_REASONS.has(reason))
        return { tone: 'down', text: 'unpublished by the site for missing content', at, reason };
      return { tone: 'down', text: 'unpublished', at, reason };
    case 'Draft':
      return { tone: 'down', text: 'moved back to draft', at: null, reason: null };
    case 'Published':
      return { tone: 'live', text: 'still published, flagged minor', at: null, reason: null };
    default:
      return {
        tone: 'live',
        text: `left in status ${d.minorModelStatus ?? 'unknown'}`,
        at: null,
        reason: null,
      };
  }
}
