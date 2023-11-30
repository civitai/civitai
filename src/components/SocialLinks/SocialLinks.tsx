import { ActionIcon, ActionIconProps } from '@mantine/core';
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandReddit,
  IconBrandTiktok,
  IconBrandTwitch,
  IconBrandX,
  IconBrandYoutube,
  TablerIconsProps,
} from '@tabler/icons-react';
import { useIsLive } from '~/hooks/useIsLive';

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

const SocialIcons: Record<SocialOption, (props: TablerIconsProps) => JSX.Element> = {
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
          <ActionIcon
            key={option}
            component="a"
            href={`/${option}`}
            target="_blank"
            rel="nofollow noreferrer"
            {...defaultProps}
            {...props}
            {...optionProps}
          >
            <Icon size={iconSize} />
          </ActionIcon>
        );
      })}
    </>
  );
}
