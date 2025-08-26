import React from 'react';
import {
  Modal,
  Button,
  Stack,
  Group,
  Text,
  Card,
  Badge,
  Switch,
  Divider,
  Alert,
} from '@mantine/core';
import {
  IconPlus,
  IconRefresh,
  IconInfoCircle,
  IconRectangle,
  IconSquare,
  IconPlayerPlay,
} from '@tabler/icons-react';
import useAdLayerStore from './hooks/useAdLayerStore';
import { MAX_AD_BLOCKS, MIN_AD_BLOCKS } from './types';

export const AdManagementPanel: React.FC = () => {
  const {
    blocks,
    isEditMode,
    showGrid,
    isPanelOpen,
    togglePanel,
    toggleEditMode,
    toggleGrid,
    addBlock,
    resetLayout,
    toggleMinimize,
    removeBlock,
  } = useAdLayerStore();

  const canAddMore = blocks.length < MAX_AD_BLOCKS;
  const canRemove = blocks.length > MIN_AD_BLOCKS;

  return (
    <Modal
      opened={isPanelOpen}
      onClose={togglePanel}
      title="Ad Layout Manager"
      size="md"
      centered
    >
      <Stack gap="md">
        {/* Info Alert */}
        <Alert icon={<IconInfoCircle />} color="blue" variant="light">
          <Text size="sm">
            Drag ads to reposition them. Free users must have at least {MIN_AD_BLOCKS} ads active.
          </Text>
        </Alert>

        {/* Quick Actions */}
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={600}>Quick Actions</Text>
            <Group gap="xs">
              <Switch
                label="Edit Mode"
                checked={isEditMode}
                onChange={toggleEditMode}
                description="Enable to drag and reposition ads"
              />
              {isEditMode && (
                <Switch
                  label="Show Grid"
                  checked={showGrid}
                  onChange={toggleGrid}
                  description="10px snap grid"
                />
              )}
            </Group>
            <Button
              leftIcon={<IconRefresh />}
              variant="outline"
              onClick={() => {
                if (confirm('Reset to default layout?')) {
                  resetLayout();
                }
              }}
            >
              Reset Layout
            </Button>
          </Stack>
        </Card>

        <Divider />

        {/* Active Ad Blocks */}
        <Stack gap="sm">
          <Group justify="space-between">
            <Text fw={600}>
              Active Ad Blocks ({blocks.length}/{MAX_AD_BLOCKS})
            </Text>
          </Group>

          {blocks.map((block) => (
            <Card key={block.id} withBorder padding="xs">
              <Group justify="space-between">
                <Group gap="xs">
                  <Badge color={block.minimized ? 'gray' : 'blue'}>
                    {block.type.toUpperCase()}
                  </Badge>
                  <Text size="sm">{block.content.title}</Text>
                </Group>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => toggleMinimize(block.id)}
                  >
                    {block.minimized ? 'Expand' : 'Minimize'}
                  </Button>
                  {canRemove && (
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        if (confirm('Remove this ad block?')) {
                          removeBlock(block.id);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </Group>
              </Group>
            </Card>
          ))}
        </Stack>

        <Divider />

        {/* Add New Ad Blocks */}
        {canAddMore && (
          <Stack gap="sm">
            <Text fw={600}>Add Ad Block</Text>
            <Group gap="xs">
              <Button
                leftIcon={<IconRectangle />}
                variant="light"
                onClick={() => addBlock('banner')}
                disabled={!canAddMore}
              >
                Banner (728x90)
              </Button>
              <Button
                leftIcon={<IconSquare />}
                variant="light"
                onClick={() => addBlock('square')}
                disabled={!canAddMore}
              >
                Square (300x250)
              </Button>
              <Button
                leftIcon={<IconPlayerPlay />}
                variant="light"
                onClick={() => addBlock('video')}
                disabled={!canAddMore}
              >
                Video (400x225)
              </Button>
            </Group>
          </Stack>
        )}

        {!canAddMore && (
          <Alert color="yellow" variant="light">
            <Text size="sm">Maximum of {MAX_AD_BLOCKS} ad blocks reached</Text>
          </Alert>
        )}
      </Stack>
    </Modal>
  );
};