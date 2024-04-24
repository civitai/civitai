import { Grid, Card, Text, Anchor, Stack, Group } from '@mantine/core';
import { IconMail, IconQuestionMark, IconWand, TablerIconsProps } from '@tabler/icons-react';
import { IconBook, IconBrandDiscord } from '@tabler/icons-react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
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
    description: 'Questions, bugs or errors? Reach out!',
    icon: (props: TablerIconsProps) => <IconMail {...props} />,
    link: { label: 'Ticket portal', href: '/bugs' },
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
        <AssistantChat
          token={token}
          width="100%"
          height="100%"
          sx={{ height: '100%', minHeight: 500 }}
        />
      </Grid.Col>
      <Grid.Col>
        <Text size="md">
          Still unsure? Contact us through our{' '}
          <Anchor href="/support-portal" td="underline">
            Support Portal
          </Anchor>
        </Text>
      </Grid.Col>
    </Grid>
  );
}
