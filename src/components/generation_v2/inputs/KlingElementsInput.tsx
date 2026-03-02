/**
 * KlingElementsInput
 *
 * Input component for Kling V3 multi-shot elements.
 * Each element has optional media (up to 4 images + 1 video) and an optional prompt.
 * A segment can be media-only, prompt-only, or both.
 *
 * - "Add Element" opens a modal with a Mantine Dropzone for images/video + a prompt textarea
 * - First image = frontalImage, images 2–4 = referenceImages
 * - Prompt is editable inline on the element card after creation
 */

import {
  ActionIcon,
  Button,
  Group,
  Input,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useDisclosure } from '@mantine/hooks';
import {
  IconPhoto,
  IconPlus,
  IconTrash,
  IconUpload,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import type z from 'zod';
import type { klingV3ElementSchema } from '~/shared/data-graph/generation/kling-graph';
import { maxVideoFileSize } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { formatBytes } from '~/utils/number-helpers';
import type { ImageValue } from './ImageUploadMultipleInput';
import type { VideoValue } from './VideoInput';

// =============================================================================
// Types
// =============================================================================

type KlingV3Element = z.infer<typeof klingV3ElementSchema>;

export interface KlingElementsInputProps {
  value: KlingV3Element[];
  onChange: (value: KlingV3Element[]) => void;
}

// =============================================================================
// Draft state
// images[0] = frontalImage, images[1–3] = referenceImages (up to 4 total)
// =============================================================================

interface DraftElement {
  images: ImageValue[];
  videoUrl: VideoValue | undefined;
  prompt: string;
}

const emptyDraft = (): DraftElement => ({ images: [], videoUrl: undefined, prompt: '' });

// =============================================================================
// Helpers
// =============================================================================

function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new globalThis.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

// =============================================================================
// Element Modal
// =============================================================================

interface KlingElementModalProps {
  opened: boolean;
  onClose: () => void;
  onSubmit: (draft: DraftElement) => void;
  hasVideoElement: boolean;
}

function KlingElementModal({ opened, onClose, onSubmit, hasVideoElement }: KlingElementModalProps) {
  const [draft, setDraft] = useState<DraftElement>(emptyDraft);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canSubmit = draft.images.length > 0 || !!draft.videoUrl || !!draft.prompt.trim();
  const imagesMaxed = draft.images.length >= 4;
  const videoMaxed = !!draft.videoUrl || hasVideoElement;
  const dropzoneDisabled = isUploading || (imagesMaxed && videoMaxed);

  const handleDrop = async (files: File[]) => {
    setUploadError(null);
    setIsUploading(true);
    try {
      for (const file of files) {
        if (file.type.startsWith('video/')) {
          if (videoMaxed) continue;
          if (file.size > maxVideoFileSize) {
            setUploadError(`Video must be smaller than ${formatBytes(maxVideoFileSize)}`);
            continue;
          }
          const blob = await uploadConsumerBlob(file);
          if (blob.blockedReason || !blob.available || !blob.url) {
            setUploadError(blob.blockedReason ?? 'Video upload failed');
            continue;
          }
          setDraft((d) => ({ ...d, videoUrl: { url: blob.url! } }));
        } else {
          if (imagesMaxed) continue;
          const blob = await uploadConsumerBlob(file);
          if (blob.blockedReason || !blob.available || !blob.url) {
            setUploadError(blob.blockedReason ?? 'Image upload failed');
            continue;
          }
          const dims = await getImageDimensions(blob.url!);
          const newImage: ImageValue = { url: blob.url!, width: dims.width, height: dims.height };
          setDraft((d) =>
            d.images.length < 4 ? { ...d, images: [...d.images, newImage] } : d
          );
        }
      }
    } finally {
      setIsUploading(false);
    }
  };

  const removeImage = (index: number) => {
    setDraft((d) => ({ ...d, images: d.images.filter((_, i) => i !== index) }));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit(draft);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Add Element" size="md">
      <Stack gap="md">
        {/* Media thumbnails */}
        {(draft.images.length > 0 || draft.videoUrl) && (
          <div className="flex flex-wrap gap-2">
            {draft.images.map((img, i) => (
              <div
                key={img.url}
                className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded border border-solid border-gray-3 dark:border-dark-4"
              >
                <img src={img.url} alt={`Image ${i + 1}`} className="h-full w-full object-cover" />
                <div className="absolute bottom-0 left-0 right-0 bg-black/50 py-0.5 text-center text-[9px] text-white">
                  {i === 0 ? 'Frontal' : `Ref ${i}`}
                </div>
                <ActionIcon
                  size="xs"
                  variant="filled"
                  color="red"
                  radius="xl"
                  className="absolute right-0.5 top-0.5"
                  onClick={() => removeImage(i)}
                >
                  <IconX size={8} />
                </ActionIcon>
              </div>
            ))}
            {draft.videoUrl && (
              <div className="bg-dark-6 relative flex h-16 w-16 flex-shrink-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded border border-solid border-gray-3 dark:border-dark-4">
                <IconVideo size={20} />
                <Text size="xs" c="dimmed" className="max-w-[56px] truncate text-[9px]">
                  video
                </Text>
                <ActionIcon
                  size="xs"
                  variant="filled"
                  color="red"
                  radius="xl"
                  className="absolute right-0.5 top-0.5"
                  onClick={() => setDraft((d) => ({ ...d, videoUrl: undefined }))}
                >
                  <IconX size={8} />
                </ActionIcon>
              </div>
            )}
          </div>
        )}

        {/* Dropzone — hidden once images (4) and video are all set */}
        {!dropzoneDisabled && (
          <Dropzone
            onDrop={handleDrop}
            accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
            multiple
            disabled={dropzoneDisabled}
          >
            <div className="flex flex-col items-center gap-2 py-6">
              {isUploading ? (
                <Loader size="md" />
              ) : (
                <>
                  <Dropzone.Accept>
                    <IconUpload size={32} stroke={1.5} />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={32} stroke={1.5} />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <div className="flex gap-1">
                      <IconPhoto size={32} stroke={1.5} />
                      <IconVideo size={32} stroke={1.5} />
                    </div>
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed" ta="center">
                    Upload images or video
                  </Text>
                  <Text size="xs" c="dimmed" ta="center">
                    {!imagesMaxed && `Up to ${4 - draft.images.length} image${4 - draft.images.length !== 1 ? 's' : ''}`}
                    {!imagesMaxed && !videoMaxed && ' · '}
                    {!videoMaxed && 'MP4 video'}
                  </Text>
                </>
              )}
            </div>
          </Dropzone>
        )}

        {uploadError && (
          <Text size="xs" c="red">
            {uploadError}
          </Text>
        )}

        {/* Prompt */}
        <Textarea
          label="Prompt"
          placeholder="Describe what happens in this segment..."
          value={draft.prompt}
          onChange={(e) => {
            const prompt = e.currentTarget.value;
            setDraft((d) => ({ ...d, prompt }));
          }}
          autosize
          minRows={2}
        />

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            Add Element
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Element Card
// =============================================================================

interface KlingElementCardProps {
  element: KlingV3Element;
  index: number;
  onPromptChange: (prompt: string) => void;
  onRemove: () => void;
}

function KlingElementCard({ element, index, onPromptChange, onRemove }: KlingElementCardProps) {
  const mediaCount =
    (element.frontalImage ? 1 : 0) +
    (element.referenceImages?.length ?? 0) +
    (element.videoUrl ? 1 : 0);

  return (
    <div className="bg-gray-0 dark:bg-dark-6 flex flex-col gap-2 rounded-md border border-solid border-gray-3 p-3 dark:border-dark-4">
      <div className="flex items-start justify-between">
        <div>
          <Text size="sm" fw={500}>
            Element {index + 1}
          </Text>
          {mediaCount > 0 && (
            <Text size="xs" c="dimmed">
              {mediaCount} media file{mediaCount !== 1 ? 's' : ''}
              {element.videoUrl ? ' · includes video' : ''}
            </Text>
          )}
        </div>
        <ActionIcon variant="subtle" color="red" size="sm" onClick={onRemove}>
          <IconTrash size={14} />
        </ActionIcon>
      </div>

      {/* Inline prompt editing */}
      <Textarea
        placeholder="Describe what happens in this segment..."
        value={element.prompt ?? ''}
        onChange={(e) => onPromptChange(e.currentTarget.value)}
        autosize
        minRows={2}
        size="xs"
      />
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function KlingElementsInput({ value, onChange }: KlingElementsInputProps) {
  const elements = value ?? [];
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  const hasVideoElement = elements.some((el) => !!el.videoUrl);

  const handleModalSubmit = (draft: DraftElement) => {
    const newElement: KlingV3Element = {
      frontalImage: draft.images[0] ?? undefined,
      referenceImages: draft.images.length > 1 ? draft.images.slice(1) : undefined,
      videoUrl: draft.videoUrl ?? null,
      prompt: draft.prompt.trim() || undefined,
    };
    onChange([...elements, newElement]);
  };

  const removeElement = (index: number) => {
    onChange(elements.filter((_, i) => i !== index));
  };

  const updatePrompt = (index: number, prompt: string) => {
    onChange(
      elements.map((el, i) => (i === index ? { ...el, prompt: prompt.trim() || undefined } : el))
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Input.Label>Multi-Shot Elements</Input.Label>
      {elements.length === 0 && (
        <Text size="sm" c="dimmed">
          Add elements to generate a multi-shot video. Each element defines one segment.
        </Text>
      )}
      <Stack gap="xs">
        {elements.map((element, index) => (
          <KlingElementCard
            key={index}
            element={element}
            index={index}
            onPromptChange={(p) => updatePrompt(index, p)}
            onRemove={() => removeElement(index)}
          />
        ))}
      </Stack>
      <Button
        variant="light"
        size="xs"
        leftSection={<IconPlus size={14} />}
        onClick={openModal}
        disabled={elements.length >= 5}
      >
        Add Element
      </Button>

      <KlingElementModal
        opened={modalOpened}
        onClose={closeModal}
        onSubmit={handleModalSubmit}
        hasVideoElement={hasVideoElement}
      />
    </div>
  );
}
