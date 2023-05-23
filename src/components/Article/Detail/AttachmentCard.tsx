import { Card, Group, Stack, Text, ThemeIcon, createStyles } from '@mantine/core';
import { IconBrandPython, IconFileText, IconMarkdown, IconTxt, IconZip } from '@tabler/icons-react';

import { ArticleGetById } from '~/types/router';
import { formatKBytes } from '~/utils/number-helpers';

const fileCosmetics = {
  txt: {
    icon: <IconTxt />,
    color: 'violet',
  },
  pdf: {
    icon: <IconFileText />,
    color: 'red',
  },
  md: {
    icon: <IconMarkdown />,
    color: 'gray',
  },
  zip: {
    icon: <IconZip />,
    color: 'orange',
  },
  py: {
    icon: <IconBrandPython />,
    color: 'blue',
  },
} as const;

const useStyles = createStyles((theme) => ({
  attachment: {
    '&:hover': {
      backgroundColor:
        theme.colorScheme === 'dark'
          ? theme.fn.lighten(theme.colors.dark[4], 0.05)
          : theme.fn.darken(theme.colors.gray[0], 0.05),
    },
  },
}));

export function AttachmentCard({ id, name, sizeKB, url }: Props) {
  const { classes } = useStyles();
  const extension = url.split('.').pop() as keyof typeof fileCosmetics;
  const { icon, color } = fileCosmetics[extension] ?? fileCosmetics.pdf;

  return (
    <Card
      className={classes.attachment}
      component="a"
      href={`/api/download/attachments/${id}`}
      download
    >
      <Stack spacing={8}>
        <Group position="apart">
          <ThemeIcon size="sm" variant="light" color={color}>
            {icon}
          </ThemeIcon>
          <Text color="dimmed" size="sm">
            {formatKBytes(sizeKB)}
          </Text>
        </Group>
        <Text lineClamp={3}>{name}</Text>
      </Stack>
    </Card>
  );
}

type Props = ArticleGetById['attachments'][number];
