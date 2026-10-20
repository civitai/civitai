export type MutedNoticeVariant = 'upheld' | 'accept-terms' | 'pending-review';

/**
 * Which restriction the muted notice describes. A two-strike mute also leaves `mutedAt` null, but no
 * moderator reviews it: it lifts when the user accepts the Terms, so the review copy would be false.
 */
export function mutedNoticeVariant({
  mutedAt,
  tosReacceptanceOffered,
}: {
  mutedAt?: Date | string | null;
  tosReacceptanceOffered: boolean;
}): MutedNoticeVariant {
  if (mutedAt) return 'upheld';
  if (tosReacceptanceOffered) return 'accept-terms';
  return 'pending-review';
}
