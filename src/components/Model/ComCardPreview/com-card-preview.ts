type CardViewer = { isOwnerOrModerator: boolean; onComSite: boolean };

export function canPreviewComCard(
  { isOwnerOrModerator, onComSite }: CardViewer,
  sfwName: string | null | undefined
) {
  return isOwnerOrModerator && !onComSite && sfwName != null;
}

export function canLinkToRedCard(
  { isOwnerOrModerator, onComSite }: CardViewer,
  sfwName: string | null | undefined
) {
  return isOwnerOrModerator && onComSite && sfwName != null;
}

/** civitai.com shows no version descriptions while a model has its own card. */
export function withComCard<
  T extends {
    name: string;
    description?: string | null;
    sfwName?: string | null;
    sfwDescription?: string | null;
    modelVersions: { description?: string | null }[];
  }
>(model: T): T {
  if (model.sfwName == null) return model;
  return {
    ...model,
    name: model.sfwName,
    description: model.sfwDescription ?? null,
    modelVersions: model.modelVersions.map((version) => ({ ...version, description: null })),
  };
}
