import type { InputWrapperProps } from '@mantine/core';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Input,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconX, IconCube } from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { baseModels } from '~/shared/constants/basemodel.constants';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { ModelType } from '~/shared/utils/prisma/enums';
import { baseModelMakesMediaType } from '~/utils/crucible-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number[];
  onChange?: (ids: number[]) => void;
  maxSelections?: number;
  disabled?: boolean;
  /** When false, any published model can be picked, not only ones the generator can run. */
  generatableOnly?: boolean;
  /** Only models that make this media type can be picked. */
  mediaType?: MediaType;
};

const RESOURCE_TYPES = [ModelType.Checkpoint, ModelType.LORA, ModelType.LoCon, ModelType.DoRA];

/**
 * Multi-select component for model versions using the resource select modal.
 * Returns just the model version IDs for storage.
 * Compatible with withController HOC for form integration.
 */
export function ModelVersionMultiSelect({
  value = [],
  onChange,
  maxSelections = 10,
  disabled,
  generatableOnly = true,
  mediaType,
  ...inputWrapperProps
}: Props) {
  const makesMediaType = (baseModel: string) =>
    !mediaType || baseModelMakesMediaType(baseModel, mediaType);
  const mediaBaseModels = useMemo(
    () =>
      mediaType
        ? baseModels.filter((baseModel) => baseModelMakesMediaType(baseModel, mediaType))
        : undefined,
    [mediaType]
  );
  // Track selected resources for display
  const [selectedResources, setSelectedResources] = useState<GenerationResource[]>([]);

  // Fetch model version details for existing IDs (edit mode)
  const { data: versionDetails, isLoading: isLoadingDetails } =
    trpc.modelVersion.getVersionsByIds.useQuery(
      { ids: value },
      {
        enabled: value.length > 0 && selectedResources.length === 0,
      }
    );

  // Sync fetched details to local state
  useEffect(() => {
    if (versionDetails && versionDetails.length > 0 && selectedResources.length === 0) {
      // Convert to GenerationResource-like objects for display
      const resources: GenerationResource[] = versionDetails.map((v) => ({
        id: v.id,
        name: v.name,
        trainedWords: [],
        baseModel: v.baseModel || 'Unknown',
        canGenerate: true,
        hasAccess: true,
        minStrength: 0,
        maxStrength: 1,
        strength: 1,
        model: {
          id: v.modelId,
          name: v.modelName,
          type: ModelType.Checkpoint,
        },
      }));
      setSelectedResources(resources);
    }
  }, [versionDetails, selectedResources.length]);

  const canAdd = value.length < maxSelections;

  const addResources = (resources: GenerationResource[]) => {
    const misfits = resources.filter((resource) => !makesMediaType(resource.baseModel));
    if (misfits.length)
      showErrorNotification({
        title: `Only models that make ${mediaType}s`,
        error: new Error(
          `${misfits.map((resource) => resource.model.name).join(', ')} can't be required here.`
        ),
      });
    const added = resources
      .filter((resource) => makesMediaType(resource.baseModel) && !value.includes(resource.id))
      .slice(0, maxSelections - value.length);
    if (!added.length) return;
    setSelectedResources((prev) => [...prev, ...added]);
    onChange?.([...value, ...added.map((resource) => resource.id)]);
  };

  const handleOpenResourceSelect = () => {
    openResourceSelectModal({
      title: 'Select Model Versions',
      onSelect: (resource) => addResources([resource]),
      onSelectMultiple: addResources,
      limit: maxSelections - value.length,
      options: {
        canGenerate: generatableOnly || undefined,
        resources: RESOURCE_TYPES.map((type) => ({ type, baseModels: mediaBaseModels })),
        excludeIds: value,
      },
      selectSource: generatableOnly ? 'generation' : 'addResource',
    });
  };

  const handleRemove = (id: number) => {
    setSelectedResources((prev) => prev.filter((r) => r.id !== id));
    onChange?.(value.filter((v) => v !== id));
  };

  const isLoading = isLoadingDetails && value.length > 0 && selectedResources.length === 0;

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <Stack gap="xs" mt={5}>
        {canAdd && !disabled && (
          <Button
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={handleOpenResourceSelect}
            size="sm"
          >
            Add Resource
          </Button>
        )}
        {isLoading ? (
          <Card withBorder p="sm">
            <Group justify="center">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Loading selected versions...
              </Text>
            </Group>
          </Card>
        ) : selectedResources.length > 0 ? (
          <Card withBorder p="xs">
            <Stack gap="xs">
              {selectedResources.map((resource) => (
                <Group key={resource.id} justify="space-between" wrap="nowrap">
                  <Group gap="xs" wrap="nowrap" style={{ overflow: 'hidden' }}>
                    <ThemeIcon size="sm" variant="light" color="blue">
                      <IconCube size={14} />
                    </ThemeIcon>
                    <div style={{ overflow: 'hidden' }}>
                      <Text size="sm" fw={500} truncate>
                        {resource.model.name}
                      </Text>
                      <Group gap={4}>
                        <Text size="xs" c="dimmed" truncate>
                          {resource.name}
                        </Text>
                        <Badge size="xs" variant="light">
                          {resource.baseModel}
                        </Badge>
                      </Group>
                      {!makesMediaType(resource.baseModel) && (
                        <Text size="xs" c="red">
                          Doesn&apos;t make {mediaType}s, remove it
                        </Text>
                      )}
                    </div>
                  </Group>
                  {!disabled && (
                    <Tooltip label="Remove">
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => handleRemove(resource.id)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              ))}
            </Stack>
          </Card>
        ) : (
          <Card p="xs" className="flex items-start" withBorder>
            <Text size="md" c="dimmed">
              No resources selected
            </Text>
            <Text size="sm" c="dimmed">
              Any model allowed
            </Text>
          </Card>
        )}

        {!canAdd && (
          <Text size="xs" c="dimmed">
            Maximum {maxSelections} model versions allowed
          </Text>
        )}
      </Stack>
    </Input.Wrapper>
  );
}
