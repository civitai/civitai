type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

/**
 * Whether `viewer` may see a model flagged `poi`: moderators and the model's owner only.
 * Fails closed: no viewer, a viewer without an id, or a model without an owner all read as hidden.
 */
export function canViewPoiModel(
  poi: boolean | null | undefined,
  ownerId: number | null | undefined,
  viewer?: Viewer
): boolean {
  if (!poi) return true;
  if (viewer?.isModerator) return true;

  const viewerId = Number(viewer?.id);
  const owner = Number(ownerId);
  return Number.isInteger(viewerId) && viewerId > 0 && viewerId === owner;
}
