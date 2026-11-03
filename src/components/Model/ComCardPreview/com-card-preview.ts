type CardViewer = { isOwnerOrModerator: boolean; onComSite: boolean };

export function getCardViewer(
  user: { id: number; isModerator?: boolean } | null | undefined,
  ownerId: number | undefined,
  onComSite: boolean
): CardViewer {
  return {
    isOwnerOrModerator: !!user && (!!user.isModerator || user.id === ownerId),
    onComSite,
  };
}

type CardPair = {
  name: string;
  description?: string | null;
  sfwName?: string | null;
  sfwDescription?: string | null;
};

export function canPreviewComCard(
  { isOwnerOrModerator, onComSite }: CardViewer,
  model: CardPair | undefined
) {
  if (!isOwnerOrModerator || onComSite || model?.sfwName == null) return false;
  // A viewer without mature content is already served the .com card, so there is nothing to swap.
  return (
    model.name !== model.sfwName || (model.description ?? null) !== (model.sfwDescription ?? null)
  );
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
