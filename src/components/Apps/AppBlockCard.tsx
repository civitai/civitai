import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconBolt, IconPlugConnected, IconSettings } from '@tabler/icons-react';
import { useState } from 'react';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * Marketplace card for an approved app block. Renders the block name,
 * a short description (from manifest.description), the slot it targets,
 * publisher/app attribution, install count, and an install/manage CTA.
 *
 * The install CTA opens the per-app settings panel; we delegate the open
 * action to the parent via `onOpen` so the page owns the modal lifecycle.
 */
export interface AppBlockCardProps {
  block: AvailableBlock;
  alreadySubscribed: boolean;
  onOpen: (block: AvailableBlock) => void;
}

function slotLabel(slotId?: string): string {
  switch (slotId) {
    case 'model.sidebar_top':
      return 'Model sidebar';
    case 'model.below_images':
      return 'Below images';
    case 'model.actions_extra':
      return 'Model actions';
    default:
      return slotId ?? 'Unknown slot';
  }
}

export function AppBlockCard({ block, alreadySubscribed, onOpen }: AppBlockCardProps) {
  const manifest = block.manifest as {
    name?: string;
    description?: string;
    targets?: Array<{ slotId?: string }>;
  };
  const [busy] = useState(false);
  const slot = manifest.targets?.[0]?.slotId;
  return (
    <Card shadow="sm" padding="md" radius="md" withBorder className="h-full">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Stack gap={2}>
            <Title order={4} className="line-clamp-2">
              {manifest.name ?? block.blockId}
            </Title>
            <Text size="xs" c="dimmed">
              by {block.appName ?? block.appId}
            </Text>
          </Stack>
          <Badge variant="light" color="blue" size="sm">
            {slotLabel(slot)}
          </Badge>
        </Group>
        {manifest.description && (
          <Text size="sm" c="dimmed" className="line-clamp-3">
            {manifest.description}
          </Text>
        )}
        <Group justify="space-between" mt="auto" pt="xs">
          <Group gap={4}>
            <IconBolt size={14} />
            <Text size="xs" c="dimmed">
              {block.installCount.toLocaleString()} installs
            </Text>
          </Group>
          <Button
            size="xs"
            variant={alreadySubscribed ? 'default' : 'filled'}
            leftSection={
              alreadySubscribed ? <IconSettings size={14} /> : <IconPlugConnected size={14} />
            }
            loading={busy}
            onClick={() => onOpen(block)}
          >
            {alreadySubscribed ? 'Manage' : 'Install'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
