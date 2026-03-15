import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Image,
  Loader,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconGripVertical,
  IconPencil,
  IconPhoto,
  IconTrash,
  IconUpload,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { fetchAndUploadGeneratorImage } from '~/utils/comic-image-picker';
import { fetchBlob } from '~/utils/file-utils';

const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.comicCreator) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: '/login?returnUrl=/comics',
          permanent: false,
        },
      };
    }
  },
});

function SortableRefImage({ id, children }: { id: number; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        position: 'relative',
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function ReferenceUpload() {
  const router = useRouter();
  const { id } = router.query;
  const projectId = Number(id);

  const [referenceName, setReferenceName] = useState('');
  const [referenceType, setReferenceType] = useState<string>('Character');

  // Upload flow state
  const [images, setImages] = useState<
    { file: File; preview: string; width: number; height: number }[]
  >([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const { uploadToCF: uploadImageToCF } = useCFImageUpload();

  const { data: project, refetch: refetchProject } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: projectId > 0 }
  );

  const utils = trpc.useUtils();
  const createReferenceMutation = trpc.comics.createReference.useMutation();
  const addImagesMutation = trpc.comics.addReferenceImages.useMutation({
    onSuccess: () => {
      utils.comics.getProject.invalidate({ id: projectId });
      router.push(`/comics/project/${projectId}`);
    },
  });

  const handleDrop = (files: File[]) => {
    for (const file of files) {
      const preview = URL.createObjectURL(file);
      const img = new window.Image();
      img.src = preview;
      img.onload = () => {
        setImages((prev) =>
          [...prev, { file, preview, width: img.naturalWidth, height: img.naturalHeight }].slice(
            0,
            10
          )
        );
      };
      img.onerror = () => {
        setImages((prev) => [...prev, { file, preview, width: 512, height: 512 }].slice(0, 10));
      };
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].preview);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (images.length === 0 || !referenceName.trim()) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // 1. Upload images to CloudFlare
      const uploadedImages: { url: string; width: number; height: number }[] = [];
      for (let i = 0; i < images.length; i++) {
        setUploadProgress(Math.round(((i + 1) / images.length) * 70));
        const result = await uploadImageToCF(images[i].file);
        uploadedImages.push({
          url: result.id,
          width: images[i].width,
          height: images[i].height,
        });
      }

      setUploadProgress(80);

      // 2. Create reference
      const reference = await createReferenceMutation.mutateAsync({
        name: referenceName.trim(),
        type: referenceType as any,
      });

      setUploadProgress(90);

      // 3. Add images to reference
      await addImagesMutation.mutateAsync({
        referenceId: reference.id,
        images: uploadedImages,
      });

      setUploadProgress(100);
      setIsUploading(false);
    } catch (error) {
      console.error('Upload failed:', error);
      setIsUploading(false);
    }
  };

  // Existing reference view
  const characterIdParam = router.query.characterId as string | undefined;
  const characterId = characterIdParam ? Number(characterIdParam) : undefined;
  const existingReference =
    characterId != null && !isNaN(characterId)
      ? project?.references?.find((c) => c.id === characterId)
      : undefined;

  // Reference image management state for existing references
  const [showUploadArea, setShowUploadArea] = useState(false);
  const { uploadToCF, files: uploadingFiles, resetFiles } = useCFImageUpload();
  const [uploadedImages, setUploadedImages] = useState<
    { url: string; previewUrl: string; width: number; height: number }[]
  >([]);

  const addMoreImagesMutation = trpc.comics.addReferenceImages.useMutation({
    onMutate: async ({ referenceId, images: newImages }) => {
      await utils.comics.getProject.cancel({ id: projectId });
      utils.comics.getProject.setData({ id: projectId }, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          references: prev.references.map((ref) => {
            if (ref.id !== referenceId) return ref;
            const existingImages = ref.images ?? [];
            const placeholders = newImages.map((img, i) => ({
              image: {
                id: -Date.now() - i,
                url: img.url,
                width: img.width,
                height: img.height,
              },
              position: existingImages.length + i,
            }));
            return { ...ref, images: [...existingImages, ...placeholders] } as typeof ref;
          }),
        };
      });
    },
    onSuccess: () => {
      setShowUploadArea(false);
      setUploadedImages([]);
      resetFiles();
      refetchProject();
    },
    onError: () => refetchProject(),
  });

  const [deletingImageId, setDeletingImageId] = useState<number | null>(null);
  const deleteRefImageMutation = trpc.comics.deleteReferenceImage.useMutation({
    onMutate: async ({ referenceId, imageId }) => {
      await utils.comics.getProject.cancel({ id: projectId });
      utils.comics.getProject.setData({ id: projectId }, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          references: prev.references.map((ref) =>
            ref.id === referenceId
              ? { ...ref, images: (ref.images ?? []).filter((ri) => ri.image.id !== imageId) }
              : ref
          ),
        };
      });
    },
    onSuccess: () => {
      setDeletingImageId(null);
      refetchProject();
    },
    onError: () => {
      setDeletingImageId(null);
      refetchProject();
    },
  });

  const reorderRefImagesMutation = trpc.comics.reorderReferenceImages.useMutation({
    onError: () => refetchProject(),
  });

  // Inline rename state
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const updateReferenceMutation = trpc.comics.updateReference.useMutation({
    onSuccess: () => {
      setIsEditingName(false);
      utils.comics.getProject.invalidate({ id: projectId });
    },
  });

  const handleStartRename = () => {
    if (!existingReference) return;
    setEditName(existingReference.name);
    setIsEditingName(true);
  };

  const handleSaveRename = () => {
    if (!existingReference) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed.length > 255 || trimmed.includes('@')) return;
    if (trimmed === existingReference.name) {
      setIsEditingName(false);
      return;
    }
    updateReferenceMutation.mutate({ referenceId: existingReference.id, name: trimmed });
  };

  const handleCancelRename = () => {
    setIsEditingName(false);
  };

  const refImageSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleRefImageDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !existingReference) return;
    const refImages = existingReference.images ?? [];
    const oldIndex = refImages.findIndex((ri) => ri.image.id === active.id);
    const newIndex = refImages.findIndex((ri) => ri.image.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedImages = arrayMove(refImages, oldIndex, newIndex);
    const newOrder = reorderedImages.map((ri) => ri.image.id);

    // Optimistic update
    utils.comics.getProject.setData({ id: projectId }, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        references: prev.references.map((ref) =>
          ref.id === existingReference.id
            ? { ...ref, images: reorderedImages.map((ri, i) => ({ ...ri, position: i })) }
            : ref
        ),
      };
    });

    reorderRefImagesMutation.mutate({
      referenceId: existingReference.id,
      imageIds: newOrder,
    });
  };

  const handleUrlDrop = async (e: React.DragEvent, onFiles: (files: File[]) => void) => {
    const url = e.dataTransfer.getData('text/uri-list');
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    const blob = await fetchBlob(url);
    if (!blob) return;
    const urlPath = url.split('?')[0]; // strip query params
    const file = new File([blob], urlPath.substring(urlPath.lastIndexOf('/')), {
      type: blob.type,
    });
    onFiles([file]);
  };

  const handleRefImageDrop = async (files: File[]) => {
    for (const file of files) {
      const result = await uploadToCF(file);
      const img = new window.Image();
      img.src = result.objectUrl;
      await new Promise<void>((resolve) => {
        img.onload = () => {
          setUploadedImages((prev) => [
            ...prev,
            {
              url: result.id,
              previewUrl: result.objectUrl,
              width: img.naturalWidth,
              height: img.naturalHeight,
            },
          ]);
          resolve();
        };
        img.onerror = () => {
          setUploadedImages((prev) => [
            ...prev,
            { url: result.id, previewUrl: result.objectUrl, width: 512, height: 512 },
          ]);
          resolve();
        };
      });
    }
  };

  const handleSaveUploadedRefs = () => {
    if (!existingReference || uploadedImages.length === 0) return;
    addMoreImagesMutation.mutate({
      referenceId: existingReference.id,
      images: uploadedImages,
    });
  };

  // If characterId is in URL but reference not found, show not-found state
  if (characterId && !existingReference && project) {
    return (
      <>
        <Meta title={`Reference Not Found - ${project?.name} - Civitai Comics`} deIndex={true} />
        <Container size="md" py="xl">
          <Stack gap="xl">
            <Group>
              <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                <IconArrowLeft size={20} />
              </ActionIcon>
              <Title order={2}>Reference Not Found</Title>
            </Group>
            <Card withBorder p="xl">
              <Stack align="center" gap="lg">
                <IconAlertTriangle size={40} className="text-yellow-500" />
                <Text size="sm" c="dimmed">This reference could not be found.</Text>
                <Button component={Link} href={`/comics/project/${projectId}`}>
                  Back to Project
                </Button>
              </Stack>
            </Card>
          </Stack>
        </Container>
      </>
    );
  }

  // If reference already exists, show status + ref image management
  if (existingReference) {
    const isFailed = existingReference.status === 'Failed';
    const refImages = existingReference.images ?? [];
    const hasRefs = refImages.length > 0;

    return (
      <>
        <Meta title={`Reference - ${project?.name} - Civitai Comics`} deIndex={true} />

        <Container size="md" py="xl">
          <Stack gap="xl">
            <Group>
              <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                <IconArrowLeft size={20} />
              </ActionIcon>
              <Title order={2}>Reference</Title>
            </Group>

            <Card withBorder p="xl">
              <Stack align="center" gap="lg">
                <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center overflow-hidden">
                  {isFailed ? (
                    <IconAlertTriangle size={40} className="text-red-500" />
                  ) : hasRefs ? (
                    <EdgeMedia2
                      src={refImages[0].image.url}
                      type="image"
                      name={existingReference.name}
                      alt={existingReference.name}
                      width={96}
                      style={{ width: 96, height: 96, objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <IconPhoto size={40} className="text-gray-500" />
                  )}
                </div>

                <div className="text-center">
                  <Group justify="center" gap="xs">
                    {isEditingName ? (
                      <Group gap={4}>
                        <TextInput
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename();
                            if (e.key === 'Escape') handleCancelRename();
                          }}
                          onBlur={handleSaveRename}
                          size="md"
                          autoFocus
                          error={
                            editName.includes('@')
                              ? 'Name cannot contain @ character'
                              : editName.trim().length === 0
                              ? 'Name is required'
                              : editName.trim().length > 255
                              ? 'Name must be 255 characters or less'
                              : undefined
                          }
                          styles={{ input: { textAlign: 'center' } }}
                        />
                        <ActionIcon
                          variant="subtle"
                          color="green"
                          onMouseDown={(e: React.MouseEvent) => {
                            e.preventDefault();
                            handleSaveRename();
                          }}
                          loading={updateReferenceMutation.isPending}
                        >
                          <IconCheck size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          onMouseDown={(e: React.MouseEvent) => {
                            e.preventDefault();
                            handleCancelRename();
                          }}
                        >
                          <IconX size={16} />
                        </ActionIcon>
                      </Group>
                    ) : (
                      <>
                        <Text fw={500} size="lg">
                          {existingReference.name}
                        </Text>
                        <ActionIcon variant="subtle" size="sm" onClick={handleStartRename}>
                          <IconPencil size={14} />
                        </ActionIcon>
                      </>
                    )}
                    {(existingReference as any).type && (
                      <Badge size="sm" variant="light" color={
                        (existingReference as any).type === 'Location' ? 'teal'
                        : (existingReference as any).type === 'Style' ? 'orange'
                        : (existingReference as any).type === 'Item' ? 'grape'
                        : 'blue'
                      }>
                        {(existingReference as any).type}
                      </Badge>
                    )}
                  </Group>
                  <Text c={isFailed ? 'red' : 'dimmed'} size="sm">
                    {isFailed
                      ? 'Something went wrong'
                      : existingReference.status === 'Ready'
                      ? hasRefs
                        ? 'Ready to use'
                        : 'Upload reference images to get started.'
                      : 'Pending — upload reference images'}
                  </Text>
                </div>

                {/* Error details for failed references */}
                {isFailed && existingReference.errorMessage && (
                  <Alert
                    color="red"
                    variant="light"
                    title="Error details"
                    icon={<IconAlertTriangle size={18} />}
                    w="100%"
                    maw={500}
                  >
                    <Text size="sm">{existingReference.errorMessage}</Text>
                  </Alert>
                )}

                {/* Display reference images when ready */}
                {hasRefs && (
                  <Stack gap="sm" w="100%">
                    <Text fw={500} size="sm" ta="center">
                      Reference Images
                    </Text>
                    <DndContext
                      sensors={refImageSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleRefImageDragEnd}
                    >
                      <SortableContext items={refImages.map((ri) => ri.image.id)}>
                        <Group justify="center" gap="md">
                          {refImages.map((ri, i) => (
                            <SortableRefImage key={ri.image.id} id={ri.image.id}>
                              <div
                                className="rounded-lg overflow-hidden"
                                style={{
                                  width: 120,
                                  height: 160,
                                  background: 'var(--mantine-color-dark-7)',
                                  position: 'relative',
                                }}
                              >
                                <EdgeMedia2
                                  src={ri.image.url}
                                  type="image"
                                  name={`ref ${i + 1}`}
                                  alt={`ref ${i + 1}`}
                                  width={120}
                                  style={{
                                    width: 120,
                                    height: 160,
                                    objectFit: 'cover',
                                    display: 'block',
                                  }}
                                />
                                {deletingImageId === ri.image.id && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      inset: 0,
                                      background: 'rgba(0,0,0,0.6)',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      borderRadius: 'inherit',
                                    }}
                                  >
                                    <Loader size="sm" color="white" />
                                  </div>
                                )}
                                <ActionIcon
                                  size="xs"
                                  color="red"
                                  variant="filled"
                                  style={{ position: 'absolute', top: 4, right: 4 }}
                                  disabled={deletingImageId != null}
                                  onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    openConfirmModal({
                                      title: 'Delete Reference Image',
                                      children: 'Are you sure you want to delete this reference image?',
                                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                                      confirmProps: { color: 'red' },
                                      onConfirm: () => {
                                        setDeletingImageId(ri.image.id);
                                        deleteRefImageMutation.mutate({
                                          referenceId: existingReference!.id,
                                          imageId: ri.image.id,
                                        });
                                      },
                                    });
                                  }}
                                >
                                  <IconX size={10} />
                                </ActionIcon>
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 4,
                                    left: 4,
                                    cursor: 'grab',
                                    opacity: 0.7,
                                  }}
                                >
                                  <IconGripVertical size={14} color="white" />
                                </div>
                              </div>
                            </SortableRefImage>
                          ))}
                        </Group>
                      </SortableContext>
                    </DndContext>
                  </Stack>
                )}

                {/* Upload reference images */}
                <Stack gap="sm" w="100%" maw={400}>
                  <Group justify="center" gap="sm">
                    <Button
                      variant="light"
                      onClick={() => {
                        setShowUploadArea(!showUploadArea);
                        setUploadedImages([]);
                        resetFiles();
                      }}
                    >
                      {hasRefs ? 'Upload More' : 'Upload Reference Images'}
                    </Button>
                  </Group>

                  {showUploadArea && (
                    <Stack gap="sm">
                      <Dropzone
                        onDrop={handleRefImageDrop}
                        onDropCapture={(e) => handleUrlDrop(e, handleRefImageDrop)}
                        accept={IMAGE_MIME_TYPE}
                        maxFiles={10 - uploadedImages.length}
                        disabled={uploadedImages.length >= 10}
                      >
                        <Group
                          justify="center"
                          gap="xl"
                          mih={100}
                          style={{ pointerEvents: 'none' }}
                        >
                          <Dropzone.Accept>
                            <IconUpload size={32} className="text-blue-500" />
                          </Dropzone.Accept>
                          <Dropzone.Reject>
                            <IconX size={32} className="text-red-500" />
                          </Dropzone.Reject>
                          <Dropzone.Idle>
                            <IconPhoto size={32} className="text-gray-500" />
                          </Dropzone.Idle>
                          <div>
                            <Text size="sm" inline>
                              Drop reference images here
                            </Text>
                            <Text size="xs" c="dimmed" inline mt={4}>
                              Upload 1-10 images
                            </Text>
                          </div>
                        </Group>
                      </Dropzone>

                      <Button
                        variant="light"
                        size="xs"
                        leftSection={<IconWand size={14} />}
                        disabled={uploadedImages.length >= 10}
                        onClick={() => {
                          dialogStore.trigger({
                            component: ImageSelectModal,
                            props: {
                              title: 'Pick from Generator',
                              selectSource: 'generation' as const,
                              videoAllowed: false,
                              importedUrls: [],
                              onSelect: async (
                                selected: { url: string; meta?: Record<string, unknown> }[]
                              ) => {
                                if (selected.length === 0) return;
                                for (const img of selected) {
                                  if (uploadedImages.length >= 10) break;
                                  const width = (img.meta?.width as number) ?? 512;
                                  const height = (img.meta?.height as number) ?? 512;
                                  try {
                                    const cfId = await fetchAndUploadGeneratorImage(
                                      img.url,
                                      'ref_add',
                                      uploadToCF
                                    );
                                    const previewUrl =
                                      getEdgeUrl(cfId, { width: 200 }) ?? img.url;
                                    setUploadedImages((prev) => [
                                      ...prev,
                                      { url: cfId, previewUrl, width, height },
                                    ]);
                                  } catch (err) {
                                    console.error('Failed to pick generator image:', err);
                                  }
                                }
                              },
                            },
                          });
                        }}
                      >
                        Pick from Generator
                      </Button>

                      {uploadedImages.length > 0 && (
                        <Group>
                          {uploadedImages.map((img, i) => (
                            <div
                              key={i}
                              className="rounded-md overflow-hidden"
                              style={{
                                width: 80,
                                height: 80,
                                background: 'var(--mantine-color-dark-7)',
                              }}
                            >
                              <Image
                                src={img.previewUrl}
                                alt={`Upload ${i + 1}`}
                                w={80}
                                h={80}
                                fit="cover"
                              />
                            </div>
                          ))}
                        </Group>
                      )}

                      {uploadingFiles.some((f) => f.status === 'uploading') && (
                        <Progress
                          value={
                            uploadingFiles.length > 0
                              ? uploadingFiles.reduce((sum, f) => sum + (f.progress ?? 0), 0) /
                                uploadingFiles.length
                              : 0
                          }
                          animated
                          size="xs"
                        />
                      )}

                      <Button
                        onClick={handleSaveUploadedRefs}
                        disabled={uploadedImages.length === 0}
                        loading={addMoreImagesMutation.isPending}
                      >
                        Save Reference Images
                      </Button>
                    </Stack>
                  )}
                </Stack>

                <Button component={Link} href={`/comics/project/${projectId}`}>
                  Back to Project
                </Button>
              </Stack>
            </Card>
          </Stack>
        </Container>
      </>
    );
  }

  // New reference creation form — simple upload flow
  return (
    <>
      <Meta title={`Add Reference - ${project?.name} - Civitai Comics`} deIndex={true} />

      <Container size="md" py="xl">
        <Stack gap="xl">
          <Group>
            <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
              <IconArrowLeft size={20} />
            </ActionIcon>
            <Title order={2}>Add Reference</Title>
          </Group>

          <form onSubmit={handleSubmit}>
            <Stack gap="lg">
              <Card withBorder>
                <Stack gap="md">
                  <div>
                    <Text size="sm" fw={500}>Upload Reference Images</Text>
                    <Text size="sm" c="dimmed">
                      Upload 1-10 images. These will be used as reference for panel generation.
                    </Text>
                  </div>

                  <Dropzone
                    onDrop={handleDrop}
                    onDropCapture={(e) => handleUrlDrop(e, handleDrop)}
                    accept={IMAGE_MIME_TYPE}
                    maxFiles={10 - images.length}
                    disabled={images.length >= 10 || isUploading}
                  >
                    <Group justify="center" gap="xl" mih={120} style={{ pointerEvents: 'none' }}>
                      <Dropzone.Accept>
                        <IconUpload size={48} className="text-blue-500" />
                      </Dropzone.Accept>
                      <Dropzone.Reject>
                        <IconX size={48} className="text-red-500" />
                      </Dropzone.Reject>
                      <Dropzone.Idle>
                        <IconPhoto size={48} className="text-gray-500" />
                      </Dropzone.Idle>

                      <div>
                        <Text size="sm" inline>
                          Drop images here or click to browse
                        </Text>
                        <Text size="sm" c="dimmed" inline mt={7}>
                          Upload 1-10 reference images
                        </Text>
                      </div>
                    </Group>
                  </Dropzone>

                  <Button
                    variant="light"
                    leftSection={<IconWand size={14} />}
                    disabled={images.length >= 10 || isUploading}
                    onClick={() => {
                      dialogStore.trigger({
                        component: ImageSelectModal,
                        props: {
                          title: 'Pick from Generator',
                          selectSource: 'generation' as const,
                          videoAllowed: false,
                          importedUrls: [],
                          onSelect: async (
                            selected: { url: string; meta?: Record<string, unknown> }[]
                          ) => {
                            if (selected.length === 0) return;
                            for (const img of selected) {
                              if (images.length >= 10) break;
                              const width = (img.meta?.width as number) ?? 512;
                              const height = (img.meta?.height as number) ?? 512;
                              try {
                                const cfId = await fetchAndUploadGeneratorImage(
                                  img.url,
                                  'ref_create',
                                  uploadImageToCF
                                );
                                const previewUrl =
                                  getEdgeUrl(cfId, { width: 200 }) ?? img.url;
                                // Create a synthetic File-like blob for state consistency
                                const blob = await fetch(previewUrl).then((r) =>
                                  r.blob()
                                );
                                const file = new File([blob], 'generator-image.jpg', {
                                  type: 'image/jpeg',
                                });
                                setImages((prev) =>
                                  [
                                    ...prev,
                                    { file, preview: previewUrl, width, height },
                                  ].slice(0, 10)
                                );
                              } catch (err) {
                                console.error('Failed to pick generator image:', err);
                              }
                            }
                          },
                        },
                      });
                    }}
                  >
                    Pick from Generator
                  </Button>

                  {images.length > 0 && (
                    <Group>
                      {images.map((image, index) => (
                        <div key={index} className="relative">
                          <Image
                            src={image.preview}
                            alt={`Reference ${index + 1}`}
                            w={80}
                            h={80}
                            fit="cover"
                            radius="sm"
                          />
                          <ActionIcon
                            size="xs"
                            color="red"
                            variant="filled"
                            className="absolute -top-2 -right-2"
                            onClick={() => removeImage(index)}
                            disabled={isUploading}
                          >
                            <IconX size={12} />
                          </ActionIcon>
                        </div>
                      ))}
                    </Group>
                  )}

                  <Text size="sm" c={images.length >= 1 ? 'green' : 'dimmed'}>
                    {images.length}/10 images ({images.length >= 1 ? 'ready' : 'need at least 1'})
                  </Text>
                </Stack>
              </Card>

              <Card withBorder>
                <Stack gap="md">
                  <Text size="sm" fw={500}>Tips for Good References</Text>
                  <ul className="text-sm text-gray-400 list-disc ml-4 space-y-1">
                    <li>Clear, front-facing view of the subject</li>
                    <li>Same subject in all images</li>
                    <li>Different angles help (front, side, 3/4 view)</li>
                    <li>Consistent lighting across images</li>
                    <li>High resolution images work best</li>
                  </ul>
                </Stack>
              </Card>

              <TextInput
                label="Reference name"
                placeholder="Maya"
                value={referenceName}
                onChange={(e) => setReferenceName(e.target.value)}
                disabled={isUploading}
              />

              <div>
                <Text size="sm" fw={500} mb={4}>
                  Reference type
                </Text>
                <SegmentedControl
                  value={referenceType}
                  onChange={setReferenceType}
                  data={[
                    { value: 'Character', label: 'Character' },
                    { value: 'Location', label: 'Location' },
                    { value: 'Style', label: 'Style' },
                    { value: 'Item', label: 'Item' },
                  ]}
                  disabled={isUploading}
                  fullWidth
                />
              </div>

              {isUploading && (
                <Stack gap="xs">
                  <Progress value={uploadProgress} animated />
                  <Text size="sm" c="dimmed" ta="center">
                    Uploading images...
                  </Text>
                </Stack>
              )}

              <Group justify="space-between">
                <Text c="dimmed" size="sm">
                  Free — images used as generation references
                </Text>
                <Group>
                  <Button
                    variant="default"
                    component={Link}
                    href={`/comics/project/${projectId}`}
                    disabled={isUploading}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={images.length < 1 || !referenceName.trim()}
                    loading={
                      isUploading ||
                      createReferenceMutation.isPending ||
                      addImagesMutation.isPending
                    }
                  >
                    Add Reference
                  </Button>
                </Group>
              </Group>
            </Stack>
          </form>
        </Stack>
      </Container>
    </>
  );
}

export default Page(ReferenceUpload);
