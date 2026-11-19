import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/** Why a restricted image is refused, as a lowercase clause: messages embed it or capitalize it. */
export const RESTRICTED_IMAGE_REASON =
  "the model it was made with doesn't allow mature images to be shared";

/**
 * A mature image made with a base model that restricts mature images; a missing flag counts as
 * restricted. TS twin of `imageNotRestrictedSql` without the uploader exception.
 */
export const isRestrictedImage = (image: {
  nsfwLevel: number;
  modelRestricted: boolean | null | undefined;
}) => (image.nsfwLevel & nsfwBrowsingLevelsFlag) !== 0 && image.modelRestricted !== false;
