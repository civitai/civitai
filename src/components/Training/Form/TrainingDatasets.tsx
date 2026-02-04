import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle, IconPlus, IconX } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import React from 'react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import {
  type DatasetType,
  defaultTrainingState,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import type { TrainingModelData } from '~/types/router';

const MAX_DATASETS = 4;
const MIN_DATASETS = 2; // 1 target + at least 1 control

// Get the display name for a dataset based on its position
const getDatasetDisplayName = (index: number, label?: string) => {
  if (label && label.trim()) return label;
  return index === 0 ? 'Target' : `Control ${index}`;
};

// Get the default label for a new dataset
const getDefaultDatasetLabel = (index: number) => {
  return index === 0 ? 'Target' : `Control ${index}`;
};

type DatasetTabProps = {
  dataset: DatasetType;
  index: number;
  isActive: boolean;
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  onSelect: () => void;
  canRemove: boolean;
  isTarget: boolean;
};

const DatasetTab = ({
  dataset,
  index,
  isActive,
  modelId,
  mediaType,
  onSelect,
  canRemove,
  isTarget,
}: DatasetTabProps) => {
  const { removeDataset } = trainingStore;

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    openConfirmModal({
      title: 'Remove control dataset?',
      children: (
        <Text size="sm">
          Are you sure you want to remove &quot;{getDatasetDisplayName(index, dataset.label)}
          &quot;? This will delete all images in this dataset.
        </Text>
      ),
      labels: { cancel: 'Cancel', confirm: 'Remove' },
      confirmProps: { color: 'red' },
      centered: true,
      onConfirm: () => removeDataset(modelId, mediaType, dataset.id),
    });
  };

  return (
    <Tabs.Tab
      value={index.toString()}
      rightSection={
        canRemove ? (
          <ActionIcon
            size="xs"
            color="red"
            variant="subtle"
            onClick={handleRemove}
            aria-label="Remove dataset"
          >
            <IconX size={12} />
          </ActionIcon>
        ) : null
      }
    >
      <Group gap={4}>
        <Text size="sm">{getDatasetDisplayName(index, dataset.label)}</Text>
        {isTarget && (
          <Badge size="xs" variant="light" color="violet">
            Target
          </Badge>
        )}
        {dataset.imageList.length > 0 && (
          <Badge size="xs" variant="filled" color="blue">
            {dataset.imageList.length}
          </Badge>
        )}
      </Group>
    </Tabs.Tab>
  );
};

type DatasetConfigProps = {
  dataset: DatasetType;
  index: number;
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  isTarget: boolean;
};

export const DatasetConfig = ({
  dataset,
  index,
  modelId,
  mediaType,
  isTarget,
}: DatasetConfigProps) => {
  const { updateDatasetLabel } = trainingStore;

  return (
    <Paper p="md" withBorder radius="sm" className="bg-gray-0 dark:bg-dark-6">
      <Stack gap="md">
        <Group gap="xs" align="center">
          {isTarget ? (
            <Badge color="violet" variant="light">
              Target Dataset
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Control Dataset {index}
            </Badge>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {isTarget
            ? 'The target dataset contains the final results you want the model to learn (e.g., logo already on shirt, background removed).'
            : 'Control datasets contain input images that you want the model to modify or use as references.'}
        </Text>
        <TextInput
          label="Dataset Label"
          description="A custom name for this dataset (optional)"
          placeholder={getDefaultDatasetLabel(index)}
          value={dataset.label}
          onChange={(e) =>
            updateDatasetLabel(modelId, mediaType, dataset.id, e.currentTarget.value)
          }
        />
      </Stack>
    </Paper>
  );
};

type TrainingDatasetsViewProps = {
  model: NonNullable<TrainingModelData>;
  children: (dataset: DatasetType) => React.ReactNode;
};

export const TrainingDatasetsView = ({ model, children }: TrainingDatasetsViewProps) => {
  const thisModelVersion = model.modelVersions[0];
  const thisMediaType =
    (thisModelVersion.trainingDetails as TrainingDetailsObj | undefined)?.mediaType ?? 'image';

  const { datasets, activeDatasetIndex } = useTrainingImageStore(
    (state) =>
      state[model.id] ?? {
        ...defaultTrainingState,
      }
  );

  const { setActiveDataset, addDataset } = trainingStore;

  const activeDataset = datasets[activeDatasetIndex] ?? datasets[0];

  const handleAddDataset = () => {
    if (datasets.length >= MAX_DATASETS) return;
    addDataset(model.id, thisMediaType, getDefaultDatasetLabel(datasets.length));
  };

  // Check if all datasets have the same number of images
  const imageCounts = datasets.map((d) => d.imageList.length);
  const hasImages = imageCounts.some((c) => c > 0);
  const allCountsMatch = hasImages && imageCounts.every((c) => c === imageCounts[0]);
  const showCountMismatchWarning = hasImages && !allCountsMatch;

  return (
    <Stack>
      {/* Instructions */}
      <Alert color="blue" title="Image Edit Training" icon={<IconAlertCircle size={16} />}>
        <Stack gap="xs">
          <Text size="sm">
            Image Edit training requires paired datasets with matching images:
          </Text>
          <Text size="sm" component="ul" className="m-0 pl-4">
            <li>
              <strong>Target Dataset:</strong> Final results you want (e.g., logo on shirt)
            </li>
            <li>
              <strong>Control Datasets:</strong> Input images to transform (e.g., shirts, logos)
            </li>
          </Text>
          <Text size="sm" c="dimmed">
            <strong>Important:</strong> All datasets must have the same number of images, and
            filenames must match across datasets (e.g., 01.png in Target pairs with 01.png in
            Control 1).
          </Text>
        </Stack>
      </Alert>

      {/* Count mismatch warning */}
      {showCountMismatchWarning && (
        <Alert color="orange" title="Image Count Mismatch" icon={<IconAlertCircle size={16} />}>
          <Text size="sm">
            All datasets must have the same number of images for proper pairing. Current counts:{' '}
            {datasets.map((d, i) => `${getDatasetDisplayName(i, d.label)}: ${d.imageList.length}`).join(', ')}
          </Text>
        </Alert>
      )}

      <Paper p="sm" withBorder radius="sm">
        <Group justify="space-between" align="center" mb="xs">
          <Group gap="xs">
            <Text fw={500}>Datasets ({datasets.length})</Text>
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              <Stack gap="xs">
                <Text size="sm">
                  Image Edit training requires at least 2 datasets: 1 target and 1+ control
                  datasets.
                </Text>
                <Text size="sm">Maximum {MAX_DATASETS} datasets (1 target + 3 controls).</Text>
              </Stack>
            </InfoPopover>
          </Group>
          <Tooltip
            label={`Maximum ${MAX_DATASETS} datasets allowed`}
            disabled={datasets.length < MAX_DATASETS}
          >
            <Button
              size="compact-sm"
              variant="light"
              color="green"
              leftSection={<IconPlus size={14} />}
              onClick={handleAddDataset}
              disabled={datasets.length >= MAX_DATASETS}
            >
              Add Control Dataset
            </Button>
          </Tooltip>
        </Group>

        <Tabs
          value={activeDatasetIndex.toString()}
          onChange={(value) => {
            if (value !== null) {
              setActiveDataset(model.id, thisMediaType, parseInt(value, 10));
            }
          }}
        >
          <Tabs.List>
            {datasets.map((dataset, idx) => (
              <DatasetTab
                key={dataset.id}
                dataset={dataset}
                index={idx}
                isActive={idx === activeDatasetIndex}
                modelId={model.id}
                mediaType={thisMediaType}
                onSelect={() => setActiveDataset(model.id, thisMediaType, idx)}
                canRemove={idx > 0 && datasets.length > MIN_DATASETS} // Target cannot be removed, need min 2
                isTarget={idx === 0}
              />
            ))}
          </Tabs.List>
        </Tabs>
      </Paper>

      {activeDataset && (
        <>
          <DatasetConfig
            dataset={activeDataset}
            index={activeDatasetIndex}
            modelId={model.id}
            mediaType={thisMediaType}
            isTarget={activeDatasetIndex === 0}
          />
          {children(activeDataset)}
        </>
      )}
    </Stack>
  );
};
