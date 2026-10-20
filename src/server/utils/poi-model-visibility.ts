type Viewer = { id?: number | null; isModerator?: boolean | null } | null | undefined;

/**
 * Whether `viewer` may see something restricted to its owner and moderators.
 * Fails closed: no viewer, a viewer without an id, or no owner all read as hidden.
 */
export function canViewOwnerOnly(ownerId: number | null | undefined, viewer?: Viewer): boolean {
  if (viewer?.isModerator) return true;

  const viewerId = Number(viewer?.id);
  const owner = Number(ownerId);
  return Number.isInteger(viewerId) && viewerId > 0 && viewerId === owner;
}

/** Whether `viewer` may see a model flagged `poi`: moderators and the model's owner only. */
export function canViewPoiModel(
  poi: boolean | null | undefined,
  ownerId: number | null | undefined,
  viewer?: Viewer
): boolean {
  if (!poi) return true;
  return canViewOwnerOnly(ownerId, viewer);
}
