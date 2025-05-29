import type { ButtonProps } from '@mantine/core';
import { Button } from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import {
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandReddit,
  IconMail,
} from '@tabler/icons-react';
import type { BuiltInProviderType } from 'next-auth/providers';
import classes from './Social.module.css';
import clsx from 'clsx';

type SocialProps = Partial<
  Record<
    BuiltInProviderType,
    {
      label?: React.ReactNode;
      Icon?: React.FunctionComponent<IconProps>;
      Button?: React.FunctionComponent<ButtonProps>;
    }
  >
>;

export const socialItems: SocialProps = {
  discord: {
    label: 'Discord',
    Icon: IconBrandDiscord,
    Button: DiscordButton,
  },
  github: {
    label: 'GitHub',
    Icon: IconBrandGithub,
    Button: GitHubButton,
  },
  google: {
    label: 'Google',
    Icon: IconBrandGoogle,
    Button: GoogleButton,
  },
  reddit: {
    label: 'Reddit',
    Icon: IconBrandReddit,
    Button: RedditButton,
  },
  email: {
    label: 'Email',
    Icon: IconMail,
    Button: EmailButton,
  },
};

export function DiscordButton(props: ButtonProps) {
  return <Button {...props} className={clsx(classes.discordButton, props.className)} />;
}

export function GitHubButton(props: ButtonProps) {
  return <Button {...props} className={clsx(classes.githubButton, props.className)} />;
}

export function GoogleButton(props: ButtonProps) {
  return <Button {...props} className={clsx(classes.googleButton, props.className)} />;
}

export function RedditButton(props: ButtonProps) {
  return <Button {...props} className={clsx(classes.redditButton, props.className)} />;
}

export function EmailButton(props: ButtonProps) {
  return <Button {...props} className={clsx(classes.emailButton, props.className)} />;
}
