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
