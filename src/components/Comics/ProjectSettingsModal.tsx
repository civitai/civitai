import {
  ActionIcon,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import { IconPhoto, IconPhotoUp, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { genreOptions } from '~/components/Comics/comic-project-constants';
import { HeroPositionPicker } from '~/components/Comics/HeroPositionPicker';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import type { ComicGenre } from '~/shared/utils/prisma/enums';
import { getImageDimensions } from '~/utils/image-utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { openGeneratorImagePicker } from '~/utils/comic-image-picker';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});

interface ProjectSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  project: {
    name: string;
    description: string | null;
    genre?: string | null;
    baseModel: string | null;
    coverImage?: { id: number; url: string } | null;
    heroImage?: { id: number; url: string } | null;
    heroImagePosition?: number;
  };
  onSave: (data: {
    name?: string;
    description?: string | null;
    genre?: ComicGenre | null;
    baseModel?: string | null;
    coverUrl?: string | null;
    heroUrl?: string | null;
    heroImagePosition?: number;
  }) => void;
  onDeleteProject: () => void;
  isSaving: boolean;
}

export function ProjectSettingsModal({
  opened,
  onClose,
  project,
  onSave,
  onDeleteProject,
  isSaving,
}: ProjectSettingsModalProps) {
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const [editCoverImageId, setEditCoverImageId] = useState<number | null>(null);
  const [editGenre, setEditGenre] = useState<string | null>(null);
  const [editBaseModel, setEditBaseModel] = useState<string | null>(null);
  const [editHeroUrl, setEditHeroUrl] = useState<string | null>(null);
  const [editHeroImageId, setEditHeroImageId] = useState<number | null>(null);
  const [pickingCover, setPickingCover] = useState(false);
  const [pickingHero, setPickingHero] = useState(false);
  const [editHeroPosition, setEditHeroPosition] = useState(50);
  const { uploadToCF, files: coverUploadFiles, resetFiles: resetCoverFiles } = useCFImageUpload();
  const {
    uploadToCF: uploadHeroToCF,
    files: heroUploadFiles,
    resetFiles: resetHeroFiles,
  } = useCFImageUpload();

  // Initialize state from project when modal opens
  useEffect(() => {
    if (opened) {
      setEditName(project.name);
      setEditDescription(project.description ?? '');
      setEditGenre(project.genre ?? null);
      setEditBaseModel(project.baseModel ?? 'NanoBanana');
      setEditCoverUrl(project.coverImage?.url ?? null);
      setEditCoverImageId(project.coverImage?.id ?? null);
      setEditHeroUrl(project.heroImage?.url ?? null);
      setEditHeroImageId(project.heroImage?.id ?? null);
      setEditHeroPosition(project.heroImagePosition ?? 50);
      resetCoverFiles();
      resetHeroFiles();
    }
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCoverDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    const url = URL.createObjectURL(file);
    const { width, height } = await getImageDimensions(url);
    dialogStore.trigger({
      id: 'comic-cover-crop',
      component: ImageCropModal,
      props: {
        images: [{ url, width, height }],
        aspectRatios: ['3:4'] as `${number}:${number}`[],
        onConfirm: async (output: { src: string; cropped?: Blob }[]) => {
          const blob = output[0]?.cropped;
          const uploadFile = blob ? new File([blob], 'cover.jpg', { type: blob.type }) : file;
          const result = await uploadToCF(uploadFile);
          setEditCoverUrl(result.id);
          setEditCoverImageId(null);
          URL.revokeObjectURL(url);
        },
        onCancel: () => URL.revokeObjectURL(url),
      },
    });
  };

  const handleHeroDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadHeroToCF(files[0]);
    setEditHeroUrl(result.id);
    setEditHeroImageId(null);
  };

  const handlePickCoverFromGenerator = () =>
    openGeneratorImagePicker({
      title: 'Pick Cover from Generator',
      fileNameBase: 'cover',
      uploadFn: uploadToCF,
      onSuccess: (id) => {
        setEditCoverUrl(id);
        setEditCoverImageId(null);
      },
      onLoadingChange: setPickingCover,
      ImageSelectModal,
    });

  const handlePickHeroFromGenerator = () =>
    openGeneratorImagePicker({
      title: 'Pick Hero from Generator',
      fileNameBase: 'hero',
      uploadFn: uploadHeroToCF,
      onSuccess: (id) => {
        setEditHeroUrl(id);
        setEditHeroImageId(null);
      },
      onLoadingChange: setPickingHero,
      ImageSelectModal,
    });

  const handleSaveSettings = () => {
    onSave({
      name: editName.trim() || undefined,
      description: editDescription.trim() || null,
      genre:
        editGenre !== (project.genre ?? null) ? ((editGenre as ComicGenre) ?? null) : undefined,
      baseModel:
        editBaseModel !== (project.baseModel ?? null) ? (editBaseModel as any) ?? null : undefined,
      coverUrl: editCoverUrl !== (project.coverImage?.url ?? null) ? editCoverUrl : undefined,
      heroUrl: editHeroUrl !== (project.heroImage?.url ?? null) ? editHeroUrl : undefined,
      heroImagePosition:
        editHeroPosition !== (project.heroImagePosition ?? 50) ? editHeroPosition : undefined,
    });
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Project Settings" size="md">
      <Stack gap="md">
        <TextInput
          label="Project name"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
        />
        <Textarea
          label="Description"
          placeholder="A brief description of your comic project..."
          maxLength={5000}
          rows={3}
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
        />
        <Select
          label="Genre"
          placeholder="Select a genre"
          data={genreOptions}
          value={editGenre}
          onChange={setEditGenre}
          clearable
        />
        <Select
          label="Generation Model"
          description="Choose the AI model for panel generation"
          data={[
            { value: 'NanoBanana', label: 'Nano Banana Pro (Default)' },
            { value: 'Flux2', label: 'Flux.2' },
            { value: 'Seedream', label: 'Seedream v4.5' },
            { value: 'OpenAI', label: 'OpenAI GPT-Image' },
            { value: 'Qwen', label: 'Qwen' },
          ]}
          value={editBaseModel}
          onChange={setEditBaseModel}
        />

        <div>
          <Text size="sm" fw={500} mb={4}>
            Cover Image
          </Text>
          <Text size="xs" c="dimmed" mb={8}>
            Portrait image shown in cards and chapter lists (3:4 ratio recommended)
          </Text>
          {editCoverUrl ? (
            <div className="relative inline-block">
              <div
                className="rounded-lg overflow-hidden"
                style={{ width: 120, height: 160, background: '#2C2E33' }}
              >
                <img
                  src={getEdgeUrl(editCoverUrl, { width: 240 })}
                  alt="Cover"
                  className="w-full h-full object-cover"
                />
              </div>
              <ActionIcon
                variant="filled"
                color="dark"
                size="xs"
                className="absolute -top-2 -right-2"
                onClick={() => {
                  setEditCoverUrl(null);
                  setEditCoverImageId(null);
                }}
              >
                <IconX size={12} />
              </ActionIcon>
            </div>
          ) : (
            <Stack gap={4}>
              <Dropzone onDrop={handleCoverDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
                <Group justify="center" gap="xl" mih={80} style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept>
                    <IconUpload size={24} className="text-blue-500" />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={24} className="text-red-500" />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconPhoto size={24} style={{ color: '#909296' }} />
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed">
                    Drop a cover image or click to browse
                  </Text>
                </Group>
              </Dropzone>
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={<IconPhotoUp size={14} />}
                onClick={handlePickCoverFromGenerator}
                loading={pickingCover}
              >
                Pick from generator
              </Button>
            </Stack>
          )}
          {coverUploadFiles.some((f) => f.status === 'uploading') && (
            <Text size="xs" c="dimmed" mt={4}>
              Uploading...
            </Text>
          )}
        </div>

        <div>
          <Text size="sm" fw={500} mb={4}>
            Hero Image
          </Text>
          <Text size="xs" c="dimmed" mb={8}>
            Wide banner shown on the comic overview page (16:9 or wider recommended)
          </Text>
          {editHeroUrl ? (
            <HeroPositionPicker
              url={editHeroUrl}
              position={editHeroPosition}
              onPositionChange={setEditHeroPosition}
              onRemove={() => {
                setEditHeroUrl(null);
                setEditHeroImageId(null);
                setEditHeroPosition(50);
              }}
            />
          ) : (
            <Stack gap={4}>
              <Dropzone onDrop={handleHeroDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
                <Group justify="center" gap="xl" mih={80} style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept>
                    <IconUpload size={24} className="text-blue-500" />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={24} className="text-red-500" />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconPhoto size={24} style={{ color: '#909296' }} />
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed">
                    Drop a hero banner or click to browse
                  </Text>
                </Group>
              </Dropzone>
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={<IconPhotoUp size={14} />}
                onClick={handlePickHeroFromGenerator}
                loading={pickingHero}
              >
                Pick from generator
              </Button>
            </Stack>
          )}
          {heroUploadFiles.some((f) => f.status === 'uploading') && (
            <Text size="xs" c="dimmed" mt={4}>
              Uploading...
            </Text>
          )}
        </div>

        <Group justify="space-between">
          <Button
            variant="subtle"
            color="red"
            size="compact-sm"
            leftSection={<IconTrash size={14} />}
            onClick={() => {
              onClose();
              openConfirmModal({
                title: 'Delete Project',
                children:
                  'Are you sure you want to delete this comic project? This action cannot be undone.',
                labels: { confirm: 'Delete', cancel: 'Cancel' },
                confirmProps: { color: 'red' },
                onConfirm: onDeleteProject,
              });
            }}
          >
            Delete Project
          </Button>
          <Group>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <button
              className={styles.gradientBtn}
              onClick={handleSaveSettings}
              disabled={!editName.trim()}
            >
              Save
            </button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
