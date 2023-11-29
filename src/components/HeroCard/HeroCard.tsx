import { Anchor, Card, CardProps, Group, Stack, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Image from 'next/image';

export function HeroCard({ imageUrl, title, description, externalLink, ...cardProps }: Props) {
  return (
    <Card radius="lg" p={40} sx={{ display: 'flex', gap: 40 }} {...cardProps}>
      <Card.Section sx={{ marginRight: 0, marginBottom: -40 }}>
        <img
          src={imageUrl}
          alt={title}
          width={480}
          height={376}
          style={{
            objectFit: 'cover',
            objectPosition: 'top',
          }}
        />
      </Card.Section>
      <Stack spacing={32}>
        <Text size={40} weight={600}>
          {title}
        </Text>
        <Text size={20}>{description}</Text>
        <Anchor
          size="xl"
          weight="bold"
          target="_blank"
          rel="nofollow noreferrer"
          sx={{ color: 'white' }}
        >
          <Group spacing={8}>
            Learn more about {title}
            <IconExternalLink size={24} color="currentColor" />
          </Group>
        </Anchor>
      </Stack>
    </Card>
  );
}

type Props = Omit<CardProps, 'children'> & {
  imageUrl: string;
  title: string;
  description: string;
  externalLink?: string;
};
