export type PaidAccessViewer = { id?: number | null; isModerator?: boolean | null };

export const isOwnerOrModView = (viewer: PaidAccessViewer, ownerId: number) =>
  (!!viewer.id && viewer.id === ownerId) || !!viewer.isModerator;
