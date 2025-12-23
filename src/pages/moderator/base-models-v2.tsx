import {
  Badge,
  Box,
  Card,
  Container,
  Drawer,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconCheck,
  IconChevronRight,
  IconEyeOff,
  IconGavel,
  IconPhoto,
  IconSchool,
  IconSparkles,
  IconVideo,
  IconX,
  IconArrowRight,
  IconBan,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import {
  ecosystems,
  ecosystemById,
  baseModels,
  baseModelFamilies,
  ecosystemSupport,
  ecosystemSettings,
  familyById,
  licenseById,
  getEcosystemSupport,
  getEcosystemFamily,
  isModelSupported,
  type EcosystemRecord,
  type BaseModelRecord,
  type SupportType,
} from '~/shared/constants/basemodelv2.constants';

type ViewType = 'tree' | 'family' | 'ecosystem' | 'list';

function BaseModelsV2Page() {
  const [activeTab, setActiveTab] = useState<ViewType>('tree');
  const [selectedEcosystem, setSelectedEcosystem] = useState<EcosystemRecord | null>(null);
  const [selectedBaseModel, setSelectedBaseModel] = useState<BaseModelRecord | null>(null);
  const [ecosystemDrawerOpened, { open: openEcosystemDrawer, close: closeEcosystemDrawer }] =
    useDisclosure(false);
  const [baseModelDrawerOpened, { open: openBaseModelDrawer, close: closeBaseModelDrawer }] =
    useDisclosure(false);

  const handleEcosystemClick = (ecosystem: EcosystemRecord) => {
    setSelectedEcosystem(ecosystem);
    openEcosystemDrawer();
  };

  const handleBaseModelClick = (baseModel: BaseModelRecord) => {
    setSelectedBaseModel(baseModel);
    openBaseModelDrawer();
  };

  return (
    <>
      <Meta title="Base Models V2 - Moderator" deIndex />
      <Container size="xl">
        <Stack gap="lg">
          <Stack gap={0}>
            <Title order={1}>Base Models V2</Title>
            <Text size="sm" c="dimmed">
              Ecosystem-based schema with hierarchical relationships.
            </Text>
          </Stack>

          <Tabs value={activeTab} onChange={(v) => setActiveTab(v as ViewType)}>
            <Tabs.List>
              <Tabs.Tab value="tree">Ecosystem Tree</Tabs.Tab>
              <Tabs.Tab value="family">By Family</Tabs.Tab>
              <Tabs.Tab value="ecosystem">Ecosystems</Tabs.Tab>
              <Tabs.Tab value="list">Base Models</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="tree" pt="md">
              <EcosystemTreeView
                onEcosystemClick={handleEcosystemClick}
                onBaseModelClick={handleBaseModelClick}
              />
            </Tabs.Panel>

            <Tabs.Panel value="family" pt="md">
              <FamilyView
                onEcosystemClick={handleEcosystemClick}
                onBaseModelClick={handleBaseModelClick}
              />
            </Tabs.Panel>

            <Tabs.Panel value="ecosystem" pt="md">
              <EcosystemGridView
                onEcosystemClick={handleEcosystemClick}
                onBaseModelClick={handleBaseModelClick}
              />
            </Tabs.Panel>

            <Tabs.Panel value="list" pt="md">
              <BaseModelListView onBaseModelClick={handleBaseModelClick} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>

      <EcosystemDrawer
        ecosystem={selectedEcosystem}
        opened={ecosystemDrawerOpened}
        onClose={closeEcosystemDrawer}
        onBaseModelClick={handleBaseModelClick}
      />
      <BaseModelDrawer
        baseModel={selectedBaseModel}
        opened={baseModelDrawerOpened}
        onClose={closeBaseModelDrawer}
      />
    </>
  );
}

// =============================================================================
// Ecosystem Tree View - Shows Parent/Child Hierarchy
// =============================================================================

type TreeViewProps = {
  onEcosystemClick: (ecosystem: EcosystemRecord) => void;
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function EcosystemTreeView({ onEcosystemClick, onBaseModelClick }: TreeViewProps) {
  const treeData = useMemo(() => {
    // Get root ecosystems (no parent)
    const roots = ecosystems.filter((e) => !e.parentEcosystemId).sort((a, b) => {
      const aSort = a.sortOrder ?? 999;
      const bSort = b.sortOrder ?? 999;
      return aSort - bSort;
    });

    // Build tree structure
    const buildTree = (parent: EcosystemRecord): TreeNode => {
      const children = ecosystems
        .filter((e) => e.parentEcosystemId === parent.id)
        .sort((a, b) => {
          const aSort = a.sortOrder ?? 999;
          const bSort = b.sortOrder ?? 999;
          return aSort - bSort;
        })
        .map(buildTree);

      const models = baseModels.filter((m) => m.ecosystemId === parent.id);

      return {
        ecosystem: parent,
        children,
        baseModels: models,
      };
    };

    return roots.map(buildTree);
  }, []);

  return (
    <Stack gap="md">
      <Group gap="md">
        <Group gap="xs">
          <ThemeIcon color="blue" size="sm" variant="light">
            <IconChevronRight size={14} />
          </ThemeIcon>
          <Text size="xs">Root Ecosystem</Text>
        </Group>
        <Group gap="xs">
          <ThemeIcon color="grape" size="sm" variant="light">
            <IconArrowRight size={14} />
          </ThemeIcon>
          <Text size="xs">Child Ecosystem (inherits from parent)</Text>
        </Group>
      </Group>

      <Stack gap="xs">
        {treeData.map((node) => (
          <TreeNodeCard
            key={node.ecosystem.id}
            node={node}
            depth={0}
            onEcosystemClick={onEcosystemClick}
            onBaseModelClick={onBaseModelClick}
          />
        ))}
      </Stack>
    </Stack>
  );
}

type TreeNode = {
  ecosystem: EcosystemRecord;
  children: TreeNode[];
  baseModels: BaseModelRecord[];
};

type TreeNodeCardProps = {
  node: TreeNode;
  depth: number;
  onEcosystemClick: (ecosystem: EcosystemRecord) => void;
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function TreeNodeCard({ node, depth, onEcosystemClick, onBaseModelClick }: TreeNodeCardProps) {
  const { ecosystem, children, baseModels: models } = node;
  const hasChildren = children.length > 0;
  const family = ecosystem.familyId ? familyById.get(ecosystem.familyId) : undefined;

  // Get support info
  const genSupport = getEcosystemSupport(ecosystem.id, 'generation');
  const trainSupport = getEcosystemSupport(ecosystem.id, 'training');
  const auctionSupport = getEcosystemSupport(ecosystem.id, 'auction');

  return (
    <Box style={{ marginLeft: depth * 24 }}>
      <Card
        withBorder
        shadow="sm"
        padding="sm"
        style={{ cursor: 'pointer' }}
        onClick={() => onEcosystemClick(ecosystem)}
      >
        <Stack gap="xs">
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              {depth > 0 && (
                <ThemeIcon color="grape" size="sm" variant="light">
                  <IconArrowRight size={14} />
                </ThemeIcon>
              )}
              <Text fw={600} size="md">
                {ecosystem.displayName}
              </Text>
              <Text size="xs" c="dimmed">
                ({ecosystem.name})
              </Text>
            </Group>
            <Group gap={4}>
              {family && (
                <Badge size="xs" variant="light" color="gray">
                  {family.name}
                </Badge>
              )}
              {models.length > 0 && (
                <Badge size="xs" variant="light">
                  {models.length} model{models.length !== 1 ? 's' : ''}
                </Badge>
              )}
              {hasChildren && (
                <Badge size="xs" variant="light" color="grape">
                  {children.length} child{children.length !== 1 ? 'ren' : ''}
                </Badge>
              )}
            </Group>
          </Group>

          {/* Support badges */}
          <Group gap={4}>
            <SupportBadge label="Generation" support={genSupport} />
            <SupportBadge label="Training" support={trainSupport} />
            <SupportBadge label="Auction" support={auctionSupport} />
          </Group>

          {/* Base models */}
          {models.length > 0 && (
            <Group gap={4}>
              {models.slice(0, 5).map((model) => (
                <BaseModelBadge
                  key={model.id}
                  baseModel={model}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBaseModelClick(model);
                  }}
                  size="xs"
                />
              ))}
              {models.length > 5 && (
                <Badge size="xs" variant="light" color="gray">
                  +{models.length - 5} more
                </Badge>
              )}
            </Group>
          )}
        </Stack>
      </Card>

      {/* Children */}
      {children.map((child) => (
        <TreeNodeCard
          key={child.ecosystem.id}
          node={child}
          depth={depth + 1}
          onEcosystemClick={onEcosystemClick}
          onBaseModelClick={onBaseModelClick}
        />
      ))}
    </Box>
  );
}

// =============================================================================
// Support Badge
// =============================================================================

type SupportBadgeProps = {
  label: string;
  support?: { disabled?: boolean; modelTypes: unknown[] };
};

function SupportBadge({ label, support }: SupportBadgeProps) {
  if (!support) {
    return (
      <Tooltip label={`${label}: Not defined (inherited or none)`}>
        <Badge size="xs" color="gray" variant="outline">
          {label}
        </Badge>
      </Tooltip>
    );
  }

  if (support.disabled) {
    return (
      <Tooltip label={`${label}: Disabled`}>
        <Badge size="xs" color="red" variant="outline">
          {label}
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={`${label}: ${support.modelTypes.length} types supported`}>
      <Badge size="xs" color="green" variant="light">
        {label}
      </Badge>
    </Tooltip>
  );
}

// =============================================================================
// Family View
// =============================================================================

type FamilyViewProps = {
  onEcosystemClick: (ecosystem: EcosystemRecord) => void;
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function FamilyView({ onEcosystemClick, onBaseModelClick }: FamilyViewProps) {
  const familiesWithEcosystems = useMemo(() => {
    return baseModelFamilies.map((family) => ({
      ...family,
      ecosystems: ecosystems
        .filter((e) => e.familyId === family.id)
        .sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999)),
    }));
  }, []);

  const orphanEcosystems = useMemo(() => {
    return ecosystems.filter((e) => !e.familyId).sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  }, []);

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {familiesWithEcosystems.map((family) => (
        <Card key={family.id} withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Text fw={600} size="lg">
                {family.name}
              </Text>
              <Badge size="sm" variant="light">
                {family.ecosystems.length} ecosystems
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {family.description}
            </Text>
            <Stack gap={4}>
              {family.ecosystems.map((eco) => {
                const models = baseModels.filter((m) => m.ecosystemId === eco.id);
                const parent = eco.parentEcosystemId
                  ? ecosystemById.get(eco.parentEcosystemId)
                  : undefined;

                return (
                  <Group key={eco.id} gap="xs" wrap="nowrap">
                    {parent && (
                      <Text size="xs" c="dimmed">
                        └
                      </Text>
                    )}
                    <Badge
                      component="button"
                      onClick={() => onEcosystemClick(eco)}
                      color={parent ? 'grape' : 'blue'}
                      variant="light"
                      size="sm"
                      style={{ cursor: 'pointer' }}
                    >
                      {eco.displayName}
                    </Badge>
                    {parent && (
                      <Text size="xs" c="dimmed">
                        → {parent.displayName}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed">
                      ({models.length})
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          </Stack>
        </Card>
      ))}

      {orphanEcosystems.length > 0 && (
        <Card withBorder shadow="sm" padding="md">
          <Stack gap="xs">
            <Group gap="xs" justify="space-between">
              <Text fw={600} size="lg" c="dimmed">
                Standalone
              </Text>
              <Badge size="sm" variant="light">
                {orphanEcosystems.length} ecosystems
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Ecosystems without a family assignment
            </Text>
            <Stack gap={4}>
              {orphanEcosystems.map((eco) => {
                const models = baseModels.filter((m) => m.ecosystemId === eco.id);
                return (
                  <Group key={eco.id} gap="xs" wrap="nowrap">
                    <Badge
                      component="button"
                      onClick={() => onEcosystemClick(eco)}
                      color="gray"
                      variant="light"
                      size="sm"
                      style={{ cursor: 'pointer' }}
                    >
                      {eco.displayName}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      ({models.length})
                    </Text>
                  </Group>
                );
              })}
            </Stack>
          </Stack>
        </Card>
      )}
    </SimpleGrid>
  );
}

// =============================================================================
// Ecosystem Grid View
// =============================================================================

type EcosystemGridViewProps = {
  onEcosystemClick: (ecosystem: EcosystemRecord) => void;
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function EcosystemGridView({ onEcosystemClick, onBaseModelClick }: EcosystemGridViewProps) {
  const sortedEcosystems = useMemo(() => {
    return [...ecosystems].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
  }, []);

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {sortedEcosystems.map((eco) => {
        const models = baseModels.filter((m) => m.ecosystemId === eco.id);
        const parent = eco.parentEcosystemId
          ? ecosystemById.get(eco.parentEcosystemId)
          : undefined;
        const family = eco.familyId ? familyById.get(eco.familyId) : undefined;
        const children = ecosystems.filter((e) => e.parentEcosystemId === eco.id);

        const genSupport = getEcosystemSupport(eco.id, 'generation');
        const trainSupport = getEcosystemSupport(eco.id, 'training');

        return (
          <Card
            key={eco.id}
            withBorder
            shadow="sm"
            padding="md"
            style={{ cursor: 'pointer' }}
            onClick={() => onEcosystemClick(eco)}
          >
            <Stack gap="xs">
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Text fw={600} size="lg">
                    {eco.displayName}
                  </Text>
                </Group>
                <Badge size="sm" variant="light">
                  ID: {eco.id}
                </Badge>
              </Group>

              <Group gap={4}>
                {family && (
                  <Badge size="xs" variant="light" color="gray">
                    {family.name}
                  </Badge>
                )}
                {parent && (
                  <Badge size="xs" variant="light" color="grape">
                    → {parent.displayName}
                  </Badge>
                )}
                {children.length > 0 && (
                  <Badge size="xs" variant="light" color="teal">
                    {children.length} child{children.length !== 1 ? 'ren' : ''}
                  </Badge>
                )}
              </Group>

              <Group gap={4}>
                <Text size="xs" c="dimmed">
                  Key: <code>{eco.key}</code>
                </Text>
                <Text size="xs" c="dimmed">
                  Name: <code>{eco.name}</code>
                </Text>
              </Group>

              <Group gap={4}>
                <SupportBadge label="Gen" support={genSupport} />
                <SupportBadge label="Train" support={trainSupport} />
              </Group>

              {models.length > 0 && (
                <Group gap={4}>
                  {models.slice(0, 4).map((model) => (
                    <BaseModelBadge
                      key={model.id}
                      baseModel={model}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBaseModelClick(model);
                      }}
                      size="xs"
                    />
                  ))}
                  {models.length > 4 && (
                    <Badge size="xs" variant="light" color="gray">
                      +{models.length - 4} more
                    </Badge>
                  )}
                </Group>
              )}
            </Stack>
          </Card>
        );
      })}
    </SimpleGrid>
  );
}

// =============================================================================
// Base Model List View
// =============================================================================

type BaseModelListViewProps = {
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function BaseModelListView({ onBaseModelClick }: BaseModelListViewProps) {
  return (
    <ScrollArea>
      <Table striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>ID</Table.Th>
            <Table.Th>Name</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Ecosystem</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Generation</Table.Th>
            <Table.Th>Training</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {baseModels.map((model) => {
            const eco = ecosystemById.get(model.ecosystemId);
            const canGenerate = isModelSupported(model.id, 'generation');
            const canTrain = isModelSupported(model.id, 'training');

            return (
              <Table.Tr
                key={model.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onBaseModelClick(model)}
              >
                <Table.Td>{model.id}</Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    {model.type === 'video' ? <IconVideo size={14} /> : <IconPhoto size={14} />}
                    {model.name}
                  </Group>
                </Table.Td>
                <Table.Td>{model.type}</Table.Td>
                <Table.Td>
                  {eco ? (
                    <Badge size="sm" variant="light">
                      {eco.displayName}
                    </Badge>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Unknown
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {model.hidden && (
                      <Tooltip label="Hidden">
                        <ThemeIcon size="xs" color="gray" variant="light">
                          <IconEyeOff size={12} />
                        </ThemeIcon>
                      </Tooltip>
                    )}
                    {model.disabled && (
                      <Tooltip label="Disabled">
                        <ThemeIcon size="xs" color="red" variant="light">
                          <IconBan size={12} />
                        </ThemeIcon>
                      </Tooltip>
                    )}
                    {!model.hidden && !model.disabled && (
                      <ThemeIcon size="xs" color="green" variant="light">
                        <IconCheck size={12} />
                      </ThemeIcon>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <ThemeIcon
                    size="xs"
                    color={canGenerate ? 'green' : 'gray'}
                    variant="light"
                  >
                    {canGenerate ? <IconCheck size={12} /> : <IconX size={12} />}
                  </ThemeIcon>
                </Table.Td>
                <Table.Td>
                  <ThemeIcon
                    size="xs"
                    color={canTrain ? 'green' : 'gray'}
                    variant="light"
                  >
                    {canTrain ? <IconCheck size={12} /> : <IconX size={12} />}
                  </ThemeIcon>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

// =============================================================================
// Base Model Badge
// =============================================================================

type BaseModelBadgeProps = {
  baseModel: BaseModelRecord;
  onClick: (e: React.MouseEvent) => void;
  size?: 'xs' | 'sm' | 'md';
};

function BaseModelBadge({ baseModel, onClick, size = 'sm' }: BaseModelBadgeProps) {
  const color = baseModel.disabled
    ? 'red'
    : baseModel.hidden
    ? 'gray'
    : baseModel.type === 'video'
    ? 'violet'
    : 'blue';

  return (
    <Badge
      component="button"
      onClick={onClick}
      color={color}
      variant={baseModel.hidden || baseModel.disabled ? 'outline' : 'filled'}
      size={size}
      style={{ cursor: 'pointer', textTransform: 'none' }}
      leftSection={baseModel.type === 'video' ? <IconVideo size={10} /> : <IconPhoto size={10} />}
    >
      {baseModel.name}
    </Badge>
  );
}

// =============================================================================
// Ecosystem Drawer
// =============================================================================

type EcosystemDrawerProps = {
  ecosystem: EcosystemRecord | null;
  opened: boolean;
  onClose: () => void;
  onBaseModelClick: (baseModel: BaseModelRecord) => void;
};

function EcosystemDrawer({ ecosystem, opened, onClose, onBaseModelClick }: EcosystemDrawerProps) {
  if (!ecosystem) return null;

  const parent = ecosystem.parentEcosystemId
    ? ecosystemById.get(ecosystem.parentEcosystemId)
    : undefined;
  const children = ecosystems.filter((e) => e.parentEcosystemId === ecosystem.id);
  const family = ecosystem.familyId ? familyById.get(ecosystem.familyId) : undefined;
  const models = baseModels.filter((m) => m.ecosystemId === ecosystem.id);

  // Get support entries
  const support = ecosystemSupport.filter((s) => s.ecosystemId === ecosystem.id);
  const settings = ecosystemSettings.find((s) => s.ecosystemId === ecosystem.id);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={<Title order={3}>{ecosystem.displayName}</Title>}
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
                <Table.Td>{ecosystem.id}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Key</Table.Td>
                <Table.Td>
                  <code>{ecosystem.key}</code>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Name</Table.Td>
                <Table.Td>
                  <code>{ecosystem.name}</code>
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Display Name</Table.Td>
                <Table.Td>{ecosystem.displayName}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Family</Table.Td>
                <Table.Td>{family?.name ?? '—'}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Sort Order</Table.Td>
                <Table.Td>{ecosystem.sortOrder ?? '—'}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Stack>

        {/* Parent/Children */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Hierarchy
          </Text>
          {parent ? (
            <Group gap="xs">
              <Text size="sm">Parent:</Text>
              <Badge color="grape" variant="light">
                {parent.displayName}
              </Badge>
            </Group>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">
              Root ecosystem (no parent)
            </Text>
          )}
          {children.length > 0 && (
            <Group gap="xs">
              <Text size="sm">Children:</Text>
              {children.map((child) => (
                <Badge key={child.id} color="teal" variant="light">
                  {child.displayName}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>

        {/* Support */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Direct Support Configuration
          </Text>
          {support.length > 0 ? (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Enabled</Table.Th>
                  <Table.Th>Model Types</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {support.map((s, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{s.supportType}</Table.Td>
                    <Table.Td>
                      <ThemeIcon
                        size="xs"
                        color={s.disabled ? 'red' : 'green'}
                        variant="light"
                      >
                        {s.disabled ? <IconX size={12} /> : <IconCheck size={12} />}
                      </ThemeIcon>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2}>
                        {s.modelTypes.slice(0, 3).map((mt) => (
                          <Badge key={mt} size="xs" variant="outline">
                            {mt}
                          </Badge>
                        ))}
                        {s.modelTypes.length > 3 && (
                          <Badge size="xs" variant="light" color="gray">
                            +{s.modelTypes.length - 3}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">
              No direct support defined (inherits from parent)
            </Text>
          )}
        </Stack>

        {/* Settings */}
        {settings?.defaults && (
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
                {JSON.stringify(settings.defaults, null, 2)}
              </code>
            </ScrollArea.Autosize>
          </Stack>
        )}

        {/* Base Models */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Base Models ({models.length})
          </Text>
          {models.length > 0 ? (
            <Group gap="xs">
              {models.map((model) => (
                <BaseModelBadge
                  key={model.id}
                  baseModel={model}
                  onClick={() => onBaseModelClick(model)}
                  size="sm"
                />
              ))}
            </Group>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">
              No base models in this ecosystem
            </Text>
          )}
        </Stack>
      </Stack>
    </Drawer>
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

  const ecosystem = ecosystemById.get(baseModel.ecosystemId);
  const family = ecosystem ? getEcosystemFamily(ecosystem.id) : undefined;
  const license = baseModel.licenseId ? licenseById.get(baseModel.licenseId) : undefined;

  const canGenerate = isModelSupported(baseModel.id, 'generation');
  const canTrain = isModelSupported(baseModel.id, 'training');
  const canAuction = isModelSupported(baseModel.id, 'auction');

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
                <Table.Td fw={500}>Ecosystem</Table.Td>
                <Table.Td>
                  {ecosystem ? (
                    <Badge variant="light">{ecosystem.displayName}</Badge>
                  ) : (
                    '—'
                  )}
                </Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td fw={500}>Family</Table.Td>
                <Table.Td>{family?.name ?? '—'}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Stack>

        {/* Status Flags */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Status
          </Text>
          <Group gap="xs">
            <FlagBadge
              label="Hidden"
              value={baseModel.hidden}
              icon={<IconEyeOff size={14} />}
              negative
            />
            <FlagBadge
              label="Disabled"
              value={baseModel.disabled}
              icon={<IconBan size={14} />}
              negative
            />
          </Group>
        </Stack>

        {/* Support Status */}
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Support (Computed)
          </Text>
          <Group gap="xs">
            <FlagBadge
              label="Can Generate"
              value={canGenerate}
              icon={<IconSparkles size={14} />}
            />
            <FlagBadge
              label="Can Train"
              value={canTrain}
              icon={<IconSchool size={14} />}
            />
            <FlagBadge
              label="Can Auction"
              value={canAuction}
              icon={<IconGavel size={14} />}
            />
          </Group>
        </Stack>

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

export default Page(BaseModelsV2Page);
