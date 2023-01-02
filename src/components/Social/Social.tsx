import { Button, ButtonProps } from '@mantine/core';
import {
  TablerIconProps,
  IconBrandDiscord,
  IconBrandGithub,
  IconBrandGoogle,
  IconBrandReddit,
  IconMail,
} from '@tabler/icons';
import { BuiltInProviderType } from 'next-auth/providers';

type SocialProps = Partial<
  Record<
    BuiltInProviderType,
    {
      label?: React.ReactNode;
      Icon?: React.FunctionComponent<TablerIconProps>;
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

const discordColor = '#5865F2';
const googleColor = '#4285F4';
const redditColor = '#FF5700';
const emailColor = '#666';

export function DiscordButton(props: ButtonProps) {
  return (
    <Button
      sx={(theme) => ({
        backgroundColor: theme.colorScheme === 'dark' ? discordColor : discordColor,
        '&:hover': {
          backgroundColor:
            theme.colorScheme === 'dark'
              ? theme.fn.lighten(discordColor, 0.05)
              : theme.fn.darken(discordColor, 0.05),
        },
      })}
      {...props}
    />
  );
}

export function GitHubButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      sx={(theme) => {
        const backgroundColor = theme.colors.dark?.[theme.colorScheme === 'dark' ? 9 : 6];

        return {
          backgroundColor,
          color: '#fff',
          '&:hover': {
            backgroundColor:
              theme.colorScheme === 'dark'
                ? theme.fn.lighten(backgroundColor, 0.02)
                : theme.fn.lighten(backgroundColor, 0.05),
          },
        };
      }}
    />
  );
}

export function GoogleButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      sx={(theme) => ({
        backgroundColor: theme.colorScheme === 'dark' ? googleColor : googleColor,
        '&:hover': {
          backgroundColor:
            theme.colorScheme === 'dark'
              ? theme.fn.lighten(googleColor, 0.05)
              : theme.fn.darken(googleColor, 0.05),
        },
      })}
    />
  );
}

export function RedditButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      sx={(theme) => ({
        backgroundColor: redditColor,
        '&:hover': {
          backgroundColor:
            theme.colorScheme === 'dark'
              ? theme.fn.lighten(redditColor, 0.1)
              : theme.fn.darken(redditColor, 0.05),
        },
      })}
    />
  );
}

export function EmailButton(props: ButtonProps) {
  return (
    <Button
      {...props}
      sx={(theme) => ({
        backgroundColor: emailColor,
        '&:hover': {
          backgroundColor:
            theme.colorScheme === 'dark'
              ? theme.fn.lighten(emailColor, 0.1)
              : theme.fn.darken(emailColor, 0.05),
        },
      })}
    />
  );
}
