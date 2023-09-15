import { ActionIcon, ActionIconProps } from '@mantine/core';
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandInstagram,
  IconBrandReddit,
  IconBrandTiktok,
  IconBrandTwitter,
  IconBrandYoutube,
  TablerIconsProps,
} from '@tabler/icons-react';

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
  | 'reddit';
type Props = ActionIconProps & {
  iconSize?: number;
  include?: SocialOption[];
};

const SocialIcons: Record<SocialOption, (props: TablerIconsProps) => JSX.Element> = {
  github: IconBrandGithub,
  discord: IconBrandDiscord,
  twitter: IconBrandTwitter,
  instagram: IconBrandInstagram,
  tiktok: IconBrandTiktok,
  reddit: IconBrandReddit,
  youtube: IconBrandYoutube,
};

export function SocialLinks({ iconSize = 20, include, ...props }: Props) {
  include ??= ['discord', 'twitter', 'instagram', 'youtube', 'tiktok', 'reddit', 'github'];

  return (
    <>
      {include.map((option) => {
        const Icon = SocialIcons[option];
        return (
          <ActionIcon
            key={option}
            component="a"
            href={`/${option}`}
            target="_blank"
            rel="noopener noreferrer"
            {...defaultProps}
            {...props}
          >
            <Icon size={iconSize} />
          </ActionIcon>
        );
      })}
    </>
  );
}
