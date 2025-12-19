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
  Tooltip,
  ActionIcon,
  JsonInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { IconPlus, IconEdit } from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import {
  baseModels,
  baseModelGroups,
  baseModelFamilies,
  groupById,
  familyById,
  type BaseModelGroupRecord,
  type BaseModelRecord,
} from '~/shared/constants/basemodel.constants';

const groupSchema = z.object({
  id: z.number(),
  key: z.string().min(1, 'Key is required'),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  familyId: z.string().optional(),
  sortOrder: z.number(),
  settings: z.string().optional(), // JSON string
  modelVersionId: z.string().optional(),
});

type GroupFormData = z.infer<typeof groupSchema>;

type BaseModelGroupListProps = {
  onRowClick?: (group: BaseModelGroupRecord) => void;
};

export function BaseModelGroupList({ onRowClick }: BaseModelGroupListProps) {
  const [editingGroup, setEditingGroup] = useState<BaseModelGroupRecord | null>(null);
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  const sortedGroups = useMemo(() => {
    return [...baseModelGroups].sort((a, b) => {
      const familyA = a.familyId ? familyById.get(a.familyId) : undefined;
      const familyB = b.familyId ? familyById.get(b.familyId) : undefined;
      const nameA = familyA?.name ?? '';
      const nameB = familyB?.name ?? '';

      // Sort by family first, then by group name
      if (nameA !== nameB) {
        return nameA.localeCompare(nameB);
      }
      return a.name.localeCompare(b.name);
    });
  }, []);

  const handleAdd = () => {
    setEditingGroup(null);
    openModal();
  };

  const handleEdit = (group: BaseModelGroupRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingGroup(group);
    openModal();
  };

  const handleModalClose = () => {
    closeModal();
    setEditingGroup(null);
  };

  const handleRowClick = (group: BaseModelGroupRecord) => {
    if (onRowClick) {
      onRowClick(group);
    }
  };

  return (
    <>
      <Stack gap="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {sortedGroups.length} base model groups
          </Text>
          <Button leftSection={<IconPlus size={16} />} onClick={handleAdd}>
            Add Group
          </Button>
        </Group>

        <ScrollArea>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>ID</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Key</Table.Th>
                <Table.Th>Family</Table.Th>
                <Table.Th>Base Models</Table.Th>
                <Table.Th>Default Model</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sortedGroups.map((group) => {
                const family = group.familyId ? familyById.get(group.familyId) : undefined;
                const groupModels = baseModels.filter((m) => m.groupId === group.id);

                return (
                  <Table.Tr
                    key={group.id}
                    onClick={() => handleRowClick(group)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>{group.id}</Table.Td>
                    <Table.Td>
                      <Text fw={500}>{group.name}</Text>
                    </Table.Td>
                    <Table.Td>
                      <code>{group.key}</code>
                    </Table.Td>
                    <Table.Td>{family?.name ?? '—'}</Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Badge size="sm" variant="light">
                          {groupModels.length} models
                        </Badge>
                        {groupModels.length > 0 && (
                          <Tooltip
                            label={groupModels.map((m) => m.name).join(', ')}
                            multiline
                            w={300}
                          >
                            <Text size="xs" c="dimmed" style={{ cursor: 'help' }}>
                              (hover)
                            </Text>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {group.modelVersionId ? (
                        <Badge size="sm" color="teal" variant="light">
                          {group.modelVersionId}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </Table.Td>
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <ActionIcon
                        variant="subtle"
                        color="blue"
                        onClick={(e: React.MouseEvent) => handleEdit(group, e)}
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

      <BaseModelGroupModal
        opened={modalOpened}
        onClose={handleModalClose}
        group={editingGroup}
      />
    </>
  );
}

// =============================================================================
// Base Model Group Modal
// =============================================================================

type BaseModelGroupModalProps = {
  opened: boolean;
  onClose: () => void;
  group: BaseModelGroupRecord | null;
};

function BaseModelGroupModal({ opened, onClose, group }: BaseModelGroupModalProps) {
  const isEditing = !!group;

  const form = useForm<GroupFormData>({
    resolver: zodResolver(groupSchema),
    defaultValues: {
      id: 0,
      key: '',
      name: '',
      description: '',
      familyId: '',
      sortOrder: 0,
      settings: '',
      modelVersionId: '',
    },
  });

  // Reset form when modal opens with new data
  useEffect(() => {
    if (opened) {
      form.reset({
        id: group?.id ?? 0,
        key: group?.key ?? '',
        name: group?.name ?? '',
        description: group?.description ?? '',
        familyId: group?.familyId?.toString() ?? '',
        sortOrder: group?.sortOrder ?? 0,
        settings: group?.settings ? JSON.stringify(group.settings, null, 2) : '',
        modelVersionId: group?.modelVersionId?.toString() ?? '',
      });
    }
  }, [opened, group, form]);

  const handleSubmit = (values: GroupFormData) => {
    // TODO: This would call an API endpoint to save the group
    console.log('Saving base model group:', values);
    onClose();
  };

  const familyOptions = [
    { value: '', label: 'No Family' },
    ...baseModelFamilies.map((family) => ({
      value: family.id.toString(),
      label: family.name,
    })),
  ];

  const groupModels = group ? baseModels.filter((m) => m.groupId === group.id) : [];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEditing ? `Edit Group: ${group.name}` : 'Add Group'}
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
              name="key"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Key"
                  description="Unique identifier (e.g., 'SD1', 'SDXL', 'Flux1')"
                  placeholder="Enter key"
                  required
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Name"
                  description="Display name for the group"
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
          </Stack>

          {/* Relationships */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Relationships
            </Text>
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
          </Stack>

          {/* Configuration */}
          <Stack gap="xs">
            <Text size="sm" fw={500} c="dimmed">
              Configuration
            </Text>
            <Controller
              name="modelVersionId"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Default Model Version ID"
                  description="Default model version for generation"
                  placeholder="Enter model version ID"
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              name="sortOrder"
              control={form.control}
              render={({ field, fieldState }) => (
                <TextInput
                  {...field}
                  label="Sort Order"
                  description="Display order (lower numbers appear first)"
                  placeholder="0"
                  type="number"
                  onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                  error={fieldState.error?.message}
                />
              )}
            />
            <Controller
              name="settings"
              control={form.control}
              render={({ field, fieldState }) => (
                <JsonInput
                  {...field}
                  label="Settings (JSON)"
                  description="Aspect ratios and other configuration"
                  placeholder='{"aspectRatios": []}'
                  minRows={4}
                  autosize
                  formatOnBlur
                  error={fieldState.error?.message}
                />
              )}
            />
          </Stack>

          {/* Associated Base Models (Read-only) */}
          {isEditing && groupModels.length > 0 && (
            <Stack gap="xs">
              <Text size="sm" fw={500} c="dimmed">
                Associated Base Models ({groupModels.length})
              </Text>
              <Text size="xs" c="dimmed">
                Base models are managed in the Base Models list. You cannot add/remove them here.
              </Text>
              <Group gap="xs">
                {groupModels.map((model) => (
                  <Badge key={model.id} size="sm" variant="light">
                    {model.name}
                  </Badge>
                ))}
              </Group>
            </Stack>
          )}

          {/* Actions */}
          <Group justify="flex-end" mt="md">
            <Button variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">{isEditing ? 'Update' : 'Create'} Group</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
