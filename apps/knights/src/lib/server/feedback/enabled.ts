import type { SessionUser } from '@civitai/auth';
import { feedbackAreaFlagKey } from '@civitai/shared/feedback.constants';
import { isFlagOn } from '../access';

/** Whether this player may send feedback. Moderators go through the flag like everyone else; Flipt down means off. */
export const feedbackEnabled = (user: SessionUser): Promise<boolean> =>
  isFlagOn(user, feedbackAreaFlagKey('knights'));
