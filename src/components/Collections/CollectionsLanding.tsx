import {
  Alert,
  AspectRatio,
  Badge,
  Card,
  Center,
  Group,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

export function CollectionsLanding() {
  return (
    <Stack>
      <Center>
        <Card withBorder maw={500} shadow="sm">
          <Stack spacing={4}>
            <Badge color="yellow">Beta</Badge>
            <Text size="sm">
              {`Collections are a way to organize things you're interested in. This is an early preview, so stay tuned for more updates!`}
            </Text>
          </Stack>
        </Card>
      </Center>
      <Stack pos="relative">
        <Alert color="yellow">
          <Group>
            <IconAlertTriangle size={20} />
            The stuff below is still in the works, but you can still checkout any of your
            collections by selecting them from the My Collections menu.
          </Group>
        </Alert>
        <SectionPlaceholder
          title="The latest from your subscriptions"
          quantity={4}
          ratio={512 / 768}
        />
        <SectionPlaceholder quantity={3} ratio={5 / 3} title="Your recent collections" />
        <SectionPlaceholder title="Based on your recent activity" />
      </Stack>
    </Stack>
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
