import {
  IconBrandBilibili,
  IconBrandDeviantart,
  IconBrandDiscord,
  IconBrandFacebook,
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandLinktree,
  IconBrandPatreon,
  IconBrandReddit,
  IconBrandTelegram,
  IconBrandTumblr,
  IconBrandTwitch,
  IconBrandVk,
  IconBrandX,
  IconBrandYoutube,
  IconCup,
  IconMug,
  IconPigMoney,
  IconWorld,
  Icon as TablerIcon,
  TablerIconsProps,
  IconBrandLinkedin,
} from '@tabler/icons-react';
import { IconCivitai } from '~/components/SVG/IconCivitai';
import { IconBrandHuggingFace } from '~/components/SVG/IconHuggingFace';
import { DomainLink, getDomainLinkType } from '~/utils/domain-link';

export function DomainIcon({
  url,
  domain,
  ...iconProps
}: { url?: string; domain?: DomainLink } & TablerIconsProps) {
  const type = url ? getDomainLinkType(url) : domain;
  const Icon = type ? tablerIconMap[type] : IconWorld;
  return <Icon {...iconProps} />;
}

const tablerIconMap: { [key in DomainLink]: TablerIcon } = {
  huggingFace: IconBrandHuggingFace,
  twitter: IconBrandX,
  x: IconBrandX,
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
  telegram: IconBrandTelegram,
  vk: IconBrandVk,
  bilibili: IconBrandBilibili,
  civitai: IconCivitai,
  linkedin: IconBrandLinkedin,
};
