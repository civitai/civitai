import {
  IconBrandDeviantart,
  IconBrandDiscord,
  IconBrandFacebook,
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandLinktree,
  IconBrandPatreon,
  IconBrandReddit,
  IconBrandTumblr,
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
import { IconBrandHuggingFace } from '~/components/SVG/IconHuggingFace';
import { getDomainLinkType, DomainLink } from '~/utils/domain-link';

export function DomainIcon({
  url,
  domain,
  ...iconProps
}: { url?: string; domain?: DomainLink } & TablerIconProps) {
  const type = url ? getDomainLinkType(url) : domain;
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
  discord: IconBrandDiscord,
  github: IconBrandGithub,
  linktree: IconBrandLinktree,
  deviantArt: IconBrandDeviantart,
  tumblr: IconBrandTumblr,
};
