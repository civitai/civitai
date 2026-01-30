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
  ForwardRefExoticComponent<IconProps & React.RefAttributes<SVGSVGElement>>
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

export function SocialLinks({ iconSize = 20, include, ...props }: Props) {
  include ??= [
    'discord',
    'twitter',
    'instagram',
    'youtube',
    'tiktok',
    'reddit',
    'github',
    'twitch',
  ];
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
