import type { SessionUser } from '@civitai/auth';
import { feedbackAreaFlagKey } from '@civitai/shared/feedback.constants';
import { isFlagOn } from '../access';

/** Unlike app access, moderators get no bypass here; they go through the flag. */
export const feedbackEnabled = (user: SessionUser): Promise<boolean> =>
  isFlagOn(user, feedbackAreaFlagKey('knights'));
