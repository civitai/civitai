import { isAvatarStarterReference } from '~/shared/constants/avatar-starters';
import { avatarStyleByKey } from '~/shared/constants/avatar-styles.constants';

/** The `/generate?workflow=img2img:avatar` link's own params, read by the generator's ingestion. */
export const AVATAR_DEEP_LINK_PARAMS = ['avatarStyle', 'avatarReference'] as const;

/**
 * The avatar fields a landing-page link may preselect: a known style, and one of its starter
 * characters as the reference. Anything else is dropped, so a link can never seed a URL reference.
 */
export function avatarDeepLinkFields(params: URLSearchParams): Record<string, string> {
  const style = params.get('avatarStyle');
  if (!style || !avatarStyleByKey.has(style)) return {};
  const reference = params.get('avatarReference');
  return {
    avatarStyle: style,
    avatarReference: reference && isAvatarStarterReference(reference) ? reference : 'cover',
    // A fresh style starts a fresh avatar, as picking one in the form does.
    avatarParentImage: '',
  };
}
