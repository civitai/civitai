import { createHash } from 'node:crypto';
import type { CommentGoneCause } from '~/server/services/commentv3/write.service';

/**
 * What the platform should hold for one Feature Pages comment. Only ever tightens: visible, hidden,
 * then no text. The last four are final.
 */
export type FpCommentState =
  | 'visible'
  | 'mod-hidden'
  | 'mod-removed'
  | 'retracted'
  | 'erased'
  | 'refused';

/** States that leave no text on the platform, so an edit or a rename re-posts nothing. */
const GONE_STATES: readonly FpCommentState[] = ['mod-removed', 'retracted', 'erased', 'refused'];

export type FpCommentFacts = {
  goneCause: CommentGoneCause | null;
  pushedState: string | null;
  comment: { hidden: boolean; tosViolation: boolean; deletedAt: Date | null } | null;
  author: { deletedAt: Date | null } | null;
  /** Held in the csam queue: a pending or confirmed hold, or a csam verdict not dismissed. */
  csamHeld: boolean;
  /** The platform holds, or is being sent, a removal. */
  removeWanted: boolean;
};

/** The one place that decides a Feature Pages comment's platform state. */
export function fpCommentState(f: FpCommentFacts): FpCommentState {
  if (f.goneCause === 'refused') return 'refused';
  if (f.pushedState === 'erased' || !f.author || f.author.deletedAt) return 'erased';
  if (f.goneCause === 'author') return 'retracted';
  // Gone with no cause recorded (a cascade) is removed too, so its text leaves the platform.
  if (f.goneCause || !f.comment || f.comment.deletedAt || f.csamHeld || f.removeWanted)
    return 'mod-removed';
  if (f.comment.hidden || f.comment.tosViolation) return 'mod-hidden';
  return 'visible';
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The mirror's own change digest for what a post carries: the author's name, the text and its
 * version. A rename or an edit changes it; a state change does not (pushedState tracks that). Empty
 * for a state that leaves no text on the platform.
 */
export function fpPostDigest(
  state: FpCommentState,
  post: { authorName: string; content: string; version: number }
) {
  if (GONE_STATES.includes(state)) return '';
  return sha256(`${post.authorName}\u0000${post.version}\u0000${sha256(post.content)}`);
}

export const isFpPostable = (state: FpCommentState) => !GONE_STATES.includes(state);

/** What the next push is for: the state and the post together. */
export const fpWantDigest = (state: FpCommentState, postDigest: string) =>
  sha256(`${state}\u0000${postDigest}`);
