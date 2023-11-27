import { createStyles } from '@mantine/core';

export const useClubFeedStyles = createStyles((theme) => ({
  feedContainer: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
  },
}));
