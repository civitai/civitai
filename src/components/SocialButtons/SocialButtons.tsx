import { Button, ButtonProps } from '@mantine/core';

import { IconBrandDiscord, IconBrandGithub } from '@tabler/icons';

export function DiscordButton(props: ButtonProps) {
  return (
    <Button
      leftIcon={<IconBrandDiscord size={16} />}
      sx={(theme) => ({
        backgroundColor: theme.colorScheme === 'dark' ? '#5865F2' : '#5865F2',
        '&:hover': {
          backgroundColor:
            theme.colorScheme === 'dark' ? theme.fn.lighten('#5865F2', 0.05) : theme.fn.darken('#5865F2', 0.05),
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
      leftIcon={<IconBrandGithub size={16} />}
      sx={(theme) => ({
        backgroundColor: theme.colors.dark[theme.colorScheme === 'dark' ? 9 : 6],
        color: '#fff',
        '&:hover': {
          backgroundColor: theme.colors.dark[theme.colorScheme === 'dark' ? 9 : 6],
        },
      })}
    />
  );
}
