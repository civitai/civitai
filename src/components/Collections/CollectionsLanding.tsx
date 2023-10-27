import {
  Alert,
  AspectRatio,
  Badge,
  Card,
  Center,
  Box,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
  Overlay,
  useMantineTheme,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

export function CollectionsLanding() {
  const theme = useMantineTheme();

  return (
    <Box maw={1000} mx="auto">
      <Stack>
        <Stack pos="relative">
          <Overlay
            blur={3}
            zIndex={10}
            color={theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
            opacity={0.8}
            m={-8}
            radius="md"
          />
          <Stack
            sx={(theme) => ({
              zIndex: 11,
              [theme.fn.largerThan('sm')]: {
                transform: 'translateX(-50%)',
                left: '50%',
              },
            })}
            pos="absolute"
            top={0}
            maw={400}
          >
            <Alert>
              <Stack spacing="xs">
                <Group>
                  <ThemeIcon color="blue" size={32}>
                    <IconAlertTriangle size={24} strokeWidth={2.5} />
                  </ThemeIcon>
                  <Text size="lg" weight={500}>
                    Early Preview
                  </Text>
                </Group>
                <Text size="md">
                  {`We're still hard at work on collections, so you may notice some things are missing or run into bugs. As always, we'd love to hear your feedback!`}
                </Text>
              </Stack>
            </Alert>

            <Card withBorder shadow="sm">
              <Card.Section withBorder inheritPadding mb="sm">
                <Text size="lg" weight={500} py="xs">
                  What are Collections?
                </Text>
              </Card.Section>
              <Stack spacing={4}>
                <Text>
                  {`This lets you add any resource to a currated list so you can catagorize them for yourself or share them for others to follow as you update. Want to put together a collection of resources just for game assets? Now you easily can and share that collection so others can find those resources easily.`}
                </Text>
              </Stack>
            </Card>
            <Card withBorder shadow="sm">
              <Card.Section withBorder inheritPadding mb="sm">
                <Text size="lg" weight={500} py="xs">
                  Whats available now?
                </Text>
              </Card.Section>
              <Stack spacing={4}>
                <Text>
                  {`Right now you can Add any model to a collection from the context menu on Model cards and Model pages. You can also view your collections by clicking any of them on the left. Start building your collections now!`}
                </Text>
              </Stack>
            </Card>
          </Stack>
          <SectionPlaceholder
            title="The latest from your subscriptions"
            quantity={4}
            ratio={512 / 768}
          />
          <SectionPlaceholder quantity={3} ratio={5 / 3} title="Your recent collections" />
          <SectionPlaceholder title="Based on your recent activity" />
        </Stack>
      </Stack>
    </Box>
  );
}

function SectionPlaceholder({
  title,
  ratio = 1,
  quantity = 5,
}: {
  title: string;
  ratio?: number;
  quantity?: number;
  perRow?: number;
}) {
  return (
    <Stack spacing={12}>
      <Title order={3} lh={1}>
        {title}
      </Title>
      <Group spacing={12}>
        {Array.from({ length: quantity }).map((_, i) => (
          <AspectRatio ratio={ratio} w={`calc(${100 / quantity}% - 12px)`} key={i}>
            <Skeleton width="100%" height="100%" />
          </AspectRatio>
        ))}
      </Group>
    </Stack>
  );
}
