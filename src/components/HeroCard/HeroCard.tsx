import type { CardProps } from '@mantine/core';
import { Card, Group, Image, Stack, Text, createStyles } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React from 'react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';

const useStyles = createStyles((theme) => ({
  card: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    [theme.fn.largerThan('sm')]: {
      maxHeight: 376,
      display: 'flex',
      gap: 40,
    },
  },
  section: {
    [theme.fn.largerThan('sm')]: {
      marginRight: 0,
      marginBottom: -40,
    },
  },
  title: {
    fontSize: 40,
    [theme.fn.smallerThan('sm')]: {
      fontSize: 28,
      marginTop: theme.spacing.xl,
    },
  },
  root: { height: '100%' },
  figure: { height: '100%' },
  imageWrapper: { height: '100%' },
}));

export function HeroCard({
  imageUrl,
  title,
  description,
  externalLink,
  className,
  ...cardProps
}: Props) {
  const { classes, cx } = useStyles();

  return (
    <Card radius="lg" p={40} className={cx(classes.card, className)} {...cardProps}>
      <Card.Section className={classes.section}>
        <Image
          src={imageUrl}
          width="auto"
          alt={''}
          classNames={classes}
          imageProps={{
            style: { objectFit: 'cover', objectPosition: 'top', height: '100%', width: 480 },
          }}
        />
      </Card.Section>
      <Stack spacing={32} justify="center">
        <Text className={classes.title} weight={600} inline>
          {title}
        </Text>
        <CustomMarkdown allowedElements={['a', 'p']}>{description}</CustomMarkdown>
        {externalLink && (
          <Text
            component="a"
            href={externalLink}
            size="xl"
            weight="bold"
            target="_blank"
            rel="nofollow noreferrer"
          >
            <Group spacing={4}>
              Learn more
              <IconExternalLink size={18} color="currentColor" />
            </Group>
          </Text>
        )}
      </Stack>
    </Card>
  );
}

type Props = Omit<CardProps, 'children'> & {
  imageUrl: string;
  title: React.ReactNode;
  description: string;
  externalLink?: string;
};
