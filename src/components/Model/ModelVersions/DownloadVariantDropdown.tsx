import {
  ActionIcon,
  Badge,
  Box,
  Collapse,
  Group,
  Text,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCategory, IconCheck, IconChevronDown, IconDownload } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile, groupFilesByVariant } from '~/server/utils/model-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';
import type { ModelById } from '~/types/router';
import { getFileDescription, getFileLabel } from '~/utils/file-display-helpers';
import { formatKBytes } from '~/utils/number-helpers';

type FileType = ModelById['modelVersions'][number]['files'][number];

interface DownloadVariantDropdownProps {
  files: FileType[];
  versionId: number;
  modelType?: ModelType | null;
  userPreferences?: UserFilePreferences;
  canDownload: boolean;
  downloadPrice?: number;
  isLoadingAccess?: boolean;
  archived?: boolean;
  onPurchase?: () => void;
}

export function DownloadVariantDropdown({
  files,
  versionId,
  modelType,
  userPreferences,
  canDownload,
  downloadPrice,
  isLoadingAccess,
  archived,
  onPurchase,
}: DownloadVariantDropdownProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [opened, { toggle }] = useDisclosure(false);

  // Group files by variant
  const groupedFiles = useMemo(() => groupFilesByVariant(files, modelType), [files, modelType]);

  // Get all model files (SafeTensor + GGUF + other)
  const modelFiles = useMemo(() => {
    return [
      ...groupedFiles.safeTensorVariants,
      ...groupedFiles.ggufVariants,
      ...groupedFiles.otherFormatVariants,
    ];
  }, [groupedFiles]);

  // Get the best matching file based on user preferences
  const bestMatchFile = useMemo(() => {
    return getPrimaryFile(modelFiles, { metadata: userPreferences });
  }, [modelFiles, userPreferences]);

  // State for selected file - initialize with best match
  const [selectedFile, setSelectedFile] = useState<FileType | null>(null);

  // Update selected file when best match changes (on initial load)
  useEffect(() => {
    if (!selectedFile && bestMatchFile) {
      setSelectedFile(bestMatchFile);
    }
  }, [bestMatchFile, selectedFile]);

  const activeFile = selectedFile ?? bestMatchFile ?? modelFiles[0];

  // Calculate download URL
  const downloadUrl = activeFile
    ? createModelFileDownloadUrl({
        versionId,
        type: activeFile.type,
        meta: activeFile.metadata,
      })
    : undefined;

  const handleSelectFile = (file: FileType) => {
    setSelectedFile(file);
  };

  const handleDownloadClick = () => {
    if (!canDownload && onPurchase) {
      onPurchase();
    }
  };

  const handleVariantDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDownload) {
      e.preventDefault();
      if (onPurchase) onPurchase();
    }
  };

  if (modelFiles.length === 0) {
    return (
      <Box p="sm">
        <Text size="sm" c="dimmed">
          No files available
        </Text>
      </Box>
    );
  }

  // If only one file, show the file summary above a full-width download button
  if (modelFiles.length === 1) {
    const file = modelFiles[0];
    return (
      <Box>
        <Box p="sm">
          <FileSummaryRow file={file} />
        </Box>
        <Box
          p="sm"
          style={{
            borderTop: `1px solid ${
              colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
            }`,
          }}
        >
          <DownloadButton
            component="a"
            href={archived || isLoadingAccess || !canDownload ? undefined : downloadUrl}
            onClick={handleDownloadClick}
            canDownload={canDownload}
            downloadPrice={downloadPrice}
            disabled={archived || isLoadingAccess}
            fullWidth
            variant="light"
            color="blue"
            style={{
              backgroundColor: 'rgba(34, 139, 230, 0.15)',
              borderColor: 'rgba(34, 139, 230, 0.3)',
            }}
          >
            <Text ta="center">
              Download <Text span>({formatKBytes(file.sizeKB)})</Text>
            </Text>
          </DownloadButton>
        </Box>
      </Box>
    );
  }

  // Render variant rows for a format section
  const renderFormatSection = (sectionFiles: FileType[], label: string, showBorderTop: boolean) => {
    if (sectionFiles.length === 0) return null;
    return (
      <Box
        style={
          showBorderTop
            ? {
                borderTop: `1px solid ${
                  colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                }`,
              }
            : undefined
        }
      >
        <Text
          size="xs"
          fw={600}
          c="dimmed"
          tt="uppercase"
          px="sm"
          pt="sm"
          pb={4}
          style={{ letterSpacing: 0.5 }}
        >
          {label}
        </Text>
        {sectionFiles.map((file) => {
          const isSelected = file.id === activeFile?.id;
          const isBestMatch = file.id === bestMatchFile?.id;
          const label = getFileLabel(file);
          const description = getFileDescription(file);
          const displayLabel = label ?? file.name;
          const ariaLabel = [
            displayLabel,
            isBestMatch ? 'best match' : null,
            description,
            formatKBytes(file.sizeKB),
          ]
            .filter(Boolean)
            .join(', ');
          const fileDownloadUrl = createModelFileDownloadUrl({
            versionId,
            type: file.type,
            meta: file.metadata,
          });

          return (
            <Box
              key={file.id}
              px={16}
              py={8}
              role="option"
              tabIndex={0}
              aria-selected={isSelected}
              aria-label={ariaLabel}
              style={{
                backgroundColor: isSelected ? 'rgba(34, 139, 230, 0.1)' : undefined,
                borderBottom: `1px solid ${
                  colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1]
                }`,
                cursor: 'pointer',
              }}
              onClick={() => handleSelectFile(file)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelectFile(file);
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
                      <Text size="sm">{displayLabel}</Text>
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
                      href={
                        archived || isLoadingAccess || !canDownload ? undefined : fileDownloadUrl
                      }
                      onClick={handleVariantDownload}
                      variant="light"
                      color="gray"
                      size={32}
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
      </Box>
    );
  };

  // Multiple files - ComponentGroup-style dropdown
  return (
    <Box>
      {/* Trigger */}
      <Box
        p="sm"
        role="button"
        tabIndex={0}
        aria-expanded={opened}
        aria-haspopup="listbox"
        aria-label={`Select download variant. Currently selected: ${
          [getFileLabel(activeFile), activeFile.metadata?.format].filter(Boolean).join(' ') ||
          activeFile.name
        }`}
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
          <FileSummaryRow file={activeFile} isBestMatch={activeFile.id === bestMatchFile?.id} />
          <IconChevronDown
            size={16}
            style={{
              transition: 'transform 200ms',
              transform: opened ? 'rotate(180deg)' : undefined,
              color: theme.colors.dark[2],
            }}
          />
        </Group>
      </Box>

      {/* Expanded variants list */}
      <Collapse in={opened}>
        <Box
          role="listbox"
          aria-label="Download variant options"
          style={{
            backgroundColor: colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
            borderTop: `1px solid ${
              colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
            }`,
            maxHeight: 350,
            overflowY: 'auto',
          }}
        >
          {renderFormatSection(groupedFiles.safeTensorVariants, 'SafeTensor', false)}
          {renderFormatSection(
            groupedFiles.ggufVariants,
            'GGUF (Quantized)',
            groupedFiles.safeTensorVariants.length > 0
          )}
          {renderFormatSection(
            groupedFiles.otherFormatVariants,
            'Other Formats',
            groupedFiles.safeTensorVariants.length > 0 || groupedFiles.ggufVariants.length > 0
          )}
        </Box>
      </Collapse>

      {/* Download button - always visible */}
      <Box
        p="sm"
        style={{
          borderTop: `1px solid ${
            colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        }}
      >
        <DownloadButton
          component="a"
          href={
            !activeFile || archived || isLoadingAccess || !canDownload ? undefined : downloadUrl
          }
          onClick={handleDownloadClick}
          canDownload={canDownload}
          downloadPrice={downloadPrice}
          disabled={!activeFile || archived || isLoadingAccess}
          fullWidth
          style={{
            backgroundColor: 'rgba(34, 139, 230, 0.15)',
            borderColor: 'rgba(34, 139, 230, 0.3)',
          }}
          variant="light"
          color="blue"
        >
          Download Selected
        </DownloadButton>
      </Box>
    </Box>
  );
}

function FileSummaryRow({ file, isBestMatch = false }: { file: FileType; isBestMatch?: boolean }) {
  const label = getFileLabel(file);
  const description = getFileDescription(file);
  const format = file.metadata?.format;
  const titleText = [label, format].filter(Boolean).join(' ') || file.name;
  const detailText = [description, formatKBytes(file.sizeKB)].filter(Boolean).join(' • ');

  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon size={36} radius="md" color="blue" variant="light">
        <IconCategory size={20} />
      </ThemeIcon>
      <Box>
        <Group gap={8}>
          <Text size="sm" fw={500}>
            {titleText}
          </Text>
          {isBestMatch && (
            <Badge size="xs" color="green" variant="light">
              Best match
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {detailText}
        </Text>
        <VerifiedText file={file} />
      </Box>
    </Group>
  );
}
