/** The payload of `/api/minor-hash-detail/[modelId]`. */
export type HashDetail = {
  match: {
    minorModelId: number;
    minorModelName: string | null;
    minorModelVersionId: number | null;
    hash: string;
    /** The version of THIS model that carried the matched hash. Only the auto/appeals tabs get it
     *  from here — the Pending row already knows its own. */
    modelVersionId: number | null;
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
