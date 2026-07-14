import {
  Accordion,
  Alert,
  Badge,
  Group,
  HoverCard,
  Skeleton,
  Stack,
  Text,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import type { ModelById } from '~/types/router';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import {
  buildTensorDisplayRows,
  inferTensorMetadataFormat,
  type ModelTensorAnalysis,
  type ModelTensorDisplayGroup,
  type ModelTensorInfo,
} from '~/utils/model-tensor-metadata';

type FileType = ModelById['modelVersions'][number]['files'][number];
type TensorSummary = Omit<ModelTensorAnalysis, 'tensors'>;

type Props = {
  files: FileType[];
  userPreferences?: UserFilePreferences;
  /** Whether the accordion is currently open (drives the full tensor-list fetch). */
  enabled: boolean;
  /** Active file id shared with the download variant picker (the panel follows it). */
  selectedFileId?: number | null;
};

const MIN_VRAM_INFO =
  'Rough lower bound to run this model, estimated from its tensor sizes and precision plus typical runtime overhead. At this level weights are streamed onto the GPU as needed, so it runs but more slowly. Actual usage varies by the tool and settings you use.';
const RECOMMENDED_VRAM_INFO =
  'Rough target for smooth performance, estimated from its tensor sizes and precision plus typical runtime overhead. At this level the full set of weights can stay resident on the GPU at once. Actual usage varies by the tool and settings you use.';
const TENSOR_METADATA_RESPONSE_VERSION = 2;

export function ModelTensorMetadata({ files, userPreferences, enabled, selectedFileId }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const supportedFiles = useMemo(
    () => files.filter((file) => inferTensorMetadataFormat(file)),
    [files]
  );
  const defaultFile = useMemo(
    () => getPrimaryFile(supportedFiles, { metadata: userPreferences }) ?? supportedFiles[0],
    [supportedFiles, userPreferences]
  );

  // Follow the shared download selection when it points at a tensor-parseable
  // file; otherwise fall back to this version's primary/default file.
  const selectedFile =
    supportedFiles.find((file) => file.id === selectedFileId) ?? defaultFile ?? null;

  // Summary is always fetched (cheap, server-cached) so the closed header can
  // show the VRAM range at a glance. The full tensor list is only fetched once
  // the accordion is opened.
  const summaryQuery = useQuery({
    queryKey: ['model-file-tensor-metadata', selectedFile?.id, 'summary'],
    queryFn: () => fetchTensorSummary(selectedFile!.id),
    enabled: !!selectedFile,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  const detailQuery = useQuery({
    queryKey: ['model-file-tensor-metadata', selectedFile?.id, 'full'],
    queryFn: () => fetchTensorMetadata(selectedFile!.id),
    enabled: enabled && !!selectedFile,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

  if (!supportedFiles.length) return null;

  const vramEstimate = summaryQuery.data?.vramEstimate ?? null;
  const tensorCount = summaryQuery.data?.tensorCount ?? null;
  const weightPrecision =
    summaryQuery.data?.weightPrecision ?? selectedFile?.metadata?.weightPrecision;

  return (
    <Accordion.Item value="tensor-metadata">
      <Accordion.Control>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap={6} wrap="nowrap">
            Tensors
            {tensorCount != null && (
              <Badge size="sm" variant="light" color="gray">
                {numberWithCommas(tensorCount)}
              </Badge>
            )}
          </Group>
          <Group gap={6} wrap="nowrap">
            {weightPrecision && (
              <Badge size="sm" variant="light" color="gray" title="Weight precision">
                {weightPrecision}
              </Badge>
            )}
            {vramEstimate ? (
              <VramSegmentedBadge vramEstimate={vramEstimate} />
            ) : summaryQuery.isFetching ? (
              <Skeleton width={150} height={20} radius="sm" />
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
          {detailQuery.isLoading || (detailQuery.isFetching && !detailQuery.data) ? (
            <Stack gap={0}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID_COLUMNS,
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Skeleton height={10} width={56} />
                <Skeleton height={10} width={44} />
                <Skeleton height={10} width={56} />
              </div>
              {Array.from({ length: 3 }).map((_, index) => (
                <div
                  key={index}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID_COLUMNS,
                    alignItems: 'center',
                    height: ROW_HEIGHT,
                    padding: '0 12px',
                  }}
                >
                  <Skeleton height={12} width="85%" />
                  <Skeleton height={12} width="60%" />
                  <Skeleton height={12} width="50%" />
                </div>
              ))}
            </Stack>
          ) : detailQuery.error ? (
            <Alert color="yellow" variant="light" m="sm">
              {(detailQuery.error as Error).message}
            </Alert>
          ) : detailQuery.data ? (
            <TensorTable data={detailQuery.data} />
          ) : null}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function VramSegmentedBadge({
  vramEstimate,
}: {
  vramEstimate: NonNullable<TensorSummary['vramEstimate']>;
}) {
  const hasRecommended = typeof vramEstimate.recommendedVramBytes === 'number';
  const dividerColor = 'color-mix(in srgb, var(--mantine-color-blue-light-color) 25%, transparent)';

  return (
    <Group
      gap={0}
      wrap="nowrap"
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'var(--mantine-color-blue-light)',
        color: 'var(--mantine-color-blue-light-color)',
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ padding: '3px 8px', fontWeight: 700 }}>VRAM</span>
      <VramSegment
        label="min"
        bytes={vramEstimate.estimatedMinimumVramBytes}
        info={MIN_VRAM_INFO}
        style={{ borderLeft: `1px solid ${dividerColor}` }}
      />
      {hasRecommended && (
        <VramSegment
          label="rec"
          bytes={vramEstimate.recommendedVramBytes}
          info={RECOMMENDED_VRAM_INFO}
          style={{ borderLeft: `1px solid ${dividerColor}` }}
        />
      )}
    </Group>
  );
}

function VramSegment({
  label,
  bytes,
  info,
  style,
}: {
  label: string;
  bytes: number;
  info: string;
  style?: React.CSSProperties;
}) {
  return (
    <HoverCard width={260} shadow="md" withArrow position="bottom-end" openDelay={100} withinPortal>
      <HoverCard.Target>
        <span style={{ padding: '3px 8px', cursor: 'help', ...style }}>
          <span style={{ opacity: 0.75 }}>{label}</span> {formatBytes(bytes, 1)}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="xs" c="dimmed">
          {info}
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

type VisibleRow =
  | { kind: 'group'; group: ModelTensorDisplayGroup; expanded: boolean }
  | { kind: 'tensor'; tensor: ModelTensorInfo; nested: boolean };

const ROW_HEIGHT = 32;
const GRID_COLUMNS = '58% 27% 15%';
const MIN_TABLE_WIDTH = 520;

function TensorTable({ data }: { data: ModelTensorAnalysis }) {
  const displayRows = useMemo(() => buildTensorDisplayRows(data.tensors), [data.tensors]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Default every group collapsed; reset when the selected file changes so a
  // prior file's expanded groups don't linger.
  useEffect(() => {
    setExpandedGroups({});
  }, [displayRows]);

  // Flatten groups + expanded children into a single linear list so the whole
  // thing can be virtualized. Only the rows in view get rendered, which keeps
  // big groups (e.g. a 1.6k-tensor "model" group) instant to expand.
  const visibleRows = useMemo<VisibleRow[]>(() => {
    const out: VisibleRow[] = [];
    for (const row of displayRows) {
      if (row.type === 'tensor') {
        out.push({ kind: 'tensor', tensor: row.tensor, nested: false });
        continue;
      }
      const expanded = !!expandedGroups[row.group.id];
      out.push({ kind: 'group', group: row.group, expanded });
      if (expanded)
        for (const tensor of row.group.tensors) out.push({ kind: 'tensor', tensor, nested: true });
    }
    return out;
  }, [displayRows, expandedGroups]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const toggleGroup = (id: string) =>
    setExpandedGroups((current) => ({ ...current, [id]: !current[id] }));

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: MIN_TABLE_WIDTH }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID_COLUMNS,
            padding: '6px 12px',
            fontSize: 'var(--mantine-font-size-xs)',
            fontWeight: 600,
            borderBottom: '1px solid var(--mantine-color-default-border)',
          }}
        >
          <span>Tensors</span>
          <span>Shape</span>
          <span>Precision</span>
        </div>
        <div
          ref={scrollRef}
          style={{ maxHeight: 360, overflowY: 'auto', scrollbarGutter: 'stable' }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = visibleRows[item.index];
              return (
                <div
                  key={String(item.key)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                    display: 'grid',
                    gridTemplateColumns: GRID_COLUMNS,
                    alignItems: 'center',
                    padding: '0 12px',
                    background:
                      item.index % 2
                        ? 'color-mix(in srgb, var(--mantine-color-text) 4%, transparent)'
                        : 'transparent',
                  }}
                >
                  {row.kind === 'group' ? (
                    <UnstyledButton
                      onClick={() => toggleGroup(row.group.id)}
                      style={{ gridColumn: '1 / -1', height: '100%' }}
                    >
                      <Group gap={6} wrap="nowrap" h="100%" w="100%">
                        {row.expanded ? (
                          <IconChevronDown size={14} style={{ flexShrink: 0 }} />
                        ) : (
                          <IconChevronRight size={14} style={{ flexShrink: 0 }} />
                        )}
                        <Text size="sm" truncate style={{ minWidth: 0, flexShrink: 1 }}>
                          {row.group.name}
                        </Text>
                        <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                          {numberWithCommas(row.group.displayCount)}
                        </Badge>
                      </Group>
                    </UnstyledButton>
                  ) : (
                    <>
                      <Text
                        size="sm"
                        pl={row.nested ? 'md' : 0}
                        truncate
                        title={row.tensor.name}
                        style={{ minWidth: 0 }}
                      >
                        {row.tensor.name}
                      </Text>
                      <Text
                        size="xs"
                        c="dimmed"
                        truncate
                        title={formatShape(row.tensor.shape)}
                        style={{ minWidth: 0 }}
                      >
                        {formatShape(row.tensor.shape)}
                      </Text>
                      <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }}>
                        {row.tensor.dtype}
                      </Text>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatShape(shape: number[]) {
  return `[${shape.map((dimension) => numberWithCommas(dimension)).join(', ')}]`;
}

async function fetchTensorSummary(fileId: number) {
  const response = await fetch(
    `/api/v1/model-files/${fileId}/tensor-metadata?summaryOnly=true&v=${TENSOR_METADATA_RESPONSE_VERSION}`
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Failed to load tensor metadata');
  }

  return (await response.json()) as TensorSummary;
}

async function fetchTensorMetadata(fileId: number) {
  const response = await fetch(
    `/api/v1/model-files/${fileId}/tensor-metadata?v=${TENSOR_METADATA_RESPONSE_VERSION}`
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Failed to load tensor metadata');
  }

  return (await response.json()) as ModelTensorAnalysis;
}
