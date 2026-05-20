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
} as const;

export type UserFlagValue = (typeof UserFlag)[keyof typeof UserFlag];

export const userFlagLabels: Record<number, string> = {
  [UserFlag.DisablePayout]: 'Disable creator payouts',
};
