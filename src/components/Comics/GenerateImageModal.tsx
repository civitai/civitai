import {
  ActionIcon,
  Button,
  Group,
  Loader,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import {
  IconCheck,
  IconRefresh,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import type { WorkflowStepEvent } from '@civitai/client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { COMIC_MODEL_OPTIONS } from '~/components/Comics/comic-project-constants';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { SignalMessages } from '~/server/common/enums';
import { getImageDimensions } from '~/utils/image-utils';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ReferenceImage = { url: string; previewUrl: string; width: number; height: number };

type GenerateImageModalProps = {
  opened: boolean;
  onClose: () => void;
  /** Aspect ratio preset, e.g. '3:4' for cover, '16:9' for hero */
  aspectRatio: string;
  /** Label shown in the modal title */
  label: string;
  /** Called with the CF/S3 image URL when user confirms */
  onConfirm: (imageUrl: string) => void;
};

export function GenerateImageModal({
  opened,
  onClose,
  aspectRatio,
  label,
  onConfirm,
}: GenerateImageModalProps) {
  const availableBuzzTypes = useAvailableBuzz(['blue']);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('NanoBanana');
  const [quantity, setQuantity] = useState(4);
  const [resultImages, setResultImages] = useState<{ url: string; id?: number }[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [references, setReferences] = useState<ReferenceImage[]>([]);

  const activeWorkflowId = useRef<string | null>(null);
  const pollDims = useRef<{ width: number; height: number }>({ width: 512, height: 512 });
  const utils = trpc.useUtils();
  const { uploadToCF, files: uploadFiles } = useCFImageUpload();
  const uploading = uploadFiles.some((f) => f.status === 'uploading');

  const generateMutation = trpc.comics.generateComicImage.useMutation({
    onError: (error) => {
      setIsGenerating(false);
      activeWorkflowId.current = null;
      showErrorNotification({ error, title: 'Failed to generate image' });
    },
  });

  const { data: costEstimate } = trpc.comics.getGenerationCostEstimate.useQuery(
    {
      baseModel: model,
      aspectRatio,
      quantity,
      userReferenceImages: references.map((r) => ({
        url: r.url,
        width: r.width,
        height: r.height,
      })),
    },
    { staleTime: 30_000, enabled: opened }
  );

  // Poll once to fetch and persist the result image
  const doPollOnce = useCallback(async () => {
    const wfId = activeWorkflowId.current;
    if (!wfId) return;

    try {
      const result = await utils.comics.pollIterationStatus.fetch({
        workflowId: wfId,
        width: pollDims.current.width,
        height: pollDims.current.height,
        prompt,
      });

      if (result.status === 'succeeded' && result.images && result.images.length > 0) {
        setResultImages(result.images);
        setSelectedIdx(0);
        setIsGenerating(false);
        activeWorkflowId.current = null;
      } else if (result.status === 'failed') {
        setIsGenerating(false);
        activeWorkflowId.current = null;
        showErrorNotification({
          title: 'Generation failed',
          error: new Error('The image generator returned an error. Please try again.'),
        });
      }
      // If still processing, signal will fire again
    } catch {
      // Transient error — signal will re-trigger
    }
  }, [utils, prompt]);

  // Listen for workflow completion via signals
  useSignalConnection(
    SignalMessages.TextToImageUpdate,
    useCallback(
      (data: Omit<WorkflowStepEvent, '$type'> & { $type: string }) => {
        if (data.$type !== 'step') return;
        if (!activeWorkflowId.current || data.workflowId !== activeWorkflowId.current) return;
        if (data.status === 'succeeded' || data.status === 'failed') {
          void doPollOnce();
        }
      },
      [doPollOnce]
    )
  );

  // Fallback polling in case signal is missed
  useEffect(() => {
    if (!isGenerating || !activeWorkflowId.current) return;
    const timer = setInterval(() => void doPollOnce(), 10_000);
    return () => clearInterval(timer);
  }, [isGenerating, doPollOnce]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setResultImages([]);

    const result = await generateMutation.mutateAsync({
      prompt: prompt.trim(),
      aspectRatio,
      baseModel: model,
      quantity,
      userReferenceImages:
        references.length > 0
          ? references.map((r) => ({ url: r.url, width: r.width, height: r.height }))
          : undefined,
    });

    activeWorkflowId.current = result.workflowId;
    pollDims.current = { width: result.width, height: result.height };
  };

  const selectedUrl = resultImages[selectedIdx]?.url ?? null;

  const handleConfirm = () => {
    if (!selectedUrl) return;
    onConfirm(selectedUrl);
    handleReset();
    onClose();
  };

  const handleReset = () => {
    activeWorkflowId.current = null;
    setResultImages([]);
    setSelectedIdx(0);
    setIsGenerating(false);
  };

  // Reference image management
  const handleRefDrop = async (files: File[]) => {
    for (const file of files) {
      try {
        const result = await uploadToCF(file);
        const objectUrl = URL.createObjectURL(file);
        const dims = await getImageDimensions(objectUrl);
        URL.revokeObjectURL(objectUrl);
        setReferences((prev) => [
          ...prev,
          {
            url: result.id,
            previewUrl: getEdgeUrl(result.id, { width: 100 }) ?? result.id,
            width: dims.width,
            height: dims.height,
          },
        ]);
      } catch (err) {
        showErrorNotification({ error: err as Error, title: 'Failed to upload reference' });
      }
    }
  };

  const removeReference = (idx: number) => {
    setReferences((prev) => prev.filter((_, i) => i !== idx));
  };

  const cost = costEstimate?.cost ?? 25;

  return (
    <Modal opened={opened} onClose={onClose} title={`Generate ${label}`} size="md" centered>
      <Stack gap="md">
        <Textarea
          label="Prompt"
          placeholder={`Describe the ${label.toLowerCase()} you want to generate...`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          disabled={isGenerating}
        />

        <Select
          label="Model"
          data={COMIC_MODEL_OPTIONS}
          value={model}
          onChange={(v) => v && setModel(v)}
          size="sm"
          disabled={isGenerating}
        />

        {/* Reference images */}
        <div>
          <Text size="sm" fw={500} mb={4}>
            Reference Images
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            Optional — upload images to guide the style or content
          </Text>
          <Group gap="xs" wrap="wrap">
            {references.map((ref, idx) => (
              <div key={idx} className="relative" style={{ width: 60, height: 60 }}>
                <img
                  src={ref.previewUrl}
                  alt={`Ref ${idx + 1}`}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    borderRadius: 'var(--mantine-radius-sm)',
                  }}
                />
                <ActionIcon
                  variant="filled"
                  color="dark"
                  size="xs"
                  className="absolute -top-1 -right-1"
                  onClick={() => removeReference(idx)}
                >
                  <IconX size={10} />
                </ActionIcon>
              </div>
            ))}
            {!isGenerating && (
              <Dropzone
                onDrop={handleRefDrop}
                accept={IMAGE_MIME_TYPE}
                multiple
                p={0}
                style={{
                  width: 60,
                  height: 60,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--mantine-radius-sm)',
                }}
              >
                {uploading ? (
                  <Loader size="xs" />
                ) : (
                  <Tooltip label="Upload reference image">
                    <IconUpload size={16} style={{ color: '#909296' }} />
                  </Tooltip>
                )}
              </Dropzone>
            )}
          </Group>
        </div>

        {/* Quantity selector */}
        <NumberInput
          label="Number of images"
          value={quantity}
          onChange={(val) => setQuantity(typeof val === 'number' ? val : 4)}
          min={1}
          max={4}
          clampBehavior="blur"
          size="sm"
          disabled={isGenerating}
          description="Generate up to 4 options to choose from"
        />

        {/* Result preview */}
        {isGenerating && resultImages.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
              borderRadius: 'var(--mantine-radius-md)',
              background: 'var(--mantine-color-dark-6)',
            }}
          >
            <Stack align="center" gap="xs">
              <Loader size="md" color="yellow" />
              <Text size="sm" c="dimmed">
                Generating {quantity} image{quantity > 1 ? 's' : ''}...
              </Text>
            </Stack>
          </div>
        )}

        {resultImages.length > 0 && (
          <div>
            {resultImages.length === 1 ? (
              <div
                style={{
                  borderRadius: 'var(--mantine-radius-md)',
                  overflow: 'hidden',
                  background: 'var(--mantine-color-dark-6)',
                }}
              >
                <img
                  src={getEdgeUrl(resultImages[0].url, { width: 600 })}
                  alt="Generated result"
                  style={{ width: '100%', display: 'block' }}
                />
              </div>
            ) : (
              <>
                {/* Selected image large preview */}
                <div
                  style={{
                    borderRadius: 'var(--mantine-radius-md)',
                    overflow: 'hidden',
                    background: 'var(--mantine-color-dark-6)',
                    marginBottom: 8,
                  }}
                >
                  <img
                    src={getEdgeUrl(selectedUrl!, { width: 600 })}
                    alt="Selected result"
                    style={{ width: '100%', display: 'block' }}
                  />
                </div>
                {/* Thumbnail grid */}
                <Group gap="xs">
                  {resultImages.map((img, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedIdx(idx)}
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 'var(--mantine-radius-sm)',
                        overflow: 'hidden',
                        border:
                          idx === selectedIdx
                            ? '2px solid var(--mantine-color-blue-5)'
                            : '2px solid transparent',
                        padding: 0,
                        cursor: 'pointer',
                        background: 'var(--mantine-color-dark-6)',
                        position: 'relative',
                      }}
                    >
                      <img
                        src={getEdgeUrl(img.url, { width: 100 })}
                        alt={`Option ${idx + 1}`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                      {idx === selectedIdx && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 2,
                            right: 2,
                            background: 'var(--mantine-color-blue-5)',
                            borderRadius: '50%',
                            width: 18,
                            height: 18,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <IconCheck size={12} color="white" />
                        </div>
                      )}
                    </button>
                  ))}
                </Group>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          {resultImages.length > 0 ? (
            <>
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                onClick={handleReset}
              >
                Regenerate
              </Button>
              <Button
                color="blue"
                leftSection={<IconCheck size={16} />}
                onClick={handleConfirm}
              >
                Use as {label}
              </Button>
            </>
          ) : (
            <BuzzTransactionButton
              buzzAmount={cost}
              accountTypes={availableBuzzTypes}
              label={isGenerating ? 'Generating...' : 'Generate'}
              loading={isGenerating}
              disabled={!prompt.trim() || isGenerating || costEstimate == null}
              onPerformTransaction={handleGenerate}
              showPurchaseModal
            />
          )}
        </div>
      </Stack>
    </Modal>
  );
}
