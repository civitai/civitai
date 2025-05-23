import { Card, CardProps, Group, Image, Stack, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import React from 'react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import classes from './HeroCard.module.scss';
import clsx from 'clsx';

export function HeroCard({
  imageUrl,
  title,
  description,
  externalLink,
  className,
  ...cardProps
}: Props) {
  return (
    <Card radius="lg" p={40} className={clsx(classes.card, className)} {...cardProps}>
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
      <Stack gap={32} justify="center">
        <Text className={classes.title} fw={600} inline>
          {title}
        </Text>
        <CustomMarkdown allowedElements={['a', 'p']}>{description}</CustomMarkdown>
        {externalLink && (
          <Text
            component="a"
            href={externalLink}
            size="xl"
            fw="bold"
            target="_blank"
            rel="nofollow noreferrer"
          >
            <Group gap={4}>
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
