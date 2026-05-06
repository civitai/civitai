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
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconExternalLink,
  IconLayersLinked,
  IconPackage,
  IconPuzzle,
} from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { LinkedComponent } from '~/server/schema/model-file.schema';
import { getPrimaryFile, type GroupedFileVariants } from '~/server/utils/model-helpers';
import type { ModelById } from '~/types/router';
import {
  componentTypeConfig,
  getFileDescription,
  getFileLabel,
} from '~/utils/file-display-helpers';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { abbreviateNumber, formatKBytes } from '~/utils/number-helpers';
import { getModelUrl } from '~/utils/string-helpers';

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
  /** Linked components from external models that are required */
  linkedComponents?: LinkedComponent[];
}

// Component types are now data-driven via groupedFiles.requiredComponents

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
  linkedComponents = [],
}: RequiredComponentsSectionProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  // Get only required component types that have files (now data-driven)
  const requiredComponents = useMemo(() => {
    const result: Array<{
      type: ModelFileComponentType;
      files: FileType[];
      config: (typeof componentTypeConfig)[ModelFileComponentType];
    }> = [];

    for (const [componentType, files] of Object.entries(groupedFiles.requiredComponents)) {
      if (files && files.length > 0) {
        result.push({
          type: componentType as ModelFileComponentType,
          files,
          config: componentTypeConfig[componentType as ModelFileComponentType],
        });
      }
    }

    return result;
  }, [groupedFiles.requiredComponents]);

  const [downloading, setDownloading] = useState(false);

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
    for (const lc of linkedComponents) {
      if (lc.sizeKB) {
        total += lc.sizeKB;
      }
    }
    return total;
  }, [requiredComponents, selectedFiles, linkedComponents]);

  const needsPurchase = !canDownload && !!downloadPrice;

  // Handle downloading all components using hidden iframes.
  // The model download endpoint uses res.redirect(), so <a> tag clicks get blocked
  // after the first programmatic navigation. Iframes each follow redirects independently.
  const handleDownloadAll = async () => {
    if (!canDownload) {
      if (onPurchase) onPurchase();
      return;
    }
    if (downloading) return;

    setDownloading(true);

    const downloadUrls: string[] = [];
    for (const component of requiredComponents) {
      const selectedFile = selectedFiles[component.type] || component.files[0];
      if (selectedFile) {
        downloadUrls.push(createModelFileDownloadUrl({ versionId, fileId: selectedFile.id }));
      }
    }
    for (const lc of linkedComponents) {
      downloadUrls.push(createModelFileDownloadUrl({ versionId: lc.versionId, fileId: lc.fileId }));
    }

    for (let i = 0; i < downloadUrls.length; i++) {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = downloadUrls[i];
      document.body.appendChild(iframe);
      // Clean up iframe after download has started
      setTimeout(() => iframe.remove(), 60_000);

      // Small delay between downloads to avoid browser throttling
      if (i < downloadUrls.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    setDownloading(false);
  };

  if (requiredComponents.length === 0 && linkedComponents.length === 0) {
    return null;
  }

  return (
    <Accordion.Item
      value="required-components"
      style={{
        marginTop: theme.spacing.md,
      }}
    >
      <Accordion.Control>
        <Group gap="xs">
          <IconLayersLinked size={18} color="var(--mantine-color-yellow-5)" />
          <Text fw={500}>Required Components</Text>
          <Badge size="sm" color="yellow" variant="light">
            {requiredComponents.length + linkedComponents.length}
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
              isLoadingAccess={isLoadingAccess}
              archived={archived}
              onPurchase={onPurchase}
              selectedFile={selectedFiles[component.type]}
              onSelectFile={(file) =>
                setSelectedFiles((prev) => ({ ...prev, [component.type]: file }))
              }
            />
          ))}

          {/* Linked components (external models) */}
          {linkedComponents.map((lc) => {
            const config = componentTypeConfig[lc.componentType];
            const Icon = config?.icon ?? IconPuzzle;
            return (
              <Box
                key={`lc-${lc.recommendedResourceId ?? lc.fileId}`}
                p="sm"
                style={{
                  borderBottom: `1px solid ${
                    colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                  }`,
                }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap="sm" wrap="nowrap">
                    <ThemeIcon
                      size={36}
                      radius="md"
                      color={config?.color ?? 'gray'}
                      variant="light"
                    >
                      <Icon size={20} />
                    </ThemeIcon>
                    <Box>
                      <Group gap={6}>
                        <Text
                          component={Link}
                          href={getModelUrl({ modelId: lc.modelId, modelName: lc.modelName })}
                          size="sm"
                          fw={500}
                          td="underline"
                          style={{ textDecorationStyle: 'dotted' }}
                        >
                          {lc.modelName}
                        </Text>
                        <Badge size="xs" variant="light" color="gray">
                          {config?.name ?? lc.componentType}
                        </Badge>
                        <Badge size="xs" variant="outline" color="blue">
                          <Group gap={4}>
                            <IconExternalLink size={10} />
                            External
                          </Group>
                        </Badge>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {lc.versionName} &bull; {lc.fileName}
                      </Text>
                    </Box>
                  </Group>
                  <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                    {lc.sizeKB ? (
                      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                        {formatKBytes(lc.sizeKB)}
                      </Text>
                    ) : null}
                    <Tooltip
                      label={canDownload ? 'Download from source model' : 'Purchase to download'}
                    >
                      <ActionIcon
                        component="a"
                        href={
                          archived || isLoadingAccess || !canDownload
                            ? undefined
                            : createModelFileDownloadUrl({
                                versionId: lc.versionId,
                                fileId: lc.fileId,
                              })
                        }
                        onClick={(e: React.MouseEvent) => {
                          if (!canDownload) {
                            e.preventDefault();
                            if (onPurchase) onPurchase();
                          }
                        }}
                        variant="light"
                        color="gray"
                        size="md"
                        radius="md"
                        disabled={archived || isLoadingAccess}
                      >
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              </Box>
            );
          })}

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
              loading={downloading}
              disabled={archived || isLoadingAccess || downloading}
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
    ? createModelFileDownloadUrl({ versionId, fileId: activeFile.id })
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
              <VerifiedText file={file} />
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
        className="hover:bg-gray-1 dark:hover:bg-dark-6/50"
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
            const label = getFileLabel(file) ?? file.name;
            const description = getFileDescription(file);
            const fileDownloadUrl = createModelFileDownloadUrl({
              versionId,
              fileId: file.id,
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
                aria-label={[
                  label,
                  isBestMatch ? 'best match' : null,
                  description,
                  formatKBytes(file.sizeKB),
                ]
                  .filter(Boolean)
                  .join(', ')}
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
                className="hover:bg-gray-1 dark:hover:bg-dark-6/30"
              >
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={8}>
                    <Box w={16}>
                      {isSelected && <IconCheck size={16} color={theme.colors.green[5]} />}
                    </Box>
                    <Box>
                      <Group gap={8}>
                        <Text size="sm">{label}</Text>
                        {isBestMatch && (
                          <Badge size="xs" color="green" variant="light">
                            Best match
                          </Badge>
                        )}
                      </Group>
                      {description && (
                        <Text size="xs" c="dimmed">
                          {description}
                        </Text>
                      )}
                      <VerifiedText file={file} />
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
                        size="md"
                        radius="md"
                        disabled={isDownloadDisabled}
                      >
                        <IconDownload size={16} />
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
