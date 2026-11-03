type CardViewer = { isOwnerOrModerator: boolean; onComSite: boolean };

/** The owner or a moderator on civitai.red, on a model that has a civitai.com card. */
export function canPreviewComCard(
  { isOwnerOrModerator, onComSite }: CardViewer,
  sfwName: string | null | undefined
) {
  return isOwnerOrModerator && !onComSite && sfwName != null;
}

/** The owner or a moderator on civitai.com, on a model that has a civitai.com card. */
export function canLinkToRedCard(
  { isOwnerOrModerator, onComSite }: CardViewer,
  sfwName: string | null | undefined
) {
  return isOwnerOrModerator && onComSite && sfwName != null;
}

/** The model as civitai.com shows it: its card's title and description, no version descriptions. */
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
