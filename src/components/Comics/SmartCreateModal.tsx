import { ActionIcon, Alert, Button, Group, Modal, NumberInput, ScrollArea, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconArrowLeft, IconClock, IconInfoCircle, IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { AspectRatioSelector } from '~/components/Comics/AspectRatioSelector';
import { COMIC_MODEL_OPTIONS } from '~/components/Comics/comic-project-constants';
import { LayoutPicker } from '~/components/Comics/LayoutPicker';
import type { LayoutOption } from '~/components/Comics/LayoutPicker';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useComicsQueueStatus } from '~/components/Comics/hooks/useComicsQueueStatus';

interface SmartCreateModalProps {
  opened: boolean;
  onClose: () => void;
  references: { id: number; name: string }[];
  planCost: number | null;
  panelCost: number | null;
  effectiveModel: string;
  activeAspectRatios: { label: string; width: number; height: number }[];
  onModelChange: (value: string | null) => void;
  onPlanPanels: (story: string, panelCount: number | null) => void;
  isPlanningPanels: boolean;
  planError: string | null;
  plannedPanels: { prompt: string }[] | null;
  onCreateChapter: (data: {
    chapterName: string;
    storyDescription: string;
    panels: { prompt: string }[];
    aspectRatio: string;
    layoutImagePath?: string;
  }) => void;
  isCreating: boolean;
  createError: string | null;
}

export function SmartCreateModal({
  opened,
  onClose,
  references,
  planCost,
  panelCost,
  effectiveModel,
  activeAspectRatios,
  onModelChange,
  onPlanPanels,
  isPlanningPanels,
  planError,
  plannedPanels,
  onCreateChapter,
  isCreating,
  createError,
}: SmartCreateModalProps) {
  const [smartStep, setSmartStep] = useState<'input' | 'review'>('input');
  const [smartChapterName, setSmartChapterName] = useState('New Chapter');
  const [smartStory, setSmartStory] = useState('');
  const [smartPanelCount, setSmartPanelCount] = useState<number | ''>('');
  const [smartPanels, setSmartPanels] = useState<{ prompt: string }[]>([]);
  const [smartAspectRatio, setSmartAspectRatio] = useState('3:4');
  const [selectedLayout, setSelectedLayout] = useState<string | undefined>();
  const [selectedLayoutImagePath, setSelectedLayoutImagePath] = useState<string | undefined>();
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const prevPanelCountRef = useRef(0);

  // Queue status for showing warnings
  const { canGenerate, available, limit, used, isLoading: queueLoading } = useComicsQueueStatus();
  const validPanelCount = smartPanels.filter((p) => p.prompt.trim()).length;
  const needsQueueWait = validPanelCount > available && available > 0;
  const queueFull = available === 0 && !queueLoading;
  const generationDisabled = !canGenerate && available > 0 && !queueLoading;

  const resetSmartState = () => {
    setSmartStep('input');
    setSmartChapterName('New Chapter');
    setSmartStory('');
    setSmartPanelCount('');
    setSmartPanels([]);
    setSmartAspectRatio('3:4');
    setSelectedLayout(undefined);
    setSelectedLayoutImagePath(undefined);
    prevPanelCountRef.current = 0;
  };

  // When planned panels arrive, move to review step
  useEffect(() => {
    if (plannedPanels && plannedPanels.length > 0) {
      setSmartPanels(plannedPanels);
      setSmartStep('review');
    }
  }, [plannedPanels]);

  // Auto-scroll to bottom when panels are added (not on initial load from planning)
  useEffect(() => {
    if (smartPanels.length > prevPanelCountRef.current && prevPanelCountRef.current > 0) {
      // A panel was manually added — scroll to bottom after render
      requestAnimationFrame(() => {
        const viewport = scrollViewportRef.current;
        if (viewport) {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        }
      });
    }
    prevPanelCountRef.current = smartPanels.length;
  }, [smartPanels.length]);

  // Reset when modal closes
  useEffect(() => {
    if (!opened) {
      resetSmartState();
    }
  }, [opened]);

  const handleClose = () => {
    onClose();
    resetSmartState();
  };

  const handlePlanPanels = () => {
    if (!smartStory.trim()) return;
    onPlanPanels(smartStory.trim(), smartPanelCount === '' ? null : smartPanelCount);
  };

  const handleSmartCreate = () => {
    if (smartPanels.length === 0) return;
    onCreateChapter({
      chapterName: smartChapterName.trim() || 'New Chapter',
      storyDescription: smartStory.trim(),
      panels: smartPanels.filter((p) => p.prompt.trim()),
      aspectRatio: smartAspectRatio,
      layoutImagePath: selectedLayoutImagePath,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={
        smartStep === 'input' ? 'Smart Create Chapter' : `Review Panels — ${smartChapterName}`
      }
      size="lg"
    >
      {smartStep === 'input' ? (
        <Stack gap="md">
          <TextInput
            label="Chapter name"
            value={smartChapterName}
            onChange={(e) => setSmartChapterName(e.target.value)}
          />

          <MentionTextarea
            label="Describe the story or scene"
            value={smartStory}
            onChange={setSmartStory}
            references={references}
            placeholder="A warrior discovers an ancient temple... Use @Name to reference characters"
            rows={6}
          />

          <NumberInput
            label="Number of panels"
            description="Leave empty to let AI decide based on story complexity"
            placeholder="Auto (4-12)"
            value={smartPanelCount}
            onChange={(val) => setSmartPanelCount(val === '' ? '' : Number(val))}
            min={2}
            max={20}
            clampBehavior="strict"
          />

          <LayoutPicker
            value={selectedLayout}
            onChange={(layout: LayoutOption | null) => {
              setSelectedLayout(layout?.id);
              setSelectedLayoutImagePath(layout?.imagePath);
            }}
          />

          {!queueLoading && limit > 0 && (
            <Alert
              variant="light"
              color="blue"
              icon={<IconInfoCircle size={16} />}
            >
              You have {available} of {limit} queue slots available.
              {smartPanelCount !== '' && smartPanelCount > available && available > 0 && (
                <Text size="sm" mt={4}>
                  Creating {smartPanelCount} panels with {available} slots will require multiple queue
                  cycles and take longer.
                </Text>
              )}
              {smartPanelCount !== '' && smartPanelCount > available && available === 0 && (
                <Text size="sm" mt={4} c="red">
                  Your queue is currently full. Panels will be queued and processed as slots free up.
                </Text>
              )}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <BuzzTransactionButton
              buzzAmount={planCost ?? 0}
              label={planCost == null ? 'Loading cost...' : isPlanningPanels ? 'Planning...' : 'Plan Panels'}
              loading={isPlanningPanels}
              disabled={!smartStory.trim() || planCost == null}
              onPerformTransaction={handlePlanPanels}
              showPurchaseModal
            />
          </Group>

          {planError && (
            <Text size="sm" c="red">
              {planError}
            </Text>
          )}
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {smartPanels.length} panels planned
          </Text>

          <ScrollArea.Autosize mah="50vh" viewportRef={scrollViewportRef}>
            <Stack gap="sm" pr="md">
              {smartPanels.map((panel, index) => (
                <div key={index} className="flex gap-2 items-start">
                  <Text size="xs" c="dimmed" fw={600} mt={8} style={{ minWidth: 24 }}>
                    #{index + 1}
                  </Text>
                  <div className="flex-1">
                    <MentionTextarea
                      value={panel.prompt}
                      onChange={(val) => {
                        const updated = [...smartPanels];
                        updated[index] = { prompt: val };
                        setSmartPanels(updated);
                      }}
                      references={references}
                      placeholder="Panel prompt... Use @Name for references"
                      rows={2}
                    />
                  </div>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    mt={8}
                    onClick={() => setSmartPanels(smartPanels.filter((_, i) => i !== index))}
                    disabled={smartPanels.length <= 1}
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </div>
              ))}
            </Stack>
          </ScrollArea.Autosize>

          <Button
            variant="subtle"
            color="yellow"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => {
              setSmartPanels([...smartPanels, { prompt: '' }]);
            }}
          >
            Add Panel
          </Button>

          <Select
            label="Generation Model"
            data={COMIC_MODEL_OPTIONS}
            value={effectiveModel}
            onChange={onModelChange}
            size="sm"
          />
          <AspectRatioSelector
            value={smartAspectRatio}
            onChange={setSmartAspectRatio}
            aspectRatios={activeAspectRatios}
          />

          <Text size="sm" c="dimmed">
            {panelCost != null
              ? `Cost: ${smartPanels.filter((p) => p.prompt.trim()).length} panels x ${panelCost} = ${smartPanels.filter((p) => p.prompt.trim()).length * panelCost} Buzz`
              : 'Calculating cost...'}
          </Text>

          {/* Queue status warnings */}
          {generationDisabled && (
            <Alert color="red" title="Generation Unavailable" icon={<IconClock size={16} />}>
              Image generation is currently unavailable. Please try again later.
            </Alert>
          )}
          {!queueLoading && queueFull && !generationDisabled && (
            <Alert color="red" title="Queue Full" icon={<IconClock size={16} />}>
              Your generation queue is full ({used}/{limit} jobs). You need to wait for jobs to complete before creating new panels.
            </Alert>
          )}
          {!queueLoading && needsQueueWait && !queueFull && !generationDisabled && (
            <Alert color="yellow" title="Queuing Required" icon={<IconClock size={16} />}>
              You have {available} of {limit} queue slots available but want to create {validPanelCount} panels.
              Panels will be created one at a time as slots become available. This may take longer than usual.
            </Alert>
          )}

          <Group justify="space-between">
            <Button
              variant="default"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => setSmartStep('input')}
            >
              Back
            </Button>
            <BuzzTransactionButton
              buzzAmount={
                smartPanels.filter((p) => p.prompt.trim()).length * (panelCost ?? 0)
              }
              label={panelCost == null ? 'Loading cost...' : isCreating ? 'Creating...' : 'Create Chapter'}
              loading={isCreating}
              disabled={smartPanels.filter((p) => p.prompt.trim()).length === 0 || panelCost == null || generationDisabled}
              onPerformTransaction={handleSmartCreate}
              showPurchaseModal
            />
          </Group>

          {createError && (
            <Text size="sm" c="red">
              {createError}
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}
