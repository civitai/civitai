/** What a moderator sees of a Feature Pages comment's hide, and posts back to act on it. */
export type FpCommentState = {
  hidden: boolean;
  /** `hiddenAt::text`, microseconds kept: the hide an unhide is bound to. */
  hiddenAt: string | null;
  /** The text version a hide or unhide is bound to. */
  version: number;
  /** The current hide is the text scan's: its scan report's dismissal lifts it, not Unhide. */
  scanHide: boolean;
  tosViolation: boolean;
};
