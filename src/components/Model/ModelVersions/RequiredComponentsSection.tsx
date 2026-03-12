import {
  Accordion,
  ActionIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconPackage,
} from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile, type GroupedFileVariants } from '~/server/utils/model-helpers';
import type { ModelById } from '~/types/router';
import {
  componentTypeConfig,
  getFileDescription,
  getFileLabel,
} from '~/utils/file-display-helpers';
import { abbreviateNumber, formatKBytes } from '~/utils/number-helpers';

type FileType = ModelById['modelVersions'][number]['files'][number];

interface RequiredComponentsSectionProps {
  groupedFiles: GroupedFileVariants<FileType>;
  versionId: number;
  userPreferences?: UserFilePreferences;
  canDownload: boolean;
  downloadPrice?: number;
  isLoadingAccess?: boolean;
  archived?: boolean;
  onPurchase?: () => void;
  /** When true, this is a component-only model and Download All should be the primary action */
  isPrimary?: boolean;
}

// Required component types (shown with yellow warning styling)
const requiredComponentTypes: ModelFileComponentType[] = [
  'VAE',
  'TextEncoder',
  'UNet',
  'CLIPVision',
  'ControlNet',
];

export function RequiredComponentsSection({
  groupedFiles,
  versionId,
  userPreferences,
  canDownload,
  downloadPrice,
  isLoadingAccess,
  archived,
  onPurchase,
  isPrimary = false,
}: RequiredComponentsSectionProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  // Get only required component types that have files
  const requiredComponents = useMemo(() => {
    const result: Array<{
      type: ModelFileComponentType;
      files: FileType[];
      config: (typeof componentTypeConfig)[ModelFileComponentType];
    }> = [];

    for (const componentType of requiredComponentTypes) {
      const files = groupedFiles.components[componentType];
      if (files && files.length > 0) {
        result.push({
          type: componentType,
          files,
          config: componentTypeConfig[componentType],
        });
      }
    }

    return result;
  }, [groupedFiles.components]);

  // Track selected file for each component type
  const [selectedFiles, setSelectedFiles] = useState<
    Partial<Record<ModelFileComponentType, FileType>>
  >({});

  // Initialize selected files with best matches (only for types not yet selected)
  useEffect(() => {
    setSelectedFiles((prev) => {
      const updated = { ...prev };
      let changed = false;
      for (const component of requiredComponents) {
        if (!prev[component.type]) {
          const bestMatch = getPrimaryFile(component.files, { metadata: userPreferences });
          if (bestMatch) {
            updated[component.type] = bestMatch;
            changed = true;
          }
        }
      }
      return changed ? updated : prev;
    });
  }, [requiredComponents, userPreferences]);

  // Calculate total size of selected components
  const totalSize = useMemo(() => {
    let total = 0;
    for (const component of requiredComponents) {
      const selectedFile = selectedFiles[component.type] || component.files[0];
      if (selectedFile) {
        total += selectedFile.sizeKB;
      }
    }
    return total;
  }, [requiredComponents, selectedFiles]);

  const needsPurchase = !canDownload && !!downloadPrice;

  // Handle downloading all components
  const handleDownloadAll = () => {
    if (!canDownload) {
      if (onPurchase) onPurchase();
      return;
    }

    // Stagger downloads with delays to avoid browser popup blocking
    requiredComponents.forEach((component, index) => {
      const selectedFile = selectedFiles[component.type] || component.files[0];
      if (selectedFile) {
        const url = createModelFileDownloadUrl({
          versionId,
          type: selectedFile.type,
          meta: selectedFile.metadata,
        });
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = url;
          a.download = '';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }, index * 500);
      }
    });
  };

  if (requiredComponents.length === 0) {
    return null;
  }

  return (
    <Accordion.Item
      value="required-components"
      style={{
        marginTop: theme.spacing.md,
        borderColor: 'var(--mantine-color-yellow-6)',
      }}
    >
      <Accordion.Control>
        <Group gap="xs">
          <IconAlertTriangle size={18} color="var(--mantine-color-yellow-5)" />
          <Text fw={500}>Required Components</Text>
          <Badge size="sm" color="yellow" variant="light">
            {requiredComponents.length}
          </Badge>
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap={0}>
          {/* Info message */}
          <Box
            p="sm"
            style={{
              backgroundColor: 'rgba(250, 176, 5, 0.05)',
              borderBottom: '1px solid rgba(250, 176, 5, 0.2)',
            }}
          >
            <Text size="xs" c="yellow.2" style={{ opacity: 0.8 }}>
              You need these files to run this model. We&apos;ll show the best match for your
              preferences.
            </Text>
          </Box>

          {/* Component list */}
          {requiredComponents.map((component) => (
            <ComponentGroup
              key={component.type}
              files={component.files}
              config={component.config}
              versionId={versionId}
              userPreferences={userPreferences}
              canDownload={canDownload}
              downloadPrice={downloadPrice}
              isLoadingAccess={isLoadingAccess}
              archived={archived}
              onPurchase={onPurchase}
              selectedFile={selectedFiles[component.type]}
              onSelectFile={(file) =>
                setSelectedFiles((prev) => ({ ...prev, [component.type]: file }))
              }
            />
          ))}

          {/* Download All button - more prominent when isPrimary */}
          <Box
            p="sm"
            style={{
              borderTop: `1px solid ${
                colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
              }`,
            }}
          >
            <Button
              fullWidth
              pos="relative"
              className="overflow-visible"
              variant={isPrimary ? 'filled' : 'light'}
              color={needsPurchase ? 'yellow' : 'blue'}
              size={isPrimary ? 'md' : 'sm'}
              leftSection={
                needsPurchase ? (
                  <IconBolt size={isPrimary ? 20 : 18} />
                ) : (
                  <IconPackage size={isPrimary ? 20 : 18} />
                )
              }
              onClick={handleDownloadAll}
              disabled={archived || isLoadingAccess}
              style={
                isPrimary || needsPurchase
                  ? undefined
                  : {
                      backgroundColor: 'rgba(34, 139, 230, 0.15)',
                      borderColor: 'rgba(34, 139, 230, 0.3)',
                    }
              }
            >
              <Group gap={8}>
                <span>
                  {needsPurchase
                    ? `Purchase (${abbreviateNumber(downloadPrice ?? 0, { decimals: 0 })})`
                    : 'Download All Components'}
                </span>
                {!needsPurchase && (
                  <Text span c={isPrimary ? 'blue.2' : 'blue.3'} style={{ opacity: 0.7 }}>
                    ({formatKBytes(totalSize)})
                  </Text>
                )}
              </Group>
            </Button>
            <Text size="xs" c="dimmed" ta="center" mt="xs">
              Downloads your preferred variants
            </Text>
          </Box>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

// Individual component group (single or multi-variant)
interface ComponentGroupProps {
  files: FileType[];
  config: (typeof componentTypeConfig)[ModelFileComponentType];
  versionId: number;
  userPreferences?: UserFilePreferences;
  canDownload: boolean;
  downloadPrice?: number;
  isLoadingAccess?: boolean;
  archived?: boolean;
  onPurchase?: () => void;
  selectedFile?: FileType;
  onSelectFile: (file: FileType) => void;
}

function ComponentGroup({
  files,
  config,
  versionId,
  userPreferences,
  canDownload,
  downloadPrice,
  isLoadingAccess,
  archived,
  onPurchase,
  selectedFile,
  onSelectFile,
}: ComponentGroupProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [expanded, { toggle }] = useDisclosure(false);

  const bestMatch = useMemo(
    () => getPrimaryFile(files, { metadata: userPreferences }),
    [files, userPreferences]
  );

  const activeFile = selectedFile || bestMatch || files[0];
  const Icon = config.icon;
  const hasMultipleVariants = files.length > 1;
  const isDownloadDisabled = archived || isLoadingAccess;

  const downloadUrl = activeFile
    ? createModelFileDownloadUrl({
        versionId,
        type: activeFile.type,
        meta: activeFile.metadata,
      })
    : undefined;

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDownload) {
      e.preventDefault();
      if (onPurchase) onPurchase();
    }
  };

  // Single variant - simple display
  if (!hasMultipleVariants) {
    const file = files[0];
    return (
      <Box
        p="sm"
        style={{
          borderBottom: `1px solid ${
            colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
          }`,
        }}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={36} radius="md" color={config.color} variant="light">
              <Icon size={20} />
            </ThemeIcon>
            <Box>
              <Text size="sm" fw={500}>
                {config.name}
              </Text>
              <Text size="xs" c="dimmed">
                {file.name || getFileLabel(file)} &bull; {formatKBytes(file.sizeKB)}
              </Text>
            </Box>
          </Group>
          <Tooltip label={canDownload ? 'Download' : 'Purchase to download'}>
            <ActionIcon
              component="a"
              href={isDownloadDisabled || !canDownload ? undefined : downloadUrl}
              onClick={handleDownload}
              variant="light"
              color="gray"
              size="md"
              radius="md"
              disabled={isDownloadDisabled}
            >
              <IconDownload size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Box>
    );
  }

  // Multiple variants - expandable group
  return (
    <Box
      style={{
        borderBottom: `1px solid ${
          colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
        }`,
      }}
    >
      {/* Header - clickable to expand */}
      <Box
        p="sm"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${config.name}, ${files.length} variants available. Click to ${
          expanded ? 'collapse' : 'expand'
        }.`}
        style={{ cursor: 'pointer' }}
        onClick={toggle}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        className="hover:bg-dark-6/50 dark:hover:bg-dark-6/50"
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={36} radius="md" color={config.color} variant="light">
              <Icon size={20} />
            </ThemeIcon>
            <Box>
              <Group gap={8}>
                <Text size="sm" fw={500}>
                  {config.name}
                </Text>
                <Badge size="xs" variant="light" color="gray">
                  {files.length} variants
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {activeFile.name || getFileLabel(activeFile)} selected &bull;{' '}
                {formatKBytes(activeFile.sizeKB)}
              </Text>
            </Box>
          </Group>
          <IconChevronDown
            size={16}
            style={{
              transition: 'transform 200ms',
              transform: expanded ? 'rotate(180deg)' : undefined,
              color: theme.colors.dark[2],
            }}
          />
        </Group>
      </Box>

      {/* Expanded variants list */}
      <Collapse in={expanded}>
        <Box
          role="listbox"
          aria-label={`${config.name} variant options`}
          style={{
            backgroundColor: colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
            borderTop: `1px solid ${
              colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
            }`,
          }}
        >
          {files.map((file) => {
            const isSelected = file.id === activeFile?.id;
            const isBestMatch = file.id === bestMatch?.id;
            const fileDownloadUrl = createModelFileDownloadUrl({
              versionId,
              type: file.type,
              meta: file.metadata,
            });

            return (
              <Box
                key={file.id}
                px="sm"
                py="xs"
                pl={56}
                role="option"
                tabIndex={0}
                aria-selected={isSelected}
                aria-label={`${getFileLabel(file)}${
                  isBestMatch ? ', best match' : ''
                }, ${getFileDescription(file)}, ${formatKBytes(file.sizeKB)}`}
                style={{
                  backgroundColor: isSelected ? 'rgba(34, 139, 230, 0.1)' : undefined,
                  borderBottom: `1px solid ${
                    colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1]
                  }`,
                  cursor: 'pointer',
                }}
                onClick={() => onSelectFile(file)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectFile(file);
                  }
                }}
                className="hover:bg-dark-6/30 dark:hover:bg-dark-6/30"
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={8}>
                    <Box w={16}>
                      {isSelected && <IconCheck size={16} color={theme.colors.green[5]} />}
                    </Box>
                    <Box>
                      <Group gap={8}>
                        <Text size="sm">{getFileLabel(file)}</Text>
                        {isBestMatch && (
                          <Badge size="xs" color="green" variant="light">
                            Best match
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {getFileDescription(file)}
                      </Text>
                    </Box>
                  </Group>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="xs" c="dimmed">
                      {formatKBytes(file.sizeKB)}
                    </Text>
                    <Tooltip label={canDownload ? 'Download' : 'Purchase to download'}>
                      <ActionIcon
                        component="a"
                        href={isDownloadDisabled || !canDownload ? undefined : fileDownloadUrl}
                        onClick={handleDownload}
                        variant="light"
                        color="gray"
                        size="sm"
                        radius="md"
                        disabled={isDownloadDisabled}
                      >
                        <IconDownload size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              </Box>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}
