/**
 * Who sees that a placed sticker cost nothing.
 *
 * The owner, the placer and moderators — nobody else. Everything else in this
 * feature treats free-vs-paid as private between the two parties to it: the
 * pending queue says "only you and the placer can see these", the hidden note
 * says "only you, the person who placed it, and moderators". A public mark would
 * be the first thing telling a stranger how a placement was funded, and it would
 * say it about the owner's own settings on every image they own.
 *
 * A decision, not caution — see the PR. The overlay renders nothing at all when
 * this is false rather than hiding a mark with CSS, because a hidden element is
 * still in the DOM and that is not what the sentences above promise.
 */
export function freeMarkerVisible({
  free,
  isPending,
  ownerId,
  placerId,
  viewerId,
  isModerator = false,
}: {
  free: boolean;
  /**
   * Only while the owner has not answered it — Justin's call. Once a sticker is
   * approved it is on the image on its own terms, and how it was funded stops
   * being what the owner is deciding about.
   */
  isPending: boolean;
  ownerId: number;
  placerId: number;
  /** Signed out is `undefined`, which must not match an id. */
  viewerId?: number;
  isModerator?: boolean;
}) {
  if (!free || !isPending) return false;
  if (isModerator) return true;
  return viewerId != null && (viewerId === ownerId || viewerId === placerId);
}
