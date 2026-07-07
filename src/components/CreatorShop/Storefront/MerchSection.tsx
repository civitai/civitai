import { Badge, Group, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconShoppingBag } from '@tabler/icons-react';
import { SectionAccent } from '~/components/CreatorShop/Storefront/SectionAccent';

export function MerchSection() {
  return (
    <Stack gap="md">
      <Group gap={10} align="center">
        <SectionAccent />
        <Title order={4}>Merch</Title>
        <Badge variant="light" color="yellow" radius="sm">
          Coming soon
        </Badge>
      </Group>
      <Paper withBorder radius="md" p={40}>
        <Stack align="center" gap={8}>
          <ThemeIcon size={48} radius="xl" variant="light" color="gray">
            <IconShoppingBag size={24} />
          </ThemeIcon>
          <Text fw={600}>Merch is coming soon</Text>
          <Text size="sm" c="dimmed" ta="center">
            Print-on-demand apparel &amp; goods will be available here shortly.
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}
