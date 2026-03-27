import { Badge, Button, Checkbox, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconDownload, IconUser } from '@tabler/icons-react';
import { useState } from 'react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { refTypeBadge } from '~/components/Comics/comic-project-constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ImportReferencesModal({
  projectId,
  opened,
  onClose,
}: {
  projectId: number;
  opened: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const utils = trpc.useUtils();

  const { data: importable, isLoading } = trpc.comics.getImportableReferences.useQuery(
    { projectId },
    { enabled: opened }
  );

  const addMutation = trpc.comics.addReferenceToProject.useMutation({
    onSuccess: () => {
      utils.comics.getProject.invalidate({ id: projectId });
      utils.comics.getImportableReferences.invalidate({ projectId });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Import failed', error: new Error(err.message) });
    },
  });

  const handleToggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleImport = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;

    // Import all selected references in parallel — use allSettled so partial failures
    // don't prevent successful imports from completing
    const results = await Promise.allSettled(
      ids.map((referenceId) => addMutation.mutateAsync({ projectId, referenceId }))
    );

    // Keep failed items selected for retry
    const failedIds = ids.filter((_, i) => results[i].status === 'rejected');
    if (failedIds.length > 0) {
      setSelected(new Set(failedIds));
    } else {
      setSelected(new Set());
      onClose();
    }
  };

  const references = importable ?? [];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Import References"
      size="md"
      centered
    >
      <Stack gap="md">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader size="sm" />
          </div>
        ) : references.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            All your references are already in this project.
          </Text>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              Select references from your other projects to add to this one.
            </Text>

            <Stack gap={8}>
              {references.map((ref) => {
                const thumb = ref.images?.[0]?.image;
                const badge = refTypeBadge[ref.type] ?? refTypeBadge.Character;
                return (
                  <div
                    key={ref.id}
                    className="flex items-center gap-3 rounded-lg p-2 cursor-pointer hover:bg-dark-5"
                    onClick={() => handleToggle(ref.id)}
                    style={{ userSelect: 'none' }}
                  >
                    <Checkbox
                      checked={selected.has(ref.id)}
                      onChange={() => handleToggle(ref.id)}
                      size="sm"
                    />

                    <div
                      className="flex-shrink-0 overflow-hidden rounded"
                      style={{ width: 40, height: 40, background: 'var(--mantine-color-dark-6)' }}
                    >
                      {thumb?.url ? (
                        <EdgeMedia2
                          src={thumb.url}
                          type="image"
                          name={ref.name}
                          alt={ref.name}
                          width={80}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                            objectPosition: 'top center',
                          }}
                        />
                      ) : (
                        <div className="flex items-center justify-center" style={{ width: 40, height: 40 }}>
                          <IconUser size={18} style={{ color: '#909296' }} />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <Text size="sm" fw={500} truncate>
                          {ref.name}
                        </Text>
                        <Badge size="xs" variant="light" color={badge.color}>
                          {badge.label}
                        </Badge>
                      </div>
                      <Text size="xs" c="dimmed">
                        {ref._count.images} image{ref._count.images !== 1 ? 's' : ''}
                      </Text>
                    </div>
                  </div>
                );
              })}
            </Stack>

            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button
                leftSection={<IconDownload size={16} />}
                onClick={handleImport}
                loading={addMutation.isPending}
                disabled={selected.size === 0}
              >
                Import {selected.size > 0 ? `(${selected.size})` : ''}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
