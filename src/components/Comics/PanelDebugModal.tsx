import { Badge, Code, Group, Loader, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { trpc } from '~/utils/trpc';

export function PanelDebugModal({
  panelId,
  opened,
  onClose,
}: {
  panelId: number | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.comics.getPanelDebugInfo.useQuery(
    { panelId: panelId ?? 0 },
    { enabled: opened && panelId != null && panelId > 0 }
  );

  const meta = data?.panel.metadata as Record<string, any> | null | undefined;

  return (
    <Modal opened={opened} onClose={onClose} title="Panel Debug Info" size="lg">
      <ScrollArea.Autosize mah="70vh">
        {isLoading ? (
          <Stack align="center" py="xl">
            <Loader />
          </Stack>
        ) : data ? (
          <Stack gap="md">
            {data.panel.errorMessage && (
              <div>
                <Text fw={600} size="sm" mb={4} c="red">
                  Error
                </Text>
                <Code block color="red">
                  {data.panel.errorMessage}
                </Code>
              </div>
            )}
            <div>
              <Group gap="xs" mb={4}>
                <Text fw={600} size="sm">
                  Prompts
                </Text>
                <Badge size="xs" variant="light" color={meta?.enhanceEnabled ? 'teal' : 'gray'}>
                  Enhance {meta?.enhanceEnabled ? 'ON' : 'OFF'}
                </Badge>
              </Group>
              <Stack gap="xs">
                <div>
                  <Text size="xs" c="dimmed" mb={2}>
                    Original
                  </Text>
                  <Code block>{data.panel.prompt}</Code>
                </div>
                {data.panel.enhancedPrompt && (
                  <div>
                    <Text size="xs" c="dimmed" mb={2}>
                      Enhanced
                    </Text>
                    <Code block>{data.panel.enhancedPrompt}</Code>
                  </div>
                )}
              </Stack>
            </div>
            {meta?.previousPanelId && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Previous Panel Context
                </Text>
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      ID:
                    </Text>
                    <Code>{meta.previousPanelId}</Code>
                  </Group>
                  {meta.previousPanelPrompt && (
                    <div>
                      <Text size="xs" c="dimmed" mb={2}>
                        Prompt used
                      </Text>
                      <Code block>{meta.previousPanelPrompt}</Code>
                    </div>
                  )}
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      Had image:
                    </Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={meta.previousPanelImageUrl ? 'green' : 'gray'}
                    >
                      {meta.previousPanelImageUrl ? 'Yes' : 'No'}
                    </Badge>
                  </Group>
                </Stack>
              </div>
            )}
            {meta?.referenceImages?.length > 0 && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Reference Images ({meta!.referenceImages.length})
                </Text>
                <Stack gap="xs">
                  {(meta!.referenceImages as { url: string; width: number; height: number }[]).map(
                    (img, i) => (
                      <Group key={i} gap="xs">
                        <Badge size="xs" variant="light">
                          {img.width}x{img.height}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }} lineClamp={1}>
                          {img.url}
                        </Text>
                      </Group>
                    )
                  )}
                </Stack>
              </div>
            )}
            <div>
              <Text fw={600} size="sm" mb={4}>
                References ({data.references?.length ?? 0})
              </Text>
              {data.references && data.references.length > 0 ? (
                <Stack gap="xs">
                  {data.references.map((ref: any) => (
                    <Group key={ref.id} gap="xs">
                      <Text size="xs">{ref.name}</Text>
                      <Badge size="xs" variant="light">
                        {ref.images?.length ?? 0} images
                      </Badge>
                    </Group>
                  ))}
                  {(meta?.allReferenceNames ?? meta?.allCharacterNames) && (
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">
                        All known:
                      </Text>
                      <Text size="xs">
                        {((meta.allReferenceNames ?? meta.allCharacterNames) as string[]).join(
                          ', '
                        )}
                      </Text>
                    </Group>
                  )}
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">
                  No reference info
                </Text>
              )}
            </div>
            <div>
              <Text fw={600} size="sm" mb={4}>
                Generation Parameters
              </Text>
              <Code block>
                {JSON.stringify(meta?.generationParams ?? data.generation, null, 2)}
              </Code>
            </div>
            <div>
              <Text fw={600} size="sm" mb={4}>
                Panel Record
              </Text>
              <Code block>
                {JSON.stringify(
                  {
                    id: data.panel.id,
                    status: data.panel.status,
                    workflowId: data.panel.workflowId,
                    createdAt: data.panel.createdAt,
                    updatedAt: data.panel.updatedAt,
                  },
                  null,
                  2
                )}
              </Code>
            </div>
            {data.workflow && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Orchestrator Workflow
                </Text>
                <Code block>{JSON.stringify(data.workflow, null, 2)}</Code>
              </div>
            )}
          </Stack>
        ) : (
          <Text c="dimmed">No debug info available</Text>
        )}
      </ScrollArea.Autosize>
    </Modal>
  );
}
