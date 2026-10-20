export type MutedNoticeVariant = 'upheld' | 'accept-terms' | 'pending-review';

/**
 * A two-strike mute also has `mutedAt` null, but it lifts on accepting the Terms, not by moderator
 * review.
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
