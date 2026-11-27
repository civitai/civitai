import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * Whether this viewer is in the personal-hot-lead cohort. The one evaluation of the flag: the Hot
 * feed reads it to lead with the viewer's models, and feed events to tag the viewer's rows, so the
 * cohort a row names is the cohort that saw the feed.
 */
export const isPersonalHotLeadViewer = (user: SessionUser) =>
  isFlipt(FLIPT_FEATURE_FLAGS.PERSONAL_HOT_LEAD, String(user.id), buildFliptContext(user));
