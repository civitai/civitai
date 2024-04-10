import { Stack, Title, Text } from '@mantine/core';
import { BrowsingCategories } from '~/components/BrowsingMode/BrowsingCategories';

export function ContentControls() {
  return (
    <Stack spacing="xs">
      <Title order={3}>Content Controls</Title>
      <Text size="sm">
        Choose to see less content from certain topics while you browse Civitai. Selecting a topic
        will reduce, not eliminate, content about the topic.
      </Text>
      <BrowsingCategories />
    </Stack>
  );
}
