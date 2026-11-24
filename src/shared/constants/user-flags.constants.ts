/**
 * User Flags — Bitwise opt-out / behavior flags stored on `User.flags`.
 *
 * Each flag is a power of 2 so they can be combined with bitwise OR.
 * Use `Flags.hasFlag(user.flags, UserFlag.DisablePayout)` to check.
 */
export const UserFlag = {
  None: 0,

  /** User opts out of receiving creator payouts (tips + creator compensation) on their content. */
  DisablePayout: 1 << 0, // 1

  /**
   * Moderator-set: the user's actions earn no event points and count toward no event standings. With
   * `meta.eventPointsExcludedFrom` set, only from that UTC day on (see player-eligibility.ts).
   */
  ExcludeFromEventPoints: 1 << 1, // 2

  /** Moderator-set, after a second moderator confirms: the account holder has died. See memorial.service. */
  Memorialized: 1 << 2, // 4
} as const;

/** The `User.meta` key holding the ExcludeFromEventPoints start day; read by eventPointsExcludedFromSql. */
export const EVENT_POINTS_EXCLUDED_FROM_META_KEY = 'eventPointsExcludedFrom';

export type UserFlagValue = (typeof UserFlag)[keyof typeof UserFlag];

export const userFlagLabels: Record<number, string> = {
  [UserFlag.DisablePayout]: 'Disable creator payouts',
  [UserFlag.ExcludeFromEventPoints]: 'Exclude from event points',
  [UserFlag.Memorialized]: 'Memorialized',
};
