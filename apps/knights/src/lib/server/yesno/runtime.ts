import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';
import { yesNoSettings, type YesNoSettings } from './config';
import { createTagReviewPort, type TagReviewPort } from './tag-writeback';

/** Read per call so a changed environment is picked up without a rebuild; the moderators' saved values are read at most every 30s. */
export const yesNoConfig = async (): Promise<YesNoSettings> =>
  yesNoSettings(env, await storedSettings());

/** The moderator app's tag write-back, with the credential scoped to it. Read per call, like the settings above. */
export const tagReviewPort = (): TagReviewPort =>
  createTagReviewPort({
    endpoint: env.MODERATOR_APP_INTERNAL_URL || env.MODERATOR_APP_URL,
    token: env.KNIGHTS_TAG_REVIEW_TOKEN,
  });
