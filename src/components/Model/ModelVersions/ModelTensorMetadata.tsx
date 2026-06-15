import {
  Accordion,
  Alert,
  Badge,
  Box,
  Collapse,
  Group,
  ScrollArea,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconChevronDown,
  IconChevronRight,
  IconCpu,
  IconDatabase,
  IconTable,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import type { ModelById } from '~/types/router';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import {
  buildTensorDisplayRows,
  inferTensorMetadataFormat,
  supportsTensorVramEstimate,
  type ModelTensorAnalysis,
  type ModelTensorDisplayGroup,
  type ModelTensorDisplayRow,
  type ModelTensorInfo,
} from '~/utils/model-tensor-metadata';

type FileType = ModelById['modelVersions'][number]['files'][number];

type Props = {
  files: FileType[];
  modelType: ModelById['type'];
  userPreferences?: UserFilePreferences;
  enabled: boolean;
};

export function ModelTensorMetadata({ files, modelType, userPreferences, enabled }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);

  const supportedFiles = useMemo(
    () => files.filter((file) => inferTensorMetadataFormat(file)),
    [files]
  );
  const defaultFile = useMemo(
    () => getPrimaryFile(supportedFiles, { metadata: userPreferences }) ?? supportedFiles[0],
    [supportedFiles, userPreferences]
  );

  useEffect(() => {
    if (!defaultFile) return;
    if (!selectedFileId || !supportedFiles.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(defaultFile.id);
    }
  }, [defaultFile, selectedFileId, supportedFiles]);

  const selectedFile =
    supportedFiles.find((file) => file.id === selectedFileId) ?? defaultFile ?? null;
  const canEstimateVram = supportsTensorVramEstimate({
    modelType,
    fileType: selectedFile?.type,
  });

  const { data, error, isFetching, isLoading } = useQuery({
    queryKey: ['model-file-tensor-metadata', selectedFile?.id],
    queryFn: () => fetchTensorMetadata(selectedFile!.id),
    enabled: enabled && !!selectedFile,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (!supportedFiles.length) return null;

  return (
    <Accordion.Item value="tensor-metadata">
      <Accordion.Control>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <IconTable size={18} style={{ color: theme.colors.dark[2] }} />
            <Text fw={500}>Tensors</Text>
          </Group>
          <Group gap={6} wrap="nowrap">
            {data ? (
              <>
                <Badge size="sm" variant="light" color="gray">
                  {numberWithCommas(data.tensorCount)}
                </Badge>
                {data.vramEstimate && (
                  <Badge size="sm" variant="light" color="blue">
                    {formatBytes(data.vramEstimate.estimatedMinimumVramBytes, 1)} est. min VRAM
                  </Badge>
                )}
              </>
            ) : isFetching ? (
              <Skeleton width={88} height={18} radius="xl" />
            ) : null}
          </Group>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack
          gap={0}
          style={{
            backgroundColor: colorScheme === 'dark' ? '#1f2023' : theme.colors.gray[0],
          }}
        >
          {supportedFiles.length > 1 && (
            <Box
              p="sm"
              style={{
                borderBottom: `1px solid ${
                  colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                }`,
              }}
            >
              <Select
                size="xs"
                label="File"
                value={selectedFile?.id.toString() ?? null}
                data={supportedFiles.map((file) => ({
                  value: file.id.toString(),
                  label: file.name,
                }))}
                onChange={(value) => setSelectedFileId(value ? Number(value) : null)}
                searchable
                allowDeselect={false}
              />
            </Box>
          )}

          {isLoading || (isFetching && !data) ? (
            <Stack p="sm" gap="xs">
              <Skeleton height={canEstimateVram ? 54 : 44} />
              <Skeleton height={260} />
            </Stack>
          ) : error ? (
            <Alert color="yellow" variant="light" m="sm">
              {(error as Error).message}
            </Alert>
          ) : data ? (
            <TensorMetadataContent data={data} />
          ) : null}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function TensorMetadataContent({ data }: { data: ModelTensorAnalysis }) {
  const rows = useMemo(() => buildTensorDisplayRows(data.tensors), [data.tensors]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const recommendedVramBytes =
    typeof data.vramEstimate?.recommendedVramBytes === 'number'
      ? data.vramEstimate.recommendedVramBytes
      : null;
  const summaryColumns = data.vramEstimate ? (recommendedVramBytes != null ? 4 : 3) : 2;

  useEffect(() => {
    setExpandedGroups(
      Object.fromEntries(
        rows
          .filter((row) => row.type === 'group' && row.group.displayCount <= 3)
          .map((row) => [(row as { type: 'group'; group: ModelTensorDisplayGroup }).group.id, true])
      )
    );
  }, [rows]);

  return (
    <Stack gap={0}>
      <SimpleGrid
        cols={{ base: 2, sm: summaryColumns }}
        spacing={0}
        style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <SummaryItem
          icon={<IconDatabase size={16} />}
          label="Weights"
          value={formatBytes(data.totalTensorBytes, 1)}
        />
        <SummaryItem label="Tensors" value={numberWithCommas(data.tensorCount)} />
        {data.vramEstimate && (
          <SummaryItem
            icon={<IconCpu size={16} />}
            label="Est. min VRAM"
            value={formatBytes(data.vramEstimate.estimatedMinimumVramBytes, 1)}
            tooltip="Estimated checkpoint weight residency plus Comfy reserve. Actual inference memory depends on workflow settings."
          />
        )}
        {data.vramEstimate && recommendedVramBytes != null && (
          <SummaryItem
            icon={<IconCpu size={16} />}
            label="Recommended VRAM"
            value={formatBytes(recommendedVramBytes, 1)}
            tooltip="Estimated VRAM to keep checkpoint weights resident without dynamic offload, plus Comfy reserve."
          />
        )}
      </SimpleGrid>

      <ScrollArea.Autosize mah={380} type="auto">
        <Table
          striped
          highlightOnHover
          verticalSpacing={4}
          horizontalSpacing="sm"
          style={{ minWidth: 560, tableLayout: 'fixed' }}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: '58%' }}>Tensors</Table.Th>
              <Table.Th style={{ width: '27%' }}>Shape</Table.Th>
              <Table.Th style={{ width: '15%' }}>Precision</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => {
              if (row.type === 'tensor')
                return <TensorRow key={row.tensor.name} tensor={row.tensor} />;

              const expanded = !!expandedGroups[row.group.id];
              return (
                <GroupRows
                  key={row.group.id}
                  row={row}
                  expanded={expanded}
                  onToggle={() =>
                    setExpandedGroups((current) => ({
                      ...current,
                      [row.group.id]: !current[row.group.id],
                    }))
                  }
                />
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
    </Stack>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  tooltip,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <Box p="sm">
      <Group gap={6} wrap="nowrap">
        {icon}
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
      <Tooltip label={tooltip} disabled={!tooltip} withArrow>
        <Text size="sm" fw={600} truncate>
          {value}
        </Text>
      </Tooltip>
    </Box>
  );
}

function GroupRows({
  row,
  expanded,
  onToggle,
}: {
  row: Extract<ModelTensorDisplayRow, { type: 'group' }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <Table.Tr>
        <Table.Td colSpan={3}>
          <UnstyledButton onClick={onToggle} style={{ width: '100%' }}>
            <Group gap={4} wrap="nowrap">
              {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm" truncate>
                {row.group.name} ({numberWithCommas(row.group.displayCount)})
              </Text>
            </Group>
          </UnstyledButton>
        </Table.Td>
      </Table.Tr>
      <Table.Tr style={{ display: expanded ? 'table-row' : 'none' }}>
        <Table.Td colSpan={3} p={0}>
          <Collapse in={expanded}>
            <Table
              verticalSpacing={4}
              horizontalSpacing="sm"
              style={{ minWidth: 560, tableLayout: 'fixed' }}
            >
              <Table.Tbody>
                {row.group.tensors.map((tensor) => (
                  <TensorRow key={tensor.name} tensor={tensor} nested />
                ))}
              </Table.Tbody>
            </Table>
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

function TensorRow({ tensor, nested = false }: { tensor: ModelTensorInfo; nested?: boolean }) {
  return (
    <Table.Tr>
      <Table.Td style={{ width: '58%', maxWidth: 0 }}>
        <Text size="sm" pl={nested ? 'md' : 0} truncate title={tensor.name}>
          {tensor.name}
        </Text>
      </Table.Td>
      <Table.Td style={{ width: '27%', maxWidth: 0 }}>
        <Text size="xs" c="dimmed" truncate title={formatShape(tensor.shape)}>
          {formatShape(tensor.shape)}
        </Text>
      </Table.Td>
      <Table.Td style={{ width: '15%' }}>
        <Text size="xs" c="dimmed" truncate>
          {tensor.dtype}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

function formatShape(shape: number[]) {
  return `[${shape.map((dimension) => numberWithCommas(dimension)).join(', ')}]`;
}

async function fetchTensorMetadata(fileId: number) {
  const response = await fetch(`/api/v1/model-files/${fileId}/tensor-metadata`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Failed to load tensor metadata');
  }

  return (await response.json()) as ModelTensorAnalysis;
}
