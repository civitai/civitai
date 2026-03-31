import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Modal,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowRight,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconFile,
  IconFiles,
  IconGitMerge,
  IconTarget,
} from '@tabler/icons-react';
import { startCase } from 'lodash-es';
import React, { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ModelFileType } from '~/server/common/constants';
import { componentFileTypes, constants, zipModelFileTypes } from '~/server/common/constants';
import { showErrorNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { comfyFileTypeLabels, getFileIconConfig } from '~/utils/file-display-helpers';
import { trpc } from '~/utils/trpc';

type FileMetadataUpdate = {
  fp?: ModelFileFp | null;
  size?: (typeof constants.modelFileSizes)[number] | null;
  format?: ModelFileFormat | null;
  quantType?: ModelFileQuantType | null;
  isRequired?: boolean | null;
};

type FileTypeMapping = {
  fileId: number;
  type?: ModelFileType;
  metadata?: FileMetadataUpdate;
};

type Step = 'select-target' | 'map-files' | 'confirm';

const STEP_KEYS: Step[] = ['select-target', 'map-files', 'confirm'];

/** Theme-aware color tokens for the consolidation modal */
function useThemeColors() {
  const colorScheme = useComputedColorScheme('dark');
  const dark = colorScheme === 'dark';
  return useMemo(
    () => ({
      // Text
      text: dark ? '#e0e0e0' : '#212529',
      textSecondary: dark ? '#c1c2c5' : '#495057',
      dimmed: dark ? '#909296' : '#868e96',
      dimmedFaint: dark ? '#5c5f66' : '#adb5bd',
      // Surfaces
      cardBg: dark ? '#25262b' : '#f8f9fa',
      border: dark ? '#2c2e33' : '#dee2e6',
      borderLight: dark ? '#373a40' : '#ced4da',
      inputBg: dark ? '#2c2e33' : '#ffffff',
      inputBorder: dark ? '#4a4d54' : '#ced4da',
      inputText: dark ? '#c1c2c5' : '#495057',
      // Stepper
      stepperInactive: dark ? '#2c2e33' : '#e9ecef',
      stepperInactiveBorder: dark ? '#373a40' : '#dee2e6',
      stepperInactiveIcon: dark ? '#909296' : '#868e96',
      // Accents
      blue: '#228be6',
      green: '#40c057',
      red: '#fa5252',
      // Accent backgrounds (with alpha)
      blueGhost: dark ? '#228be60f' : '#228be60a',
      blueBadgeBg: dark ? '#228be626' : '#228be61a',
      blueBorder: dark ? '#228be633' : '#228be633',
      blueTargetBg: dark ? '#228be60d' : '#228be60a',
      redGhost: dark ? '#fa52520a' : '#fff5f5',
      redBorder: dark ? '#fa52524d' : '#ffc9c9',
      // Source badge
      sourceBadgeBg: dark ? '#25262b' : '#f1f3f5',
      selectLabel: dark ? '#909296' : '#868e96',
    }),
    [dark]
  );
}

const STEP_CONFIG = [
  { label: 'Select Target', description: 'Choose primary version', icon: IconTarget, iconSize: 16 },
  {
    label: 'Configure Files',
    description: 'Set type & precision',
    icon: IconFiles,
    iconSize: 14,
  },
  { label: 'Confirm', description: 'Review & merge', icon: IconCheck, iconSize: 14 },
] as const;

function StepperNav({ currentStep }: { currentStep: Step }) {
  const activeIndex = STEP_KEYS.indexOf(currentStep);
  const tc = useThemeColors();

  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '16px 0', marginBottom: 8 }}>
      {STEP_CONFIG.map((cfg, i) => {
        const isCompleted = i < activeIndex;
        const isActive = i === activeIndex;
        const StepIcon = cfg.icon;

        // Circle colors
        const circleBg = isCompleted ? tc.green : isActive ? tc.blue : tc.stepperInactive;
        const circleBorder =
          !isCompleted && !isActive ? `1px solid ${tc.stepperInactiveBorder}` : 'none';
        const iconColor = isCompleted || isActive ? '#ffffff' : tc.stepperInactiveIcon;

        // Label colors
        const labelColor = isCompleted ? tc.green : isActive ? tc.text : tc.dimmed;
        const labelWeight = isActive ? 600 : 500;
        const descColor = isActive ? tc.dimmed : tc.dimmedFaint;

        // Separator before this step
        const separator =
          i > 0 ? (
            <div
              style={{
                flex: 1,
                height: 2,
                backgroundColor:
                  i <= activeIndex ? (i === activeIndex ? tc.blue : tc.green) : tc.stepperInactive,
                margin: '0 8px',
              }}
            />
          ) : null;

        return (
          <React.Fragment key={i}>
            {separator}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: circleBg,
                  border: circleBorder,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {isCompleted ? (
                  <IconCircleCheck size={16} style={{ color: iconColor }} />
                ) : (
                  <StepIcon size={cfg.iconSize} style={{ color: iconColor }} />
                )}
              </div>
              <div>
                <Text style={{ fontSize: 13, fontWeight: labelWeight, color: labelColor }}>
                  {cfg.label}
                </Text>
                <Text style={{ fontSize: 11, color: descColor }}>{cfg.description}</Text>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function ConsolidateVersions({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const tc = useThemeColors();
  const [step, setStep] = useState<Step>('select-target');
  const [targetVersionId, setTargetVersionId] = useState<number | null>(null);
  const [fileTypeMappings, setFileTypeMappings] = useState<FileTypeMapping[]>([]);
  const [appendDescriptions, setAppendDescriptions] = useState(false);

  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery(
    { id: modelId },
    { enabled: !!modelId }
  );

  const consolidateMutation = trpc.modelVersion.consolidateVersions.useMutation({
    onSuccess: () => {
      window.location.reload();
      handleClose();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Unable to consolidate versions',
        error: new Error(error.message),
      });
    },
  });

  const handleClose = () => {
    if (consolidateMutation.isPending) return;
    dialog.onClose();
  };

  const handleConsolidate = () => {
    if (!targetVersionId || consolidateMutation.isPending) return;

    const sourceVersionIds = (model?.modelVersions ?? [])
      .map((v) => v.id)
      .filter((id) => id !== targetVersionId);

    consolidateMutation.mutate({
      modelId,
      targetVersionId,
      sourceVersionIds,
      fileTypeMappings: fileTypeMappings.length > 0 ? fileTypeMappings : undefined,
      appendDescriptions,
    });
  };

  const updateFileMapping = (fileId: number, updates: Partial<Omit<FileTypeMapping, 'fileId'>>) => {
    setFileTypeMappings((prev) => {
      const existing = prev.find((m) => m.fileId === fileId);
      if (existing) {
        return prev.map((m) =>
          m.fileId === fileId
            ? {
                ...m,
                ...updates,
                metadata: updates.metadata ? { ...m.metadata, ...updates.metadata } : m.metadata,
              }
            : m
        );
      }
      return [...prev, { fileId, ...updates }];
    });
  };

  const versions = model?.modelVersions ?? [];
  const sourceVersions = versions.filter((v) => v.id !== targetVersionId);
  const targetVersion = versions.find((v) => v.id === targetVersionId);

  const renderContent = () => {
    if (loadingModel) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-12">
          <Loader size={48} />
          <Text size="sm" c="dimmed">
            Loading model data...
          </Text>
        </div>
      );
    }

    if (consolidateMutation.isPending) {
      return (
        <div className="flex flex-col items-center justify-center gap-6 p-16">
          <Loader size={64} type="bars" />
          <Stack gap={4} align="center">
            <Text size="lg" fw={600}>
              Consolidating versions...
            </Text>
            <Text size="sm" c="dimmed" ta="center" maw={360}>
              Merging files, stats, and reviews into the target version. This may take a few minutes
              for large models.
            </Text>
          </Stack>
          <Card
            withBorder
            p="sm"
            w="100%"
            maw={400}
            style={{
              borderColor: 'var(--mantine-color-yellow-8)',
              backgroundColor: 'rgba(250, 176, 5, 0.05)',
            }}
          >
            <Group gap="xs" wrap="nowrap" justify="center">
              <IconAlertCircle
                size={16}
                style={{ color: 'var(--mantine-color-yellow-5)', flexShrink: 0 }}
              />
              <Text size="xs" c="yellow">
                Please keep this tab open until the process completes.
              </Text>
            </Group>
          </Card>
        </div>
      );
    }

    if (versions.length < 2) {
      return (
        <Stack>
          <Text>This model only has one version. There is nothing to consolidate.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Close
            </Button>
          </Group>
        </Stack>
      );
    }

    switch (step) {
      case 'select-target':
        return (
          <Stack gap="md">
            <StepperNav currentStep={step} />

            <Text size="sm" c="dimmed">
              Choose which version to keep. All files from the other versions will be merged into it
              and their stats (downloads, likes, etc.) will be combined.
            </Text>

            <ScrollArea.Autosize mah="60vh" offsetScrollbars>
              <Radio.Group
                value={targetVersionId?.toString() ?? ''}
                onChange={(val) => setTargetVersionId(Number(val))}
              >
                <Stack gap={6}>
                  {versions.map((version) => {
                    const isSelected = targetVersionId === version.id;
                    const fileCount = version.files?.length ?? 0;

                    return (
                      <div
                        key={version.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setTargetVersionId(version.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') setTargetVersionId(version.id);
                        }}
                        style={{
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '12px 14px',
                          borderRadius: 8,
                          border: `${isSelected ? 1.5 : 1}px solid ${
                            isSelected ? tc.blue : tc.borderLight
                          }`,
                          backgroundColor: isSelected ? tc.blueGhost : 'transparent',
                          transition: 'border-color 150ms, background-color 150ms',
                        }}
                      >
                        <Radio
                          value={version.id.toString()}
                          styles={{ radio: { cursor: 'pointer' } }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Text
                              style={{
                                fontSize: 14,
                                fontWeight: 500,
                                color: isSelected ? tc.text : tc.textSecondary,
                              }}
                              truncate
                            >
                              {version.name}
                            </Text>
                            {version.status !== 'Published' && (
                              <Badge size="xs" color="yellow" variant="light">
                                {version.status}
                              </Badge>
                            )}
                          </div>
                          <Text style={{ fontSize: 12, color: tc.dimmed }}>
                            {fileCount} {fileCount === 1 ? 'file' : 'files'}
                            {version.files && version.files.length > 0 && (
                              <>
                                {' \u2022 '}
                                {version.files
                                  .map((f) => getFileExtension(f.name)?.toUpperCase())
                                  .filter(Boolean)
                                  .filter((v, i, a) => a.indexOf(v) === i)
                                  .join(', ')}
                              </>
                            )}
                          </Text>
                        </div>
                        {isSelected && (
                          <div
                            style={{
                              backgroundColor: tc.blueBadgeBg,
                              color: tc.blue,
                              fontWeight: 600,
                              fontSize: 11,
                              letterSpacing: 1,
                              textTransform: 'uppercase',
                              borderRadius: 4,
                              padding: '4px 10px',
                              flexShrink: 0,
                              lineHeight: 1.4,
                            }}
                          >
                            Target
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Stack>
              </Radio.Group>
            </ScrollArea.Autosize>

            <Group justify="flex-end" gap="sm" mt="xs">
              <Button variant="default" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                disabled={!targetVersionId}
                onClick={() => setStep('map-files')}
                rightSection={<IconChevronRight size={16} />}
              >
                Next
              </Button>
            </Group>
          </Stack>
        );

      case 'map-files': {
        const totalFiles =
          (targetVersion?.files?.length ?? 0) +
          sourceVersions.reduce((sum, v) => sum + (v.files?.length ?? 0), 0);

        return (
          <Stack gap="md">
            <StepperNav currentStep={step} />

            <Text size="sm" c="dimmed">
              Configure each file&apos;s type, precision, and whether it&apos;s required. Files from
              source versions will be moved into the target.
            </Text>

            <ScrollArea.Autosize mah="calc(60vh - 14px)" offsetScrollbars>
              <Stack gap="md">
                {/* Target version */}
                {targetVersion && targetVersion.files && targetVersion.files.length > 0 && (
                  <div>
                    <Group gap={8} mb={8}>
                      <IconTarget size={16} style={{ color: tc.blue }} />
                      <Text style={{ fontSize: 13, fontWeight: 600, color: tc.text }}>
                        {targetVersion.name}
                      </Text>
                      <Badge
                        size="xs"
                        styles={{
                          root: {
                            backgroundColor: tc.blueBadgeBg,
                            color: tc.blue,
                            fontWeight: 600,
                            fontSize: 10,
                            letterSpacing: 0.5,
                            textTransform: 'uppercase',
                            borderRadius: 4,
                            padding: '2px 8px',
                          },
                        }}
                      >
                        target
                      </Badge>
                    </Group>
                    <Stack gap={6}>
                      {targetVersion.files.map((file) => (
                        <ConsolidateFileCard
                          key={file.id}
                          file={file}
                          mapping={fileTypeMappings.find((m) => m.fileId === file.id)}
                          onUpdate={(updates) => updateFileMapping(file.id, updates)}
                          modelType={model?.type}
                        />
                      ))}
                    </Stack>
                  </div>
                )}

                {/* Source versions */}
                {sourceVersions.map((version) => {
                  const files = version.files ?? [];
                  if (files.length === 0) return null;

                  return (
                    <div key={version.id}>
                      <Group gap={8} mb={8}>
                        <IconGitMerge size={16} style={{ color: tc.dimmed }} />
                        <Text style={{ fontSize: 13, fontWeight: 600, color: tc.text }}>
                          {version.name}
                        </Text>
                        <Badge
                          size="xs"
                          styles={{
                            root: {
                              backgroundColor: tc.sourceBadgeBg,
                              color: tc.dimmed,
                              fontWeight: 600,
                              fontSize: 10,
                              letterSpacing: 0.5,
                              textTransform: 'uppercase',
                              borderRadius: 4,
                              padding: '2px 8px',
                            },
                          }}
                        >
                          {files.length} {files.length === 1 ? 'file' : 'files'}
                        </Badge>
                      </Group>
                      <Stack gap={6}>
                        {files.map((file) => (
                          <ConsolidateFileCard
                            key={file.id}
                            file={file}
                            mapping={fileTypeMappings.find((m) => m.fileId === file.id)}
                            onUpdate={(updates) => updateFileMapping(file.id, updates)}
                            showRequiredToggle
                            modelType={model?.type}
                          />
                        ))}
                      </Stack>
                    </div>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>

            <Text size="xs" c="dimmed" ta="center">
              {totalFiles} {totalFiles === 1 ? 'file' : 'files'} total across all versions
            </Text>

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setStep('select-target')}>
                Back
              </Button>
              <Button
                onClick={() => setStep('confirm')}
                rightSection={<IconChevronRight size={16} />}
              >
                Next
              </Button>
            </Group>
          </Stack>
        );
      }

      case 'confirm': {
        const totalSourceFiles = sourceVersions.reduce((sum, v) => sum + (v.files?.length ?? 0), 0);
        const targetFileCount = targetVersion?.files?.length ?? 0;
        const changedCount = fileTypeMappings.filter((m) => {
          const allFiles = versions.flatMap((v) => v.files ?? []);
          const file = allFiles.find((f) => f.id === m.fileId);
          if (!file) return false;
          const typeChanged = m.type && file.type !== m.type;
          const metadataChanged =
            m.metadata &&
            Object.entries(m.metadata).some(([key, val]) => {
              if (val === undefined) return false;
              const currentVal =
                (file.metadata as Record<string, unknown> | undefined)?.[key] ?? null;
              return val !== currentVal;
            });
          return typeChanged || metadataChanged;
        }).length;

        // Show up to 3 source version names, then "+N more"
        const visibleSources = sourceVersions.slice(0, 3);
        const hiddenSourceCount = sourceVersions.length - visibleSources.length;

        return (
          <Stack gap="md">
            <StepperNav currentStep={step} />

            <Text size="sm" c="dimmed">
              Review the consolidation details before proceeding.
            </Text>

            {/* Merge visualization */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Source versions column */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: tc.dimmed,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                  }}
                >
                  Merging
                </Text>
                {visibleSources.map((v) => (
                  <div
                    key={v.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      borderRadius: 6,
                      backgroundColor: tc.cardBg,
                      border: `1px solid ${tc.border}`,
                    }}
                  >
                    <IconFile size={14} style={{ color: tc.dimmed, flexShrink: 0 }} />
                    <Text
                      style={{ fontSize: 12, fontWeight: 500, color: tc.textSecondary }}
                      truncate
                    >
                      {v.name}
                    </Text>
                  </div>
                ))}
                {hiddenSourceCount > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      padding: '6px 12px',
                    }}
                  >
                    <Text style={{ fontSize: 11, color: tc.dimmedFaint }}>
                      +{hiddenSourceCount} more {hiddenSourceCount === 1 ? 'version' : 'versions'}
                    </Text>
                  </div>
                )}
              </div>

              {/* Arrow */}
              <IconArrowRight size={24} style={{ color: tc.blue, flexShrink: 0 }} />

              {/* Target column */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Text
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: tc.blue,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                  }}
                >
                  Into
                </Text>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                    padding: 16,
                    borderRadius: 8,
                    backgroundColor: tc.blueTargetBg,
                    border: `1px solid ${tc.blueBorder}`,
                  }}
                >
                  <IconTarget size={24} style={{ color: tc.blue }} />
                  <Text style={{ fontSize: 16, fontWeight: 600, color: tc.text }}>
                    {targetVersion?.name}
                  </Text>
                  <Text style={{ fontSize: 12, color: tc.dimmed }}>Target Version</Text>
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 2,
                      padding: '10px 8px',
                      borderRadius: 6,
                      backgroundColor: tc.cardBg,
                    }}
                  >
                    <Text style={{ fontSize: 20, fontWeight: 700, color: tc.text }}>
                      {targetFileCount + totalSourceFiles}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.dimmed }}>Total files</Text>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 2,
                      padding: '10px 8px',
                      borderRadius: 6,
                      backgroundColor: tc.cardBg,
                    }}
                  >
                    <Text style={{ fontSize: 20, fontWeight: 700, color: tc.text }}>
                      {totalSourceFiles}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.dimmed }}>Files moved</Text>
                  </div>
                  {changedCount > 0 && (
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        padding: '10px 8px',
                        borderRadius: 6,
                        backgroundColor: tc.cardBg,
                      }}
                    >
                      <Text style={{ fontSize: 20, fontWeight: 700, color: tc.blue }}>
                        {changedCount}
                      </Text>
                      <Text style={{ fontSize: 10, color: tc.dimmed }}>Modified</Text>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <Checkbox
              label="Append source version descriptions to target version"
              checked={appendDescriptions}
              onChange={(e) => setAppendDescriptions(e.currentTarget.checked)}
            />

            {/* Alert banner matching design */}
            <div
              style={{
                display: 'flex',
                gap: 10,
                padding: 12,
                borderRadius: 8,
                backgroundColor: tc.redGhost,
                border: `1px solid ${tc.redBorder}`,
              }}
            >
              <IconAlertCircle size={18} style={{ color: tc.red, flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: 600, color: tc.red }}>
                  This Action is Irreversible
                </Text>
                <Text style={{ fontSize: 12, color: tc.dimmed, lineHeight: 1.4 }}>
                  The source versions will be permanently deleted. All stats (downloads, likes,
                  etc.) will be combined into the target version. This cannot be undone.
                </Text>
              </div>
            </div>

            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setStep('map-files')}>
                Back
              </Button>
              <Button color="red" onClick={handleConsolidate}>
                Consolidate Versions
              </Button>
            </Group>
          </Stack>
        );
      }
    }
  };

  return (
    <Modal
      {...dialog}
      title={
        <Group gap="xs">
          <IconGitMerge size={24} />
          <Title order={3}>Consolidate Versions</Title>
        </Group>
      }
      radius="md"
      onClose={handleClose}
      closeOnClickOutside={!consolidateMutation.isPending}
      closeOnEscape={!consolidateMutation.isPending}
      withCloseButton={!consolidateMutation.isPending}
      closeButtonProps={{ 'aria-label': 'Close consolidate versions modal' }}
      size="75%"
      withinPortal
    >
      {renderContent()}
    </Modal>
  );
}

// Small label for select fields
function SelectLabel({ children }: { children: React.ReactNode }) {
  const tc = useThemeColors();
  return (
    <Text
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: tc.selectLabel,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 4,
      }}
    >
      {children}
    </Text>
  );
}

// Shared select input styles — uses Mantine defaults which adapt to theme, with minor overrides
const selectInputStyles = {
  input: {
    borderRadius: 6,
    minHeight: 32,
    height: 32,
    fontSize: 13,
  },
};

// Filter file type options by extension (same logic as Files.tsx)
function filterByFileExtension(value: ModelFileType, fileName: string) {
  const extension = getFileExtension(fileName);
  switch (extension) {
    case 'ckpt':
    case 'safetensors':
    case 'pt':
    case 'gguf':
    case 'onnx':
      return [
        'Model',
        'Negative',
        'VAE',
        'UNet',
        'CLIPVision',
        'ControlNet',
        'Upscaler',
        'Text Encoder',
      ].includes(value);
    case 'zip':
      return ['Training Data', 'Archive', 'Model', 'Workflow'].includes(value);
    case 'yml':
    case 'yaml':
    case 'json':
      return ['Config', 'Text Encoder', 'Workflow'].includes(value);
    case 'bin':
      return ['Model', 'Negative'].includes(value);
    default:
      return true;
  }
}

// File card matching the upload screen pattern: icon + name/meta/required on left, selects on right
function ConsolidateFileCard({
  file,
  mapping,
  onUpdate,
  showRequiredToggle,
  modelType,
}: {
  file: {
    id: number;
    name: string;
    type: string;
    sizeKB: number;
    metadata?: Record<string, unknown> | null;
  };
  mapping?: FileTypeMapping;
  onUpdate: (updates: Partial<Omit<FileTypeMapping, 'fileId'>>) => void;
  showRequiredToggle?: boolean;
  modelType?: string;
}) {
  const effectiveType = (mapping?.type ?? file.type) as ModelFileType;
  const effectiveFp = (mapping?.metadata?.fp ?? file.metadata?.fp ?? null) as string | null;
  const effectiveSize = (mapping?.metadata?.size ?? file.metadata?.size ?? null) as string | null;
  const effectiveFormat = (mapping?.metadata?.format ?? file.metadata?.format ?? null) as
    | string
    | null;
  const effectiveQuantType = (mapping?.metadata?.quantType ?? file.metadata?.quantType ?? null) as
    | string
    | null;
  const effectiveIsRequired = (mapping?.metadata?.isRequired ??
    file.metadata?.isRequired ??
    false) as boolean;

  const iconConfig = getFileIconConfig(file.name, { format: effectiveFormat });
  const FileIcon = iconConfig.icon;
  const fileSizeStr = file.sizeKB ? formatKBytes(file.sizeKB) : undefined;
  const extension = getFileExtension(file.name);
  const formatLabel = effectiveFormat ?? (extension ? extension.toUpperCase() : undefined);

  const isCheckpoint =
    effectiveType === 'Model' && (modelType === 'Checkpoint' || modelType === undefined);
  const isComponentFile =
    effectiveType && (componentFileTypes as readonly string[]).includes(effectiveType);
  const showMetadataSelects = isCheckpoint || isComponentFile;
  const isGguf = file.name.endsWith('.gguf');
  const isZip = file.name.endsWith('.zip');

  const tc = useThemeColors();

  const fileTypeOptions = constants.modelFileTypes
    .filter((t) => filterByFileExtension(t, file.name))
    .map((x) => ({
      label: comfyFileTypeLabels[x] ?? (x === 'Model' && modelType ? modelType : x),
      value: x,
    }));

  return (
    <div
      style={{
        backgroundColor: tc.cardBg,
        border: `1px solid ${tc.border}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <Group gap={16} wrap="nowrap" align="center">
        {/* Left: Icon + file info + required toggle */}
        <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <ThemeIcon size={40} radius="sm" color={iconConfig.color} variant="light">
            <FileIcon size={20} />
          </ThemeIcon>
          <div style={{ minWidth: 0, flex: 1 }}>
            <Tooltip label={file.name} openDelay={300}>
              <Text style={{ fontSize: 14, fontWeight: 500, color: tc.text }} truncate>
                {file.name}
              </Text>
            </Tooltip>
            <Text style={{ fontSize: 12, color: tc.dimmed }}>
              {[fileSizeStr, formatLabel].filter(Boolean).join(' \u2022 ')}
            </Text>
            {showRequiredToggle && (
              <Switch
                size="xs"
                label="Required"
                checked={effectiveIsRequired}
                onChange={(e) => {
                  onUpdate({ metadata: { isRequired: e.currentTarget.checked } });
                }}
                mt={4}
              />
            )}
          </div>
        </Group>

        {/* Right: Selects */}
        <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }} align="flex-end">
          <div>
            <SelectLabel>Type</SelectLabel>
            <Select
              allowDeselect={false}
              size="xs"
              w={145}
              placeholder="Type"
              data={fileTypeOptions}
              value={effectiveType ?? null}
              onChange={(value) => {
                const newType = value as ModelFileType | null;
                onUpdate({
                  type: newType ?? undefined,
                  metadata: {
                    size: null,
                    fp: null,
                    isRequired: newType
                      ? (componentFileTypes as readonly string[]).includes(newType)
                      : false,
                  },
                });
              }}
              comboboxProps={{ withinPortal: true }}
              styles={selectInputStyles}
            />
          </div>

          {showMetadataSelects && (
            <>
              {isZip && (
                <div>
                  <SelectLabel>Format</SelectLabel>
                  <Select
                    allowDeselect={false}
                    size="xs"
                    w={90}
                    placeholder="Format"
                    data={zipModelFileTypes.map((x) => ({ label: x, value: x }))}
                    value={effectiveFormat}
                    onChange={(value) => {
                      onUpdate({ metadata: { format: value as ModelFileFormat | null } });
                    }}
                    comboboxProps={{ withinPortal: true }}
                    styles={selectInputStyles}
                  />
                </div>
              )}

              {isGguf ? (
                <div>
                  <SelectLabel>Quant</SelectLabel>
                  <Select
                    allowDeselect={false}
                    size="xs"
                    w={100}
                    placeholder="Quant"
                    searchable
                    data={constants.modelFileQuantTypes}
                    value={effectiveQuantType}
                    onChange={(value) => {
                      onUpdate({ metadata: { quantType: value as ModelFileQuantType | null } });
                    }}
                    comboboxProps={{ withinPortal: true }}
                    styles={selectInputStyles}
                  />
                </div>
              ) : (
                <div>
                  <SelectLabel>Precision</SelectLabel>
                  <Select
                    allowDeselect={false}
                    size="xs"
                    w={85}
                    placeholder="fp16"
                    data={constants.modelFileFp}
                    value={effectiveFp}
                    onChange={(value) => {
                      onUpdate({ metadata: { fp: value as ModelFileFp | null } });
                    }}
                    comboboxProps={{ withinPortal: true }}
                    styles={selectInputStyles}
                  />
                </div>
              )}

              {isCheckpoint && (
                <div>
                  <SelectLabel>Size</SelectLabel>
                  <Select
                    allowDeselect={false}
                    size="xs"
                    w={80}
                    placeholder="Size"
                    data={constants.modelFileSizes.map((s) => ({
                      label: startCase(s),
                      value: s,
                    }))}
                    value={effectiveSize}
                    onChange={(value) => {
                      onUpdate({ metadata: { size: value as 'full' | 'pruned' | null } });
                    }}
                    comboboxProps={{ withinPortal: true }}
                    styles={selectInputStyles}
                  />
                </div>
              )}
            </>
          )}
        </Group>
      </Group>
    </div>
  );
}
