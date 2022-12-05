import {
  IconBrandFacebook,
  IconBrandInstagram,
  IconBrandPatreon,
  IconBrandReddit,
  IconBrandTwitch,
  IconBrandTwitter,
  IconBrandYoutube,
  IconCup,
  IconMug,
  IconPigMoney,
  IconWorld,
  TablerIcon,
  TablerIconProps,
} from '@tabler/icons';
import { IconBrandHuggingFace } from '~/components/CustomIcons/IconHuggingFace';
import { getDomainLinkType, DomainLink } from '~/utils/domain-link';

export function DomainIcon({ url, ...iconProps }: { url: string } & TablerIconProps) {
  const type = getDomainLinkType(url);
  const Icon = type ? tablerIconMap[type] : IconWorld;
  return <Icon {...iconProps} />;
}

const tablerIconMap: { [key in DomainLink]: TablerIcon } = {
  huggingFace: IconBrandHuggingFace,
  twitter: IconBrandTwitter,
  twitch: IconBrandTwitch,
  reddit: IconBrandReddit,
  youtube: IconBrandYoutube,
  facebook: IconBrandFacebook,
  instagram: IconBrandInstagram,
  buyMeACoffee: IconCup,
  patreon: IconBrandPatreon,
  koFi: IconMug,
  coindrop: IconPigMoney,
};
