import { Grid, Card, Loader, Center, Text, Anchor, Stack, Group } from '@mantine/core';
import { IconBug, IconQuestionMark, IconWand, TablerIconsProps } from '@tabler/icons-react';
import { IconBook, IconBrandDiscord } from '@tabler/icons-react';
import { env } from '~/env/client.mjs';
import { trpc } from '~/utils/trpc';

const SUPPORT_OPTIONS = [
  {
    title: 'Education Hub',
    description: 'Explore our Civitai and Generative AI tutorials & guides!',
    icon: (props: TablerIconsProps) => <IconBook {...props} />,
    link: { label: 'Visit the Education Hub', href: '/education' },
  },
  {
    title: 'Discord Community',
    description: 'Get assistance from our knowledgeable Community!',
    icon: (props: TablerIconsProps) => <IconBrandDiscord {...props} />,
    link: { label: 'Join our Discord Community', href: '/discord' },
  },
  {
    title: 'Frenquently Asked Questions',
    description: 'Check out the FAQ and Known Issues list',
    icon: (props: TablerIconsProps) => <IconQuestionMark {...props} />,
    link: {
      label: 'Civitai FAQ and Known Issues',
      href: 'https://education.civitai.com/civitai-faq',
    },
  },
  {
    title: 'Report a Bug',
    description: 'Receiving an error message? Let us know!',
    icon: (props: TablerIconsProps) => <IconBug {...props} />,
    link: { label: 'Report a bug', href: '/bugs' },
  },
  {
    title: 'Feature Requests',
    description: 'Civitai missing an essential feature? We’d love to hear!',
    icon: (props: TablerIconsProps) => <IconWand {...props} />,
    link: { label: 'Suggest a feature', href: '/feedback' },
  },
];

export function SupportContent() {
  const { data: { token = null } = {} } = trpc.user.getToken.useQuery();

  return (
    <Grid gutter="xl">
      <Grid.Col xs={12} md={6}>
        <Stack spacing="lg">
          {SUPPORT_OPTIONS.map((option) => (
            <Card key={option.title} shadow="xs" radius={12} p="md" pr="lg">
              <Group align="flex-start" noWrap>
                <div style={{ minWidth: 32 }}>{option.icon({ size: 32 })}</div>
                <Stack spacing="sm">
                  <Text size="sm" weight={500}>
                    {option.description}
                  </Text>
                  <Anchor
                    size="sm"
                    weight={700}
                    href={option.link.href}
                    target="_blank"
                    rel="nofollow noreferrer"
                  >
                    {option.link.label}
                  </Anchor>
                </Stack>
              </Group>
            </Card>
          ))}
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} md={6}>
        <Card shadow="md" withBorder h="100%" radius={12} p={0}>
          {!token ? (
            <Center h="100%">
              <Loader />
            </Center>
          ) : (
            env.NEXT_PUBLIC_GPTT_UUID && (
              <iframe
                src={`https://app.gpt-trainer.com/gpt-trainer-widget/${env.NEXT_PUBLIC_GPTT_UUID}?token=${token}`}
                width="100%"
                height="100%"
              />
            )
          )}
        </Card>
      </Grid.Col>
      <Grid.Col>
        <Text size="md">
          Still unsure? Drop us an email at{' '}
          <Anchor href="mailto:support@civitai.com" td="underline">
            support@civitai.com
          </Anchor>
        </Text>
      </Grid.Col>
    </Grid>
  );
}
