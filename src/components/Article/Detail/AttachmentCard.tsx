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
      radius={0}
      py="xs"
      component="a"
      href={`/api/download/attachments/${id}`}
      download
    >
      <Group spacing="xs" noWrap>
        <ThemeIcon size="lg" variant="light" color={color} sx={{ backgroundColor: 'transparent' }}>
          {icon}
        </ThemeIcon>
        <Stack spacing={0}>
          <Text size="sm" lineClamp={1}>
            {name}
          </Text>
          <Text color="dimmed" size="xs">
            {formatKBytes(sizeKB)}
          </Text>
        </Stack>
      </Group>
    </Card>
  );
}

type Props = ArticleGetById['attachments'][number];
