import {
  Badge,
  Card,
  Container,
  Drawer,
  Group,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Title,
  Table,
  ThemeIcon,
  Tooltip,
  ScrollArea,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCheck,
  IconX,
  IconPhoto,
  IconVideo,
  IconScale,
  IconSparkles,
  IconSchool,
  IconGavel,
  IconEyeOff,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import { BaseModelList } from '~/components/BaseModel/BaseModelList';
import { BaseModelGroupList } from '~/components/BaseModel/BaseModelGroupList';
import {
  baseModels,
  baseModelFamilies,
  baseModelGroups,
  licenses,
  generationSupport,
  familyById,
  groupById,
  licenseById,
  baseModelById,
  type BaseModelRecord,
  type BaseModelGroupRecord,
} from '~/shared/constants/basemodel.constants';

type ViewType = 'family' | 'group' | 'license' | 'generation' | 'list' | 'groups';

function BaseModelsPage() {
  const [activeTab, setActiveTab] = useState<ViewType>('family');
  const [selectedBaseModel, setSelectedBaseModel] = useState<BaseModelRecord | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<BaseModelGroupRecord | null>(null);
  const [baseModelDrawerOpened, { open: openBaseModelDrawer, close: closeBaseModelDrawer }] =
    useDisclosure(false);
  const [groupDrawerOpened, { open: openGroupDrawer, close: closeGroupDrawer }] =
    useDisclosure(false);

  const handleBadgeClick = (baseModel: BaseModelRecord) => {
    setSelectedBaseModel(baseModel);
    openBaseModelDrawer();
  };

  const handleGroupClick = (group: BaseModelGroupRecord) => {
    setSelectedGroup(group);
    openGroupDrawer();
  };

  return (
    <>
      <Meta title="Base Models - Moderator" deIndex />
      <Container size="xl">
        <Stack gap="lg">
          <Stack gap={0}>
            <Title order={1}>Base Models</Title>
            <Text size="sm" c="dimmed">
              View and explore base model configuration data.
            </Text>
          </Stack>

          <Tabs value={activeTab} onChange={(v) => setActiveTab(v as ViewType)}>
            <Tabs.List>
              <Tabs.Tab value="family">By Family</Tabs.Tab>
              <Tabs.Tab value="group">By Group</Tabs.Tab>
              <Tabs.Tab value="license">By License</Tabs.Tab>
              <Tabs.Tab value="generation">Generation Support</Tabs.Tab>
              <Tabs.Tab value="list">List</Tabs.Tab>
              <Tabs.Tab value="groups">Groups</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="family" pt="md">
              <FamilyView onBadgeClick={handleBadgeClick} />
            </Tabs.Panel>

            <Tabs.Panel value="group" pt="md">
              <GroupView onBadgeClick={handleBadgeClick} />
            </Tabs.Panel>

            <Tabs.Panel value="license" pt="md">
              <LicenseView onBadgeClick={handleBadgeClick} />
            </Tabs.Panel>

            <Tabs.Panel value="generation" pt="md">
              <GenerationSupportView onBadgeClick={handleBadgeClick} />
            </Tabs.Panel>

            <Tabs.Panel value="list" pt="md">
              <BaseModelList onRowClick={handleBadgeClick} />
            </Tabs.Panel>

            <Tabs.Panel value="groups" pt="md">
              <BaseModelGroupList onRowClick={handleGroupClick} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>

      <BaseModelDrawer
        baseModel={selectedBaseModel}
        opened={baseModelDrawerOpened}
        onClose={closeBaseModelDrawer}
      />
      <GroupDrawer group={selectedGroup} opened={groupDrawerOpened} onClose={closeGroupDrawer} />
    </>
  );
}

// =============================================================================
// Group Drawer
// =============================================================================

type GroupDrawerProps = {
  group: BaseModelGroupRecord | null;
  opened: boolean;
  onClose: () => void;
};

function GroupDrawer({ group, opened, onClose }: GroupDrawerProps) {
  if (!group) return null;

  const family = group.familyId ? familyById.get(group.familyId) : undefined;
  const groupModels = baseModels.filter((m) => m.groupId === group.id);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={<Title order={3}>{group.name}</Title>}
      position="right"
      size="md"
    >
      <Stack gap="md">
        {/* Basic Info */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Basic Information
          </Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td fw={500}>ID</Table.Td>
                <Table.Td>{group.id}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Key</Table.Td>
                <Table.Td>
                  <code>{group.key}</code>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Family</Table.Td>
                <Table.Td>{family?.name ?? '—'}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Description</Table.Td>
                <Table.Td>{group.description ?? '—'}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Sort Order</Table.Td>
                <Table.Td>{group.sortOrder}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Stack>

        {/* Default Model Version */}
        {group.modelVersionId && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Default Model
            </Text>
            <Badge color="teal" variant="light">
              Model Version ID: {group.modelVersionId}
            </Badge>
          </Stack>
        )}

        {/* Settings */}
        {group.settings && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Settings
            </Text>
            <ScrollArea.Autosize mah={200}>
              <code
                style={{
                  display: 'block',
                  padding: '8px',
                  background: 'var(--mantine-color-gray-0)',
                  borderRadius: '4px',
                  fontSize: '12px',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {JSON.stringify(group.settings, null, 2)}
              </code>
            </ScrollArea.Autosize>
          </Stack>
        )}

        {/* Associated Base Models */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Associated Base Models ({groupModels.length})
          </Text>
          {groupModels.length > 0 ? (
            <Group gap="xs">
              {groupModels.map((model) => (
                <Badge
                  key={model.id}
                  color={model.hidden ? 'gray' : model.deprecated ? 'orange' : 'blue'}
                  variant={model.hidden || model.deprecated ? 'outline' : 'filled'}
                  size="sm"
                >
                  {model.name}
                </Badge>
              ))}
            </Group>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">
              No base models in this group
            </Text>
          )}
        </Stack>
      </Stack>
    </Drawer>
  );
}

// =============================================================================
// Base Model Badge Component
// =============================================================================

type BaseModelBadgeProps = {
  baseModel: BaseModelRecord;
  onClick: (baseModel: BaseModelRecord) => void;
  size?: 'sm' | 'md' | 'lg';
};

function BaseModelBadge({ baseModel, onClick, size = 'md' }: BaseModelBadgeProps) {
  const color = baseModel.hidden
    ? 'gray'
    : baseModel.deprecated
    ? 'orange'
    : baseModel.type === 'video'
    ? 'violet'
    : 'blue';

  return (
    <Badge
      component="button"
      onClick={() => onClick(baseModel)}
      color={color}
      variant={baseModel.hidden || baseModel.deprecated ? 'outline' : 'filled'}
      size={size}
      style={{ cursor: 'pointer', textTransform: 'none' }}
      leftSection={baseModel.type === 'video' ? <IconVideo size={12} /> : <IconPhoto size={12} />}
    >
      {baseModel.name}
    </Badge>
  );
}

// =============================================================================
// Base Model Drawer
// =============================================================================

type BaseModelDrawerProps = {
  baseModel: BaseModelRecord | null;
  opened: boolean;
  onClose: () => void;
};

function BaseModelDrawer({ baseModel, opened, onClose }: BaseModelDrawerProps) {
  if (!baseModel) return null;

  const group = groupById.get(baseModel.groupId);
  const family = group?.familyId ? familyById.get(group.familyId) : undefined;
  const license = baseModel.licenseId ? licenseById.get(baseModel.licenseId) : undefined;

  // Get generation support for this base model
  const support = generationSupport.filter((s) => s.baseModelId === baseModel.id);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={<Title order={3}>{baseModel.name}</Title>}
      position="right"
      size="md"
    >
      <Stack gap="md">
        {/* Basic Info */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Basic Information
          </Text>
          <Table>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td fw={500}>ID</Table.Td>
                <Table.Td>{baseModel.id}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Type</Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    {baseModel.type === 'video' ? <IconVideo size={16} /> : <IconPhoto size={16} />}
                    {baseModel.type}
                  </Group>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Family</Table.Td>
                <Table.Td>{family?.name ?? '—'}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Group</Table.Td>
                <Table.Td>{group?.name ?? '—'}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Stack>

        {/* Flags */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Flags
          </Text>
          <Group gap="xs">
            <FlagBadge
              label="Can Generate"
              value={baseModel.canGenerate}
              icon={<IconSparkles size={14} />}
            />
            <FlagBadge
              label="Can Train"
              value={baseModel.canTrain}
              icon={<IconSchool size={14} />}
            />
            <FlagBadge
              label="Can Auction"
              value={baseModel.canAuction}
              icon={<IconGavel size={14} />}
            />
            <FlagBadge
              label="Hidden"
              value={baseModel.hidden}
              icon={<IconEyeOff size={14} />}
              negative
            />
            <FlagBadge
              label="Deprecated"
              value={baseModel.deprecated}
              icon={<IconAlertTriangle size={14} />}
              negative
            />
          </Group>
        </Stack>

        {/* Technical */}
        {(baseModel.ecosystem || baseModel.engine) && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Technical
            </Text>
            <Table>
              <Table.Tbody>
                {baseModel.ecosystem && (
                  <Table.Tr>
                    <Table.Td fw={500}>Ecosystem</Table.Td>
                    <Table.Td>
                      <code>{baseModel.ecosystem}</code>
                    </Table.Td>
                  </Table.Tr>
                )}
                {baseModel.engine && (
                  <Table.Tr>
                    <Table.Td fw={500}>Engine</Table.Td>
                    <Table.Td>
                      <code>{baseModel.engine}</code>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Stack>
        )}

        {/* License */}
        {license && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              License
            </Text>
            <Table>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td fw={500}>Name</Table.Td>
                  <Table.Td>{license.name}</Table.Td>
                </Table.Tr>
                {license.url && (
                  <Table.Tr>
                    <Table.Td fw={500}>URL</Table.Td>
                    <Table.Td>
                      <a href={license.url} target="_blank" rel="noopener noreferrer">
                        View License
                      </a>
                    </Table.Td>
                  </Table.Tr>
                )}
                {license.disableMature && (
                  <Table.Tr>
                    <Table.Td fw={500}>Mature Content</Table.Td>
                    <Table.Td>
                      <Badge color="red" size="sm">
                        Disabled
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
            {license.notice && (
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                {license.notice}
              </Text>
            )}
          </Stack>
        )}

        {/* Generation Support */}
        {support.length > 0 && (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Generation Support ({support.length} entries)
            </Text>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Group</Table.Th>
                  <Table.Th>Model Type</Table.Th>
                  <Table.Th>Support</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {support.slice(0, 10).map((s) => {
                  const grp = groupById.get(s.groupId);
                  return (
                    <Table.Tr key={s.id}>
                      <Table.Td>{grp?.name ?? s.groupId}</Table.Td>
                      <Table.Td>{s.modelType}</Table.Td>
                      <Table.Td>
                        <Badge
                          color={s.support === 'full' ? 'green' : 'yellow'}
                          size="sm"
                          style={{ textTransform: 'none' }}
                        >
                          {s.support}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            {support.length > 10 && (
              <Text size="xs" c="dimmed">
                ...and {support.length - 10} more entries
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Drawer>
  );
}

// =============================================================================
// Flag Badge Component
// =============================================================================

type FlagBadgeProps = {
  label: string;
  value?: boolean;
  icon: React.ReactNode;
  negative?: boolean;
};

function FlagBadge({ label, value, icon, negative }: FlagBadgeProps) {
  const isActive = !!value;
  const color = negative ? (isActive ? 'red' : 'gray') : isActive ? 'green' : 'gray';

  return (
    <Tooltip label={label}>
      <Badge
        color={color}
        variant={isActive ? 'filled' : 'outline'}
        size="sm"
        leftSection={icon}
        style={{ textTransform: 'none' }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}

// =============================================================================
// Family View
// =============================================================================

type ViewProps = {
  onBadgeClick: (baseModel: BaseModelRecord) => void;
};

function FamilyView({ onBadgeClick }: ViewProps) {
  const familiesWithModels = useMemo(() => {
    return baseModelFamilies.map((family) => {
      // Get all groups in this family
      const familyGroups = baseModelGroups.filter((g) => g.familyId === family.id);
      const groupIds = new Set(familyGroups.map((g) => g.id));
      // Get all base models in those groups
      const familyBaseModels = baseModels.filter((m) => groupIds.has(m.groupId));
      return {
        ...family,
        baseModels: familyBaseModels,
      };
    });
  }, []);

  // Get models whose groups don't have a family
  const orphanModels = useMemo(() => {
    const groupsWithoutFamily = baseModelGroups.filter((g) => !g.familyId);
    const orphanGroupIds = new Set(groupsWithoutFamily.map((g) => g.id));
    return baseModels.filter((m) => orphanGroupIds.has(m.groupId));
  }, []);

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {familiesWithModels.map((family) => (
        <Card key={family.id} withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Text fw={600} size="lg">
                {family.name}
              </Text>
              <Badge size="sm" variant="light">
                {family.baseModels.length}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {family.description}
            </Text>
            <Group gap="xs">
              {family.baseModels.map((model) => (
                <BaseModelBadge key={model.id} baseModel={model} onClick={onBadgeClick} />
              ))}
            </Group>
          </Stack>
        </Card>
      ))}
      {orphanModels.length > 0 && (
        <Card withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Text fw={600} size="lg" c="dimmed">
                No Family
              </Text>
              <Badge size="sm" variant="light">
                {orphanModels.length}
              </Badge>
            </Group>
            <Group gap="xs">
              {orphanModels.map((model) => (
                <BaseModelBadge key={model.id} baseModel={model} onClick={onBadgeClick} />
              ))}
            </Group>
          </Stack>
        </Card>
      )}
    </SimpleGrid>
  );
}

// =============================================================================
// Group View
// =============================================================================

function GroupView({ onBadgeClick }: ViewProps) {
  const groupsWithModels = useMemo(() => {
    return baseModelGroups.map((group) => ({
      ...group,
      family: group.familyId ? familyById.get(group.familyId) : undefined,
      baseModels: baseModels.filter((m) => m.groupId === group.id),
    }));
  }, []);

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {groupsWithModels.map((group) => (
        <Card key={group.id} withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <Text fw={600} size="lg">
                {group.name}
              </Text>
              <Group gap={4}>
                <Badge size="sm" variant="light">
                  {group.baseModels.length}
                </Badge>
              </Group>
            </Group>
            <Group gap="xs">
              {group.family && (
                <Badge size="sm" variant="light" color="gray">
                  {group.family.name}
                </Badge>
              )}
              {group.modelVersionId && (
                <Tooltip label={`Model Version ID: ${group.modelVersionId}`}>
                  <Badge size="sm" color="teal" variant="light">
                    Default Set
                  </Badge>
                </Tooltip>
              )}
              <Text size="xs" c="dimmed">
                Key: <code>{group.key}</code>
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              {group.description}
            </Text>
            {group.baseModels.length > 0 ? (
              <Group gap="xs">
                {group.baseModels.map((model) => (
                  <BaseModelBadge key={model.id} baseModel={model} onClick={onBadgeClick} />
                ))}
              </Group>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                No base models in this group
              </Text>
            )}
          </Stack>
        </Card>
      ))}
    </SimpleGrid>
  );
}

// =============================================================================
// License View
// =============================================================================

function LicenseView({ onBadgeClick }: ViewProps) {
  const licensesWithModels = useMemo(() => {
    return licenses.map((license) => ({
      ...license,
      baseModels: baseModels.filter((m) => m.licenseId === license.id),
    }));
  }, []);

  // Also get models without a license
  const unlicensedModels = useMemo(() => {
    return baseModels.filter((m) => !m.licenseId);
  }, []);

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {licensesWithModels.map((license) => (
        <Card key={license.id} withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap">
                <IconScale size={18} />
                <Text fw={600} size="lg" lineClamp={1}>
                  {license.name}
                </Text>
              </Group>
              <Group gap={4}>
                <Badge size="sm" variant="light">
                  {license.baseModels.length}
                </Badge>
                {license.disableMature && (
                  <Badge size="sm" color="red" variant="outline">
                    No Mature
                  </Badge>
                )}
              </Group>
            </Group>
            {license.url && (
              <Text size="sm">
                <a href={license.url} target="_blank" rel="noopener noreferrer">
                  View License →
                </a>
              </Text>
            )}
            {license.notice && (
              <Text size="xs" c="dimmed" lineClamp={2}>
                {license.notice}
              </Text>
            )}
            {license.baseModels.length > 0 ? (
              <Group gap="xs">
                {license.baseModels.map((model) => (
                  <BaseModelBadge key={model.id} baseModel={model} onClick={onBadgeClick} />
                ))}
              </Group>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                No base models use this license
              </Text>
            )}
          </Stack>
        </Card>
      ))}
      {unlicensedModels.length > 0 && (
        <Card withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Text fw={600} size="lg" c="dimmed">
                No License
              </Text>
              <Badge size="sm" variant="light">
                {unlicensedModels.length}
              </Badge>
            </Group>
            <Group gap="xs">
              {unlicensedModels.map((model) => (
                <BaseModelBadge key={model.id} baseModel={model} onClick={onBadgeClick} />
              ))}
            </Group>
          </Stack>
        </Card>
      )}
    </SimpleGrid>
  );
}

// =============================================================================
// Generation Support View
// =============================================================================

type GroupMatrixData = {
  group: BaseModelGroupRecord;
  modelTypes: string[];
  baseModelList: BaseModelRecord[];
  matrix: Record<string, Record<number, 'full' | 'partial' | null>>;
};

function GenerationSupportView({ onBadgeClick }: ViewProps) {
  const groupsWithSupport = useMemo(() => {
    const results: GroupMatrixData[] = [];

    for (const group of baseModelGroups) {
      const groupSupport = generationSupport.filter((s) => s.groupId === group.id);
      if (groupSupport.length === 0) continue;

      const modelTypes = [...new Set(groupSupport.map((s) => s.modelType))].sort();
      const baseModelIds = [...new Set(groupSupport.map((s) => s.baseModelId))];
      const baseModelList = baseModelIds
        .map((id) => baseModelById.get(id))
        .filter((m): m is BaseModelRecord => m !== undefined);

      const matrix: Record<string, Record<number, 'full' | 'partial' | null>> = {};
      for (const mt of modelTypes) {
        matrix[mt] = {};
        for (const bm of baseModelList) {
          const support = groupSupport.find((s) => s.modelType === mt && s.baseModelId === bm.id);
          matrix[mt][bm.id] = support?.support ?? null;
        }
      }

      results.push({ group, modelTypes, baseModelList, matrix });
    }

    return results;
  }, []);

  return (
    <Stack gap="lg">
      {/* Legend */}
      <Group gap="md">
        <Group gap="xs">
          <ThemeIcon color="green" size="sm" variant="light">
            <IconCheck size={14} />
          </ThemeIcon>
          <Text size="xs">Full Support</Text>
        </Group>
        <Group gap="xs">
          <ThemeIcon color="yellow" size="sm" variant="light">
            <IconCheck size={14} />
          </ThemeIcon>
          <Text size="xs">Partial Support</Text>
        </Group>
        <Group gap="xs">
          <ThemeIcon color="gray" size="sm" variant="light">
            <IconX size={14} />
          </ThemeIcon>
          <Text size="xs">Not Supported</Text>
        </Group>
      </Group>

      {/* Group Cards */}
      <Stack gap="md">
        {groupsWithSupport.map(({ group, modelTypes, baseModelList, matrix }) => (
          <Card key={group.id} withBorder shadow="sm" padding="md">
            <Stack gap="sm">
              <Group gap="xs" justify="space-between">
                <Text fw={600} size="lg">
                  {group.name}
                </Text>
                <Badge size="sm" variant="light">
                  {baseModelList.length} models
                </Badge>
              </Group>
              {group.description && (
                <Text size="sm" c="dimmed">
                  {group.description}
                </Text>
              )}
              <ScrollArea>
                <Table withTableBorder withColumnBorders>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Model Type</Table.Th>
                      {baseModelList.map((bm) => (
                        <Table.Th key={bm.id} style={{ textAlign: 'center' }}>
                          <BaseModelBadge baseModel={bm} onClick={onBadgeClick} size="sm" />
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {modelTypes.map((mt) => (
                      <Table.Tr key={mt}>
                        <Table.Td fw={500}>{mt}</Table.Td>
                        {baseModelList.map((bm) => {
                          const support = matrix[mt][bm.id];
                          return (
                            <Table.Td key={bm.id} style={{ textAlign: 'center' }}>
                              {support === 'full' ? (
                                <ThemeIcon color="green" size="sm" variant="light">
                                  <IconCheck size={14} />
                                </ThemeIcon>
                              ) : support === 'partial' ? (
                                <ThemeIcon color="yellow" size="sm" variant="light">
                                  <IconCheck size={14} />
                                </ThemeIcon>
                              ) : (
                                <ThemeIcon color="gray" size="sm" variant="light">
                                  <IconX size={14} />
                                </ThemeIcon>
                              )}
                            </Table.Td>
                          );
                        })}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Stack>
  );
}

export default Page(BaseModelsPage);
