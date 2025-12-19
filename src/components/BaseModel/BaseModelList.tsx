import {
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Checkbox,
  ThemeIcon,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  IconPhoto,
  IconVideo,
  IconSparkles,
  IconSchool,
  IconGavel,
  IconEyeOff,
  IconAlertTriangle,
  IconPlus,
  IconEdit,
} from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import {
  baseModels,
  baseModelGroups,
  baseModelFamilies,
  licenses,
  groupById,
  familyById,
  type BaseModelRecord,
} from '~/shared/constants/basemodel.constants';

const baseModelSchema = z.object({
  id: z.number(),
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['image', 'video', 'audio']),
  groupId: z.string().min(1, 'Group is required'),
  licenseId: z.string().optional(),
  ecosystem: z.string().optional(),
  engine: z.string().optional(),
  hidden: z.boolean(),
  deprecated: z.boolean(),
  canGenerate: z.boolean(),
  canTrain: z.boolean(),
  canAuction: z.boolean(),
});

type BaseModelFormData = z.infer<typeof baseModelSchema>;

type BaseModelListProps = {
  onRowClick?: (baseModel: BaseModelRecord) => void;
};

export function BaseModelList({ onRowClick }: BaseModelListProps) {
  const [editingModel, setEditingModel] = useState<BaseModelRecord | null>(null);
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  const sortedBaseModels = useMemo(() => {
    return [...baseModels].sort((a, b) => {
      const groupA = groupById.get(a.groupId);
      const groupB = groupById.get(b.groupId);
      const nameA = groupA?.name ?? '';
      const nameB = groupB?.name ?? '';
      return nameA.localeCompare(nameB);
    });
  }, []);

  const handleAdd = () => {
    setEditingModel(null);
    openModal();
  };

  const handleEdit = (model: BaseModelRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingModel(model);
    openModal();
  };

  const handleModalClose = () => {
    closeModal();
    setEditingModel(null);
  };

  const handleRowClick = (model: BaseModelRecord) => {
    if (onRowClick) {
      onRowClick(model);
    }
  };

  return (
    <>
      <Stack gap="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {sortedBaseModels.length} base models
          </Text>
          <Button leftSection={<IconPlus size={16} />} onClick={handleAdd}>
            Add Base Model
          </Button>
        </Group>

        <ScrollArea>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Group</Table.Th>
                <Table.Th>Ecosystem</Table.Th>
                <Table.Th>Engine</Table.Th>
                <Table.Th>Flags</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sortedBaseModels.map((model) => {
                const group = groupById.get(model.groupId);

                return (
                  <Table.Tr
                    key={model.id}
                    onClick={() => handleRowClick(model)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>{model.id}</Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        {model.type === 'video' ? <IconVideo size={14} /> : <IconPhoto size={14} />}
                        <Text fw={500}>{model.name}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>{model.type}</Table.Td>
                    <Table.Td>{group?.name ?? '—'}</Table.Td>
                    <Table.Td>{model.ecosystem ?? '—'}</Table.Td>
                    <Table.Td>{model.engine ?? '—'}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {model.canGenerate && (
                          <Tooltip label="Can Generate">
                            <ThemeIcon size="xs" color="green" variant="light">
                              <IconSparkles size={10} />
                            </ThemeIcon>
                          </Tooltip>
                        )}
                        {model.canTrain && (
                          <Tooltip label="Can Train">
                            <ThemeIcon size="xs" color="blue" variant="light">
                              <IconSchool size={10} />
                            </ThemeIcon>
                          </Tooltip>
                        )}
                        {model.canAuction && (
                          <Tooltip label="Can Auction">
                            <ThemeIcon size="xs" color="violet" variant="light">
                              <IconGavel size={10} />
                            </ThemeIcon>
                          </Tooltip>
                        )}
                        {model.hidden && (
                          <Tooltip label="Hidden">
                            <ThemeIcon size="xs" color="gray" variant="light">
                              <IconEyeOff size={10} />
                            </ThemeIcon>
                          </Tooltip>
                        )}
                        {model.deprecated && (
                          <Tooltip label="Deprecated">
                            <ThemeIcon size="xs" color="orange" variant="light">
                              <IconAlertTriangle size={10} />
                            </ThemeIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        onClick={(e: React.MouseEvent) => handleEdit(model, e)}
                      >
                        <IconEdit size={16} />
                      </ActionIcon>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Stack>

      <BaseModelModal opened={modalOpened} onClose={handleModalClose} baseModel={editingModel} />
    </>
  );
}

// =============================================================================
// Base Model Modal
// =============================================================================

type BaseModelModalProps = {
  opened: boolean;
  onClose: () => void;
  baseModel: BaseModelRecord | null;
};

function BaseModelModal({ opened, onClose, baseModel }: BaseModelModalProps) {
  const isEditing = !!baseModel;
  const [createGroupOpened, { open: openCreateGroup, close: closeCreateGroup }] =
    useDisclosure(false);

  const form = useForm<BaseModelFormData>({
    resolver: zodResolver(baseModelSchema),
    defaultValues: {
      id: 0,
      name: '',
      type: 'image',
      groupId: '',
      licenseId: '',
      ecosystem: '',
      engine: '',
      hidden: false,
      deprecated: false,
      canGenerate: false,
      canTrain: false,
      canAuction: false,
    },
  });

  // Reset form when modal opens with new data
  useEffect(() => {
    if (opened) {
      form.reset({
        id: baseModel?.id ?? 0,
        name: baseModel?.name ?? '',
        type: baseModel?.type ?? 'image',
        groupId: baseModel?.groupId?.toString() ?? '',
        licenseId: baseModel?.licenseId?.toString() ?? '',
        ecosystem: baseModel?.ecosystem ?? '',
        engine: baseModel?.engine ?? '',
        hidden: baseModel?.hidden ?? false,
        deprecated: baseModel?.deprecated ?? false,
        canGenerate: baseModel?.canGenerate ?? false,
        canTrain: baseModel?.canTrain ?? false,
        canAuction: baseModel?.canAuction ?? false,
      });
    }
  }, [opened, baseModel, form]);

  const handleSubmit = (values: BaseModelFormData) => {
    // TODO: This would call an API endpoint to save the base model
    console.log('Saving base model:', values);
    onClose();
  };

  const handleGroupCreated = (newGroupId: string) => {
    // TODO: Refresh groups list from API
    form.setValue('groupId', newGroupId);
    closeCreateGroup();
  };

  const groupOptions = baseModelGroups.map((group) => ({
    value: group.id.toString(),
    label: group.name,
  }));

  const licenseOptions = [
    { value: '', label: 'No License' },
    ...licenses.map((license) => ({
      value: license.id.toString(),
      label: license.name,
    })),
  ];

  const typeOptions = [
    { value: 'image', label: 'Image' },
    { value: 'video', label: 'Video' },
  ];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEditing ? `Edit Base Model: ${baseModel.name}` : 'Add Base Model'}
      size="lg"
    >
      <form onSubmit={form.handleSubmit(handleSubmit)}>
        <Stack gap="md">
          {/* Basic Information */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Basic Information
            </Text>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Name"
                  description="Unique identifier and display name (e.g., 'SD 1.5', 'SDXL 1.0')"
                  placeholder="Enter name"
                  required
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              name="type"
              control={form.control}
              render={({ field, fieldState }) => (
                <Select
                  {...field}
                  label="Type"
                  description="Media type this base model works with"
                  data={typeOptions}
                  required
                  error={fieldState.error?.message}
                />
              )}
            />
          </Stack>

          {/* Relationships */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Relationships
            </Text>
            <Controller
              name="groupId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Stack gap="xs">
                  <Select
                    {...field}
                    label="Group"
                    description="Base model group (required)"
                    placeholder="Select group"
                    data={groupOptions}
                    searchable
                    required
                    error={fieldState.error?.message}
                  />
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPlus size={14} />}
                    onClick={openCreateGroup}
                  >
                    Create New Group
                  </Button>
                </Stack>
              )}
            />
            <Controller
              name="licenseId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Select
                  {...field}
                  label="License"
                  description="License for this base model (optional)"
                  placeholder="Select license"
                  data={licenseOptions}
                  searchable
                  clearable
                  error={fieldState.error?.message}
                />
              )}
            />
          </Stack>

          {/* Technical Metadata */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Technical Metadata
            </Text>
            <Controller
              name="ecosystem"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Ecosystem"
                  description="For resource filtering (e.g., 'sdxl', 'flux')"
                  placeholder="Enter ecosystem"
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              name="engine"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Engine"
                  description="For orchestration (e.g., 'wan', 'hunyuan')"
                  placeholder="Enter engine"
                  error={fieldState.error?.message}
                />
              )}
            />
          </Stack>

          {/* Capability Flags */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Capability Flags
            </Text>
            <Controller
              name="canGenerate"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onChange={field.onChange}
                  label="Can Generate"
                  description="Available for generation"
                />
              )}
            />
            <Controller
              name="canTrain"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onChange={field.onChange}
                  label="Can Train"
                  description="Available for training"
                />
              )}
            />
            <Controller
              name="canAuction"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onChange={field.onChange}
                  label="Can Auction"
                  description="Available for auction"
                />
              )}
            />
          </Stack>

          {/* Visibility Flags */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Visibility & Status
            </Text>
            <Controller
              name="hidden"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onChange={field.onChange}
                  label="Hidden"
                  description="Hide from dropdowns and UI"
                />
              )}
            />
            <Controller
              name="deprecated"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  checked={field.value}
                  onChange={field.onChange}
                  label="Deprecated"
                  description="Mark as deprecated"
                />
              )}
            />
          </Stack>

          {/* Actions */}
          <Group justify="flex-end" mt="md">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{isEditing ? 'Update' : 'Create'} Base Model</Button>
          </Group>
        </Stack>
      </form>

      {/* Nested modal for creating a new group */}
      <CreateGroupModal
        opened={createGroupOpened}
        onClose={closeCreateGroup}
        onGroupCreated={handleGroupCreated}
      />
    </Modal>
  );
}

// =============================================================================
// Create Group Modal (Nested)
// =============================================================================

const createGroupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  familyId: z.string().optional(),
});

type CreateGroupFormData = z.infer<typeof createGroupSchema>;

type CreateGroupModalProps = {
  opened: boolean;
  onClose: () => void;
  onGroupCreated: (groupId: string) => void;
};

function CreateGroupModal({ opened, onClose, onGroupCreated }: CreateGroupModalProps) {
  const form = useForm<CreateGroupFormData>({
    resolver: zodResolver(createGroupSchema),
    defaultValues: {
      name: '',
      description: '',
      familyId: '',
    },
  });

  useEffect(() => {
    if (opened) {
      form.reset({
        name: '',
        description: '',
        familyId: '',
      });
    }
  }, [opened, form]);

  const handleSubmit = (values: CreateGroupFormData) => {
    // TODO: This would call an API endpoint to create the group
    console.log('Creating new group:', values);

    // For now, simulate creating a group with a temporary ID
    const newGroupId = '999'; // This would come from the API response
    onGroupCreated(newGroupId);
  };

  const familyOptions = [
    { value: '', label: 'No Family' },
    ...baseModelFamilies.map((family) => ({
      value: family.id.toString(),
      label: family.name,
    })),
  ];

  return (
    <Modal opened={opened} onClose={onClose} title="Create New Group" size="md">
      <form onSubmit={form.handleSubmit(handleSubmit)}>
        <Stack gap="md">
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                label="Name"
                description="Unique identifier and display name (e.g., 'Stable Diffusion 1.x', 'Flux.1')"
                placeholder="Enter name"
                required
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            name="description"
            control={form.control}
            render={({ field, fieldState }) => (
              <TextInput
                {...field}
                label="Description"
                description="Description of the group"
                placeholder="Enter description"
                error={fieldState.error?.message}
              />
            )}
          />
          <Controller
            name="familyId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Select
                {...field}
                label="Family"
                description="Base model family (optional)"
                placeholder="Select family"
                data={familyOptions}
                searchable
                clearable
                error={fieldState.error?.message}
              />
            )}
          />

          <Group justify="flex-end" mt="md">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Create Group</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
