import type { ActionIconProps } from '@mantine/core';
import { ActionIcon } from '@mantine/core';
import type { Icon, IconProps } from '@tabler/icons-react';
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandReddit,
  IconBrandTiktok,
  IconBrandTwitch,
  IconBrandX,
  IconBrandYoutube,
} from '@tabler/icons-react';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import { ShellLink } from '~/components/AppLayout/ShellDs/ShellDs';
import { useIsLive } from '~/hooks/useIsLive';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

const defaultProps: ActionIconProps = {
  size: 'lg',
  radius: 'xl',
};

type SocialOption =
  | 'github'
  | 'discord'
  | 'twitter'
  | 'youtube'
  | 'instagram'
  | 'tiktok'
  | 'reddit'
  | 'twitch';
type Props = ActionIconProps & {
  iconSize?: number;
  include?: SocialOption[];
};

const SocialIcons: Record<
  SocialOption,
  ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>
> = {
  github: IconBrandGithub,
  discord: IconBrandDiscord,
  twitter: IconBrandX,
  instagram: IconBrandInstagram,
  tiktok: IconBrandTiktok,
  reddit: IconBrandReddit,
  youtube: IconBrandYoutube,
  twitch: IconBrandTwitch,
};

const SocialLabels: Record<SocialOption, string> = {
  github: 'Civitai on GitHub',
  discord: 'Civitai on Discord',
  twitter: 'Civitai on X',
  instagram: 'Civitai on Instagram',
  tiktok: 'Civitai on TikTok',
  reddit: 'Civitai on Reddit',
  youtube: 'Civitai on YouTube',
  twitch: 'Civitai on Twitch',
};

const defaultInclude: SocialOption[] = [
  'discord',
  'twitter',
  'instagram',
  'youtube',
  'tiktok',
  'reddit',
  'github',
  'twitch',
];

export function SocialLinks({ iconSize = 20, include, ...props }: Props) {
  include ??= defaultInclude;
  const isLive = useIsLive();

  return (
    <>
      {include.map((option) => {
        const Icon = SocialIcons[option];
        const optionProps: ActionIconProps = {};
        if (option === 'twitch' && isLive) {
          optionProps.variant = 'filled';
          optionProps.color = 'red';
          (optionProps as HTMLBaseElement).title = 'Live now!';
        }
        return (
          <LegacyActionIcon
            key={option}
            component="a"
            variant="subtle"
            color="gray"
            href={`/${option}`}
            target="_blank"
            rel="nofollow noreferrer"
            aria-label={SocialLabels[option]}
            {...defaultProps}
            {...props}
            {...optionProps}
          >
            <Icon size={iconSize} />
          </LegacyActionIcon>
        );
      })}
    </>
  );
}

/**
 * The footer's social links as `@civitai/components` markup (flag `shellDesignSystemMarkup`) —
 * the same eight links, labels, hrefs and live-on-Twitch state as `SocialLinks` with its
 * defaults (`ActionIcon` `size="lg"`, `radius="xl"`, subtle gray). Takes no Mantine props: its
 * only caller is the page shell, and `SocialHomeBlock`'s sized variant stays on `SocialLinks`.
 */
export function ShellSocialLinks() {
  const isLive = useIsLive();

  return (
    <>
      {defaultInclude.map((option) => {
        const Icon = SocialIcons[option];
        const live = option === 'twitch' && isLive;
        return (
          <ShellLink
            key={option}
            href={`/${option}`}
            target="_blank"
            rel="nofollow noreferrer"
            aria-label={SocialLabels[option]}
            title={live ? 'Live now!' : undefined}
            variant={live ? 'filled-red' : 'subtle-gray'}
            icon="lg"
            radius="xl"
          >
            <Icon size={20} />
          </ShellLink>
        );
      })}
    </>
  );
}
