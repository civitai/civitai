import {
  Badge,
  Box,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCheck, IconChevronDown, IconDownload } from '@tabler/icons-react';
import { useMemo, useState, useEffect } from 'react';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getPrimaryFile, groupFilesByVariant } from '~/server/utils/model-helpers';
import type { ModelById } from '~/types/router';
import { formatKBytes } from '~/utils/number-helpers';
import type { ModelType } from '~/shared/utils/prisma/enums';

type FileType = ModelById['modelVersions'][number]['files'][number];

interface DownloadVariantDropdownProps {
  files: FileType[];
  modelType: ModelType;
  versionId: number;
  userPreferences?: UserFilePreferences;
  canDownload: boolean;
  downloadPrice?: number;
  isLoadingAccess?: boolean;
  archived?: boolean;
  onPurchase?: () => void;
}

function getFileLabel(file: FileType): string {
  const { fp, quantType, format, size } = file.metadata ?? {};

  // For GGUF files, show quant type
  if (format === 'GGUF' && quantType) {
    return quantType;
  }

  // For SafeTensor and others, show fp precision
  if (fp) {
    return fp;
  }

  // Fallback to size
  if (size) {
    return size === 'pruned' ? 'Pruned' : 'Full';
  }

  return 'Standard';
}

function getFileDescription(file: FileType): string {
  const { fp, quantType, format, size } = file.metadata ?? {};

  const parts: string[] = [];

  if (format === 'GGUF') {
    if (quantType === 'Q8_0') parts.push('8-bit GGUF, highest quality');
    else if (quantType === 'Q6_K') parts.push('6-bit GGUF, high quality');
    else if (quantType === 'Q5_K_M') parts.push('5-bit GGUF, balanced');
    else if (quantType === 'Q4_K_M') parts.push('4-bit GGUF, smaller file');
    else if (quantType === 'Q4_K_S') parts.push('4-bit small GGUF');
    else if (quantType === 'Q3_K_M') parts.push('3-bit GGUF, compact');
    else if (quantType === 'Q2_K') parts.push('2-bit GGUF, smallest');
    else if (quantType) parts.push(`${quantType} quantization`);
  } else {
    if (fp === 'fp32') parts.push('Full precision, largest file');
    else if (fp === 'fp16') parts.push('Half precision, best balance');
    else if (fp === 'bf16') parts.push('Brain float, good balance');
    else if (fp === 'fp8') parts.push('8-bit, smaller file');
    else if (fp === 'nf4') parts.push('4-bit normalized');
    else if (fp) parts.push(`${fp} precision`);
  }

  if (size === 'pruned') {
    parts.push(parts.length ? '(pruned)' : 'Pruned model');
  }

  return parts.join(' ') || 'Standard variant';
}

export function DownloadVariantDropdown({
  files,
  modelType,
  versionId,
  userPreferences,
  canDownload,
  downloadPrice,
  isLoadingAccess,
  archived,
  onPurchase,
}: DownloadVariantDropdownProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [opened, { toggle, close }] = useDisclosure(false);

  // Group files by variant
  const groupedFiles = useMemo(() => groupFilesByVariant(files), [files]);

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

  const totalVariants = modelFiles.length;

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
    close();
  };

  const handleDownloadClick = () => {
    if (!canDownload && onPurchase) {
      onPurchase();
    }
  };

  if (modelFiles.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No files available
      </Text>
    );
  }

  // If only one file, show simple download button
  if (modelFiles.length === 1) {
    const file = modelFiles[0];
    return (
      <Stack gap={4}>
        <DownloadButton
          component="a"
          href={downloadUrl}
          onClick={handleDownloadClick}
          canDownload={canDownload}
          downloadPrice={downloadPrice}
          disabled={archived || isLoadingAccess}
          fullWidth
        >
          <Text align="center">
            Download <Text span>({formatKBytes(file.sizeKB)})</Text>
          </Text>
        </DownloadButton>
        <Group justify="space-between" wrap="nowrap" gap={0}>
          <VerifiedText file={file} />
          <Group gap={4}>
            <Text size="xs" c="dimmed">
              {file.metadata?.format}
            </Text>
          </Group>
        </Group>
      </Stack>
    );
  }

  // Multiple files - show dropdown
  return (
    <Stack gap="sm">
      <Box>
        <Text size="sm" fw={500} c="white" mb={4}>
          Download
        </Text>
        <Text size="xs" c="dimmed">
          {totalVariants} variants available
        </Text>
      </Box>

      {/* Dropdown trigger */}
      <Paper
        withBorder
        p="sm"
        radius="md"
        style={{
          cursor: 'pointer',
          backgroundColor: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
          borderColor: opened
            ? theme.colors.blue[5]
            : colorScheme === 'dark'
              ? theme.colors.dark[4]
              : theme.colors.gray[3],
        }}
        onClick={toggle}
      >
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="blue" size="lg" radius="md">
              <IconDownload size={18} />
            </ThemeIcon>
            <Box>
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={500}>
                  {getFileLabel(activeFile)} {activeFile.metadata?.format}
                </Text>
                {activeFile.id === bestMatchFile?.id && (
                  <Badge size="xs" color="green" variant="light">
                    Best match
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {getFileDescription(activeFile)}
              </Text>
            </Box>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {formatKBytes(activeFile.sizeKB)}
            </Text>
            <IconChevronDown
              size={16}
              style={{
                transition: 'transform 200ms',
                transform: opened ? 'rotate(180deg)' : undefined,
              }}
            />
          </Group>
        </Group>
      </Paper>

      {/* Dropdown content */}
      <Collapse in={opened}>
        <Paper
          withBorder
          radius="md"
          style={{
            backgroundColor: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
            overflow: 'hidden',
            maxHeight: 350,
            overflowY: 'auto',
          }}
        >
          {/* SafeTensor Section */}
          {groupedFiles.safeTensorVariants.length > 0 && (
            <Box>
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
                SafeTensor
              </Text>
              {groupedFiles.safeTensorVariants.map((file) => (
                <VariantItem
                  key={file.id}
                  file={file}
                  isSelected={file.id === activeFile?.id}
                  isBestMatch={file.id === bestMatchFile?.id}
                  onSelect={handleSelectFile}
                />
              ))}
            </Box>
          )}

          {/* GGUF Section */}
          {groupedFiles.ggufVariants.length > 0 && (
            <Box
              style={{
                borderTop:
                  groupedFiles.safeTensorVariants.length > 0
                    ? `1px solid ${colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]}`
                    : undefined,
              }}
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
                GGUF (Quantized)
              </Text>
              {groupedFiles.ggufVariants.map((file) => (
                <VariantItem
                  key={file.id}
                  file={file}
                  isSelected={file.id === activeFile?.id}
                  isBestMatch={file.id === bestMatchFile?.id}
                  onSelect={handleSelectFile}
                />
              ))}
            </Box>
          )}

          {/* Other formats Section */}
          {groupedFiles.otherFormatVariants.length > 0 && (
            <Box
              style={{
                borderTop:
                  groupedFiles.safeTensorVariants.length > 0 ||
                  groupedFiles.ggufVariants.length > 0
                    ? `1px solid ${colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]}`
                    : undefined,
              }}
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
                Other Formats
              </Text>
              {groupedFiles.otherFormatVariants.map((file) => (
                <VariantItem
                  key={file.id}
                  file={file}
                  isSelected={file.id === activeFile?.id}
                  isBestMatch={file.id === bestMatchFile?.id}
                  onSelect={handleSelectFile}
                />
              ))}
            </Box>
          )}
        </Paper>
      </Collapse>

      {/* Download button */}
      <DownloadButton
        component="a"
        href={downloadUrl}
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
    </Stack>
  );
}

// Individual variant item component
function VariantItem({
  file,
  isSelected,
  isBestMatch,
  onSelect,
}: {
  file: FileType;
  isSelected: boolean;
  isBestMatch: boolean;
  onSelect: (file: FileType) => void;
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  return (
    <UnstyledButton
      onClick={() => onSelect(file)}
      w="100%"
      px="sm"
      py="xs"
      style={{
        backgroundColor: isSelected
          ? 'rgba(34, 139, 230, 0.15)'
          : colorScheme === 'dark'
            ? 'transparent'
            : 'transparent',
        transition: 'background-color 100ms',
        ':hover': {
          backgroundColor: colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
        },
      }}
      className="hover:bg-dark-5 dark:hover:bg-dark-5"
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <Box w={16}>
            {isSelected && <IconCheck size={16} color={theme.colors.green[5]} />}
          </Box>
          <Box>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={500}>
                {getFileLabel(file)}
              </Text>
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
        <Text size="sm" c="dimmed">
          {formatKBytes(file.sizeKB)}
        </Text>
      </Group>
    </UnstyledButton>
  );
}
