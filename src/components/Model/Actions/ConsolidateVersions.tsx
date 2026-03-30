import {
  Badge,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  Radio,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ModelFileType } from '~/server/common/constants';
import { constants } from '~/server/common/constants';
import { showErrorNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type FileTypeMapping = { fileId: number; type: ModelFileType };

type Step = 'select-target' | 'map-files' | 'confirm';

export default function ConsolidateVersions({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const [step, setStep] = useState<Step>('select-target');
  const [targetVersionId, setTargetVersionId] = useState<number | null>(null);
  const [fileTypeMappings, setFileTypeMappings] = useState<FileTypeMapping[]>([]);
  const [appendDescriptions, setAppendDescriptions] = useState(false);

  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery(
    { id: modelId },
    { enabled: !!modelId }
  );

  const consolidateMutation = trpc.modelVersion.consolidateVersions.useMutation({
    onSuccess: () => {
      window.location.reload();
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to consolidate versions',
        error: new Error(error.message),
      });
    },
  });

  const handleClose = () => {
    if (consolidateMutation.isLoading) return;
    dialog.onClose();
  };

  const handleConsolidate = () => {
    if (!targetVersionId || consolidateMutation.isLoading) return;

    const sourceVersionIds = (model?.modelVersions ?? [])
      .map((v) => v.id)
      .filter((id) => id !== targetVersionId);

    consolidateMutation.mutate({
      modelId,
      targetVersionId,
      sourceVersionIds,
      fileTypeMappings: fileTypeMappings.length > 0 ? fileTypeMappings : undefined,
      appendDescriptions,
    });
  };

  const updateFileType = (fileId: number, type: ModelFileType) => {
    setFileTypeMappings((prev) => {
      const existing = prev.find((m) => m.fileId === fileId);
      if (existing) {
        return prev.map((m) => (m.fileId === fileId ? { ...m, type } : m));
      }
      return [...prev, { fileId, type }];
    });
  };

  const versions = model?.modelVersions ?? [];
  const sourceVersions = versions.filter((v) => v.id !== targetVersionId);
  const targetVersion = versions.find((v) => v.id === targetVersionId);

  const fileTypeOptions = constants.modelFileTypes.map((t) => ({ value: t, label: t }));

  const renderContent = () => {
    if (loadingModel) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8">
          <Loader size={48} />
          <Text size="sm" c="dimmed">
            Loading model data...
          </Text>
        </div>
      );
    }

    if (consolidateMutation.isLoading) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8">
          <Loader size={64} />
          <div className="text-center">
            <Text size="md" fw={600}>
              Consolidating versions...
            </Text>
            <Text size="sm" c="dimmed">
              This may take a few minutes. Please do not close this window.
            </Text>
          </div>
        </div>
      );
    }

    if (versions.length < 2) {
      return (
        <Stack>
          <Text>This model only has one version. There is nothing to consolidate.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Close
            </Button>
          </Group>
        </Stack>
      );
    }

    switch (step) {
      case 'select-target':
        return (
          <Stack>
            <Text>
              Select the version that will be kept as the primary version. All files from other
              versions will be moved into it, and their stats will be combined.
            </Text>
            <Radio.Group
              value={targetVersionId?.toString() ?? ''}
              onChange={(val) => setTargetVersionId(Number(val))}
            >
              <Stack gap="xs">
                {versions.map((version) => (
                  <Radio
                    key={version.id}
                    value={version.id.toString()}
                    label={
                      <Group gap="xs">
                        <Text size="sm" fw={500}>
                          {version.name}
                        </Text>
                        <Badge size="xs" variant="light">
                          {version.files?.length ?? 0} files
                        </Badge>
                        {version.status !== 'Published' && (
                          <Badge size="xs" color="yellow" variant="light">
                            {version.status}
                          </Badge>
                        )}
                      </Group>
                    }
                  />
                ))}
              </Stack>
            </Radio.Group>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={handleClose}>
                Cancel
              </Button>
              <Button disabled={!targetVersionId} onClick={() => setStep('map-files')}>
                Next
              </Button>
            </Group>
          </Stack>
        );

      case 'map-files':
        return (
          <Stack>
            <Text>
              Review the file types for each file being moved. You can change the type if needed.
            </Text>

            {targetVersion && targetVersion.files && targetVersion.files.length > 0 && (
              <>
                <Text size="sm" fw={600}>
                  Target version: {targetVersion.name} (keeping as-is)
                </Text>
                <Table fz="xs" striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>File</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Size</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {targetVersion.files.map((file) => (
                      <Table.Tr key={file.id}>
                        <Table.Td>
                          <Text size="xs" lineClamp={1}>
                            {file.name}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="xs" variant="light">
                            {file.type}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{formatKBytes(file.sizeKB)}</Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                <Divider />
              </>
            )}

            {sourceVersions.map((version) => {
              const files = version.files ?? [];
              if (files.length === 0) return null;

              return (
                <div key={version.id}>
                  <Text size="sm" fw={600} mb="xs">
                    From: {version.name}
                  </Text>
                  <Table fz="xs" striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>File</Table.Th>
                        <Table.Th>Current Type</Table.Th>
                        <Table.Th>New Type</Table.Th>
                        <Table.Th>Size</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {files.map((file) => {
                        const mapping = fileTypeMappings.find((m) => m.fileId === file.id);
                        return (
                          <Table.Tr key={file.id}>
                            <Table.Td>
                              <Text size="xs" lineClamp={1}>
                                {file.name}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Badge size="xs" variant="light">
                                {file.type}
                              </Badge>
                            </Table.Td>
                            <Table.Td>
                              <Select
                                size="xs"
                                data={fileTypeOptions}
                                value={mapping?.type ?? file.type}
                                onChange={(val) => {
                                  if (val) updateFileType(file.id, val as ModelFileType);
                                }}
                                comboboxProps={{ withinPortal: true }}
                              />
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs">{formatKBytes(file.sizeKB)}</Text>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </div>
              );
            })}

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setStep('select-target')}>
                Back
              </Button>
              <Button onClick={() => setStep('confirm')}>Next</Button>
            </Group>
          </Stack>
        );

      case 'confirm': {
        const totalSourceFiles = sourceVersions.reduce((sum, v) => sum + (v.files?.length ?? 0), 0);
        const remappedCount = fileTypeMappings.filter((m) => {
          const sourceFile = sourceVersions
            .flatMap((v) => v.files ?? [])
            .find((f) => f.id === m.fileId);
          return sourceFile && sourceFile.type !== m.type;
        }).length;

        return (
          <Stack>
            <Text fw={600}>Summary</Text>
            <Table fz="sm">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td fw={500}>Target version</Table.Td>
                  <Table.Td>{targetVersion?.name}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td fw={500}>Versions to merge</Table.Td>
                  <Table.Td>{sourceVersions.length}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td fw={500}>Files to move</Table.Td>
                  <Table.Td>{totalSourceFiles}</Table.Td>
                </Table.Tr>
                {remappedCount > 0 && (
                  <Table.Tr>
                    <Table.Td fw={500}>File types changed</Table.Td>
                    <Table.Td>{remappedCount}</Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>

            <Checkbox
              label="Append source version descriptions to target version"
              checked={appendDescriptions}
              onChange={(e) => setAppendDescriptions(e.currentTarget.checked)}
            />

            <AlertWithIcon
              icon={<IconAlertCircle />}
              title="This Action is Irreversible"
              color="red"
              iconColor="red"
            >
              The source versions will be permanently deleted. All stats (downloads, likes, etc.)
              will be combined into the target version. This cannot be undone.
            </AlertWithIcon>

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setStep('map-files')}>
                Back
              </Button>
              <Button color="red" onClick={handleConsolidate}>
                Consolidate Versions
              </Button>
            </Group>
          </Stack>
        );
      }
    }
  };

  return (
    <Modal
      {...dialog}
      title="Consolidate Versions"
      onClose={handleClose}
      closeOnClickOutside={!consolidateMutation.isLoading}
      closeOnEscape={!consolidateMutation.isLoading}
      withCloseButton={!consolidateMutation.isLoading}
      closeButtonProps={{ 'aria-label': 'Close consolidate versions modal' }}
      size="lg"
      withinPortal
    >
      {renderContent()}
    </Modal>
  );
}
