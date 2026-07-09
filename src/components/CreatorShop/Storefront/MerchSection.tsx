import { Badge, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconShoppingBag } from '@tabler/icons-react';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';

export function MerchSection() {
  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.merch}
        title="Merch"
        right={
          <Badge variant="light" color="yellow" radius="sm">
            Coming soon
          </Badge>
        }
      />
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
