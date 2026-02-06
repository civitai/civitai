import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Container,
  Group,
  Image,
  Progress,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconPhoto,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
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

function CharacterUpload() {
  const router = useRouter();
  const { id } = router.query;
  const projectId = id as string;

  const [characterName, setCharacterName] = useState('');
  const [saveToLibrary, setSaveToLibrary] = useState(false);

  // Upload flow state
  const [images, setImages] = useState<
    { file: File; preview: string; width: number; height: number }[]
  >([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const { uploadToCF: uploadImageToCF } = useCFImageUpload();

  const { data: project, refetch: refetchProject } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  const createReferenceMutation = trpc.comics.createReference.useMutation();
  const addImagesMutation = trpc.comics.addReferenceImages.useMutation({
    onSuccess: () => {
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
    if (images.length === 0 || !characterName.trim()) return;

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
        ...(saveToLibrary ? {} : { projectId }),
        name: characterName.trim(),
      });

      setUploadProgress(90);

      // 3. Add images to reference
      addImagesMutation.mutate({
        referenceId: reference.id,
        images: uploadedImages,
      });
    } catch (error) {
      console.error('Upload failed:', error);
      setIsUploading(false);
    }
  };

  // Existing character view
  const characterId = router.query.characterId as string | undefined;
  const existingCharacter = characterId
    ? project?.references?.find((c) => c.id === characterId) ??
      project?.libraryReferences?.find((c) => c.id === characterId)
    : undefined;

  // Reference image management state for existing characters
  const [showUploadArea, setShowUploadArea] = useState(false);
  const { uploadToCF, files: uploadingFiles, resetFiles } = useCFImageUpload();
  const [uploadedImages, setUploadedImages] = useState<
    { url: string; previewUrl: string; width: number; height: number }[]
  >([]);

  const addMoreImagesMutation = trpc.comics.addReferenceImages.useMutation({
    onSuccess: () => {
      setShowUploadArea(false);
      setUploadedImages([]);
      resetFiles();
      refetchProject();
    },
  });

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
    if (!existingCharacter || uploadedImages.length === 0) return;
    addMoreImagesMutation.mutate({
      referenceId: existingCharacter.id,
      images: uploadedImages,
    });
  };

  // If characterId is in URL but character not found, show not-found state
  if (characterId && !existingCharacter && project) {
    return (
      <>
        <Meta title={`Character Not Found - ${project?.name} - Civitai Comics`} />
        <Container size="md" py="xl">
          <Stack gap="xl">
            <Group>
              <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                <IconArrowLeft size={20} />
              </ActionIcon>
              <Title order={2}>Character Not Found</Title>
            </Group>
            <Card withBorder p="xl">
              <Stack align="center" gap="lg">
                <IconAlertTriangle size={40} className="text-yellow-500" />
                <Text c="dimmed">
                  This character could not be found in the project or your library.
                </Text>
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

  // If character already exists, show status + ref image management
  if (existingCharacter) {
    const isFailed = existingCharacter.status === 'Failed';
    const refImages = existingCharacter.images ?? [];
    const hasRefs = refImages.length > 0;

    return (
      <>
        <Meta title={`Character - ${project?.name} - Civitai Comics`} />

        <Container size="md" py="xl">
          <Stack gap="xl">
            <Group>
              <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                <IconArrowLeft size={20} />
              </ActionIcon>
              <Title order={2}>Character</Title>
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
                      name={existingCharacter.name}
                      alt={existingCharacter.name}
                      width={96}
                      style={{ width: 96, height: 96, objectFit: 'cover', display: 'block' }}
                    />
                  ) : (
                    <IconPhoto size={40} className="text-gray-500" />
                  )}
                </div>

                <div className="text-center">
                  <Text fw={500} size="lg">
                    {existingCharacter.name}
                  </Text>
                  <Text c={isFailed ? 'red' : 'dimmed'} size="sm">
                    {isFailed
                      ? 'Something went wrong'
                      : existingCharacter.status === 'Ready'
                      ? hasRefs
                        ? 'Ready to use'
                        : 'Upload reference images to get started.'
                      : 'Pending — upload reference images'}
                  </Text>
                </div>

                {/* Error details for failed characters */}
                {isFailed && existingCharacter.errorMessage && (
                  <Alert
                    color="red"
                    variant="light"
                    title="Error details"
                    icon={<IconAlertTriangle size={18} />}
                    w="100%"
                    maw={500}
                  >
                    <Text size="sm">{existingCharacter.errorMessage}</Text>
                  </Alert>
                )}

                {/* Display reference images when ready */}
                {hasRefs && (
                  <Stack gap="sm" w="100%">
                    <Text fw={500} size="sm" ta="center">
                      Reference Images
                    </Text>
                    <Group justify="center" gap="md">
                      {refImages.map((ri, i) => (
                        <div
                          key={i}
                          className="rounded-lg overflow-hidden"
                          style={{
                            width: 120,
                            height: 160,
                            background: 'var(--mantine-color-dark-7)',
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
                        </div>
                      ))}
                    </Group>
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
                        <Progress value={65} animated size="xs" />
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

  // New character creation form — simple upload flow
  return (
    <>
      <Meta title={`Add Character - ${project?.name} - Civitai Comics`} />

      <Container size="md" py="xl">
        <Stack gap="xl">
          <Group>
            <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
              <IconArrowLeft size={20} />
            </ActionIcon>
            <Title order={2}>Add Character</Title>
          </Group>

          <form onSubmit={handleSubmit}>
            <Stack gap="lg">
              <Card withBorder>
                <Stack gap="md">
                  <div>
                    <Text fw={500}>Upload Reference Images</Text>
                    <Text size="sm" c="dimmed">
                      Upload 1-10 images of your character. These will be used as reference for
                      panel generation.
                    </Text>
                  </div>

                  <Dropzone
                    onDrop={handleDrop}
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
                        <Text size="lg" inline>
                          Drop images here or click to browse
                        </Text>
                        <Text size="sm" c="dimmed" inline mt={7}>
                          Upload 1-10 reference images
                        </Text>
                      </div>
                    </Group>
                  </Dropzone>

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
                  <Text fw={500}>Tips for Good References</Text>
                  <ul className="text-sm text-gray-400 list-disc ml-4 space-y-1">
                    <li>Clear, front-facing view of the character</li>
                    <li>Same character in all images</li>
                    <li>Different angles help (front, side, 3/4 view)</li>
                    <li>Consistent lighting across images</li>
                    <li>High resolution images work best</li>
                  </ul>
                </Stack>
              </Card>

              <TextInput
                label="Character name"
                placeholder="Maya"
                value={characterName}
                onChange={(e) => setCharacterName(e.target.value)}
                disabled={isUploading}
              />

              {isUploading && (
                <Stack gap="xs">
                  <Progress value={uploadProgress} animated />
                  <Text size="sm" c="dimmed" ta="center">
                    Uploading images...
                  </Text>
                </Stack>
              )}

              <Switch
                label="Save to My Library"
                description="Library characters can be used across all your projects"
                checked={saveToLibrary}
                onChange={(e) => setSaveToLibrary(e.currentTarget.checked)}
                color="yellow"
                disabled={isUploading}
              />

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
                    disabled={images.length < 1 || !characterName.trim()}
                    loading={
                      isUploading ||
                      createReferenceMutation.isPending ||
                      addImagesMutation.isPending
                    }
                  >
                    {saveToLibrary ? 'Add to Library' : 'Add Character'}
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

export default Page(CharacterUpload);
