import {
  Button,
  CloseButton,
  Group,
  Loader,
  Modal,
  Radio,
  Select,
  Stack,
  Stepper,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconLink, IconPuzzle } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { QuickSearchDropdownProps } from '~/components/Search/QuickSearchDropdown';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { modelFileComponentTypes } from '~/server/common/constants';
import type { ModelVersionById } from '~/server/controllers/model-version.controller';
import { trpc } from '~/utils/trpc';
import { formatBytes } from '~/utils/number-helpers';

// Type for files from version data
type VersionFile = NonNullable<NonNullable<ModelVersionById>['files']>[number];

// Type for model versions from model.getById
type ModelVersion = { id: number; name: string };

export type LinkedComponent = {
  componentType: ModelFileComponentType;
  modelId: number;
  modelName: string;
  versionId: number;
  versionName: string;
  fileId: number;
  fileName: string;
};

export type LinkComponentModalProps = {
  onSave: (component: LinkedComponent) => void;
  existingComponentTypes?: ModelFileComponentType[];
  onClose?: () => void;
};

export default function LinkComponentModal({
  onSave,
  existingComponentTypes = [],
  onClose,
}: LinkComponentModalProps) {
  const dialog = useDialogContext();
  const [active, setActive] = useState(0);

  // Step 1: Component type
  const [componentType, setComponentType] = useState<ModelFileComponentType | null>(null);

  // Step 2: Model selection
  const [selectedModel, setSelectedModel] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Step 3: Version selection
  const [selectedVersion, setSelectedVersion] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Step 4: File selection
  const [selectedFile, setSelectedFile] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Fetch model versions when model is selected
  const { data: versionData, isLoading: versionsLoading } =
    trpc.modelVersion.getById.useQuery(
      { id: selectedVersion?.id ?? 0, withFiles: true },
      { enabled: !!selectedVersion?.id }
    );

  // Get files from version data - filter to relevant file types based on component type
  const files =
    versionData?.files?.filter((f: VersionFile) => {
      // For component linking, we want non-Model files
      return f.type !== 'Model' && f.type !== 'Pruned Model';
    }) ?? [];

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  const handleModelSelect: QuickSearchDropdownProps['onItemSelected'] = (item, data) => {
    if (item.entityType === 'Model') {
      const modelData = data as SearchIndexDataMap['models'][number];
      setSelectedModel({
        id: modelData.id,
        name: modelData.name,
      });

      // Auto-select version if only one exists
      if (modelData.versions && modelData.versions.length === 1) {
        setSelectedVersion({
          id: modelData.versions[0].id,
          name: modelData.versions[0].name,
        });
        // If version selected, move to step 3 (file selection)
        setActive(3);
      } else {
        setActive(2);
      }
    }
  };

  function handleVersionChange(versionId: string | null) {
    if (!versionId || !selectedModel) return;

    // Need to get version name from the model data - for now just use ID
    setSelectedVersion({
      id: parseInt(versionId),
      name: `Version ${versionId}`,
    });
    setActive(3);
  }

  function handleFileChange(fileId: string | null) {
    if (!fileId) return;

    const file = files.find((f: VersionFile) => f.id === parseInt(fileId));
    if (file) {
      setSelectedFile({
        id: file.id,
        name: file.name,
      });
    }
  }

  function handleSave() {
    if (!componentType || !selectedModel || !selectedVersion || !selectedFile) return;

    onSave({
      componentType,
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      versionId: selectedVersion.id,
      versionName: selectedVersion.name,
      fileId: selectedFile.id,
      fileName: selectedFile.name,
    });
    handleClose();
  }

  function handleBack() {
    if (active > 0) {
      setActive(active - 1);
      // Clear selections for later steps
      if (active === 1) {
        setSelectedModel(null);
        setSelectedVersion(null);
        setSelectedFile(null);
      } else if (active === 2) {
        setSelectedVersion(null);
        setSelectedFile(null);
      } else if (active === 3) {
        setSelectedFile(null);
      }
    }
  }

  // Auto-select file if only one exists
  if (active === 3 && files.length === 1 && !selectedFile) {
    setSelectedFile({
      id: files[0].id,
      name: files[0].name,
    });
  }

  const canSave = componentType && selectedModel && selectedVersion && selectedFile;

  return (
    <Modal {...dialog} onClose={handleClose} size="lg" title="">
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <IconLink size={24} />
            <Title order={4}>Link Existing Component</Title>
          </Group>
          <CloseButton onClick={handleClose} />
        </Group>

        <Text size="sm" c="dimmed">
          Link to an existing model on Civitai as a required component. Users will be directed to
          download it alongside your model.
        </Text>

        <Stepper active={active} onStepClick={setActive} size="sm" allowNextStepsSelect={false}>
          <Stepper.Step label="Component Type" description="What type of component?">
            <Stack gap="md" mt="md">
              <Text size="sm" fw={500}>
                Select the type of component you want to link:
              </Text>
              <Radio.Group
                value={componentType ?? ''}
                onChange={(value) => {
                  setComponentType(value as ModelFileComponentType);
                  setActive(1);
                }}
              >
                <Stack gap="xs">
                  {modelFileComponentTypes
                    .filter((type) => type !== 'Other' && type !== 'Config')
                    .map((type) => (
                      <Radio
                        key={type}
                        value={type}
                        label={getComponentTypeLabel(type)}
                        description={getComponentTypeDescription(type)}
                        disabled={existingComponentTypes.includes(type as ModelFileComponentType)}
                      />
                    ))}
                </Stack>
              </Radio.Group>
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Find Model" description="Search for the model">
            <Stack gap="md" mt="md">
              <Text size="sm" fw={500}>
                Search for the model containing the {componentType} you want to link:
              </Text>
              <QuickSearchDropdown
                supportedIndexes={['models']}
                onItemSelected={handleModelSelect}
                placeholder={`Search for ${componentType ?? 'component'} models...`}
                showIndexSelect={false}
                dropdownItemLimit={10}
              />
              {selectedModel && (
                <Text size="sm" c="green">
                  <IconCheck size={14} style={{ verticalAlign: 'middle' }} /> Selected:{' '}
                  {selectedModel.name}
                </Text>
              )}
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Select Version" description="Choose the version">
            <Stack gap="md" mt="md">
              <Text size="sm" fw={500}>
                Select the version of {selectedModel?.name ?? 'the model'}:
              </Text>
              {selectedModel && (
                <VersionSelector
                  modelId={selectedModel.id}
                  value={selectedVersion?.id?.toString() ?? null}
                  onChange={handleVersionChange}
                />
              )}
            </Stack>
          </Stepper.Step>

          <Stepper.Step label="Select File" description="Choose the file">
            <Stack gap="md" mt="md">
              <Text size="sm" fw={500}>
                Select the file to link:
              </Text>
              {versionsLoading ? (
                <Group justify="center" p="xl">
                  <Loader size="sm" />
                </Group>
              ) : files.length > 0 ? (
                <Select
                  placeholder="Select a file"
                  data={files.map((f: VersionFile) => ({
                    value: f.id.toString(),
                    label: `${f.name} (${formatBytes(f.sizeKB * 1024)})`,
                  }))}
                  value={selectedFile?.id?.toString() ?? null}
                  onChange={handleFileChange}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  No compatible files found in this version.
                </Text>
              )}
            </Stack>
          </Stepper.Step>

          <Stepper.Completed>
            <Stack gap="md" mt="md">
              <Text size="sm" fw={500}>
                Ready to link component:
              </Text>
              <Stack gap="xs">
                <Text size="sm">
                  <strong>Type:</strong> {componentType}
                </Text>
                <Text size="sm">
                  <strong>Model:</strong> {selectedModel?.name}
                </Text>
                <Text size="sm">
                  <strong>Version:</strong> {selectedVersion?.name}
                </Text>
                <Text size="sm">
                  <strong>File:</strong> {selectedFile?.name}
                </Text>
              </Stack>
            </Stack>
          </Stepper.Completed>
        </Stepper>

        <Group justify="space-between" mt="md">
          <Button variant="default" onClick={handleBack} disabled={active === 0}>
            Back
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            {active === 3 && (
              <Button onClick={handleSave} disabled={!canSave} leftSection={<IconPuzzle size={16} />}>
                Link Component
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

// Version selector component that fetches versions for a model
function VersionSelector({
  modelId,
  value,
  onChange,
}: {
  modelId: number;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  // Use the simple model query to get versions
  const { data: model, isLoading } = trpc.model.getById.useQuery({ id: modelId });

  if (isLoading) {
    return (
      <Group justify="center" p="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  const versions = model?.modelVersions ?? [];

  if (versions.length === 0) {
    return <Text size="sm" c="dimmed">No versions found for this model.</Text>;
  }

  return (
    <Select
      placeholder="Select a version"
      data={versions.map((v: ModelVersion) => ({
        value: v.id.toString(),
        label: v.name,
      }))}
      value={value}
      onChange={onChange}
    />
  );
}

// Helper functions for component type labels
function getComponentTypeLabel(type: string): string {
  switch (type) {
    case 'VAE':
      return 'VAE (Variational Autoencoder)';
    case 'TextEncoder':
      return 'Text Encoder';
    case 'UNet':
      return 'UNet';
    case 'CLIPVision':
      return 'CLIP Vision';
    case 'ControlNet':
      return 'ControlNet';
    default:
      return type;
  }
}

function getComponentTypeDescription(type: string): string {
  switch (type) {
    case 'VAE':
      return 'Custom VAE for image encoding/decoding';
    case 'TextEncoder':
      return 'Text encoder model (T5, CLIP, etc.)';
    case 'UNet':
      return 'Diffusion UNet model';
    case 'CLIPVision':
      return 'CLIP Vision encoder for image understanding';
    case 'ControlNet':
      return 'ControlNet for conditional generation';
    default:
      return 'Additional component file';
  }
}

// Trigger function to open the modal
export function openLinkComponentModal(props: LinkComponentModalProps) {
  dialogStore.trigger({
    component: LinkComponentModal,
    props,
  });
}
