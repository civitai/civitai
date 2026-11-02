import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Whether `ImageGuard2` treats a rating as NSFW, i.e. whether the viewer's blur settings decide if
 * the media shows. False ⇒ the guard always shows it, whoever is viewing. Note `0` (unrated) is a
 * subset of every flag, so it counts as NSFW here.
 *
 * Pure and React-free so the image page's preload
 * (`~/components/Image/DetailV2/image-detail-main-media`) asks the guard's own question.
 */
export function isImageGuardNsfw(nsfwLevel: number) {
  return Flags.hasFlag(nsfwBrowsingLevelsFlag, nsfwLevel);
}
