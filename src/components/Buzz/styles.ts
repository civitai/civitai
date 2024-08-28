import { createStyles } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const useBuzzButtonStyles = createStyles((theme) => ({
  chipGroup: {
    gap: theme.spacing.md,

    '& > *': {
      width: '100%',
    },

    [containerQuery.smallerThan('sm')]: {
      gap: theme.spacing.md,
    },
  },

  // Chip styling
  chipLabel: {
    padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,
    height: 'auto',
    width: '100%',
    borderRadius: theme.radius.md,

    '&[data-variant="filled"]': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
    },

    '&[data-checked]': {
      border: `2px solid ${theme.colors.accent[5]}`,
      color: theme.colors.accent[5],
      padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,

      '&[data-variant="filled"], &[data-variant="filled"]:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
      },
    },
  },

  chipCheckmark: {
    display: 'none',
  },

  chipDisabled: {
    opacity: 0.3,
  },

  // Accordion styling
  accordionItem: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],

    '&:first-of-type, &:first-of-type>[data-accordion-control]': {
      borderTopLeftRadius: theme.radius.md,
      borderTopRightRadius: theme.radius.md,
    },

    '&:last-of-type, &:last-of-type>[data-accordion-control]': {
      borderBottomLeftRadius: theme.radius.md,
      borderBottomRightRadius: theme.radius.md,
    },

    '&[data-active="true"]': {
      border: `1px solid ${theme.colors.accent[5]}`,
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.white,
    },
  },

  // Icon styling
  buzzIcon: {
    filter: `drop-shadow(0 0 2px ${theme.colors.accent[5]})`,

    '&:not(:first-of-type)': {
      marginLeft: -4,
    },
  },
}));
