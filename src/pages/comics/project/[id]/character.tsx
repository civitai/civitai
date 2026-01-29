import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Image,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDebouncedValue } from '@mantine/hooks';
import { IconArrowLeft, IconCheck, IconPhoto, IconSearch, IconUpload, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';

import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
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

type CharacterSource = 'existing' | 'upload';

function CharacterUpload() {
  const router = useRouter();
  const { id } = router.query;
  const projectId = id as string;

  const [sourceType, setSourceType] = useState<CharacterSource>('existing');
  const [characterName, setCharacterName] = useState('');

  // Upload flow state
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Existing model flow state
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch] = useDebouncedValue(searchQuery, 300);
  const [selectedModel, setSelectedModel] = useState<{
    id: number;
    name: string;
    versionId: number;
  } | null>(null);

  const { data: project, refetch: refetchProject } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  const { data: myModels, isLoading: isLoadingModels } = trpc.comics.searchMyModels.useQuery(
    { query: debouncedSearch || undefined, limit: 20 },
    { enabled: sourceType === 'existing' }
  );

  // Fetch cover images for models using the same pattern as showcase items
  const modelEntities = useMemo(
    () => (myModels ?? []).map((m) => ({ entityType: 'Model' as const, entityId: m.id })),
    [myModels]
  );
  const { data: coverImages } = trpc.image.getEntitiesCoverImage.useQuery(
    { entities: modelEntities },
    { enabled: modelEntities.length > 0 }
  );
  const coverImageMap = useMemo(() => {
    const map = new Map<number, { url: string; type: string; metadata?: any }>();
    if (coverImages) {
      for (const img of coverImages) {
        map.set(img.entityId, { url: img.url, type: img.type, metadata: img.metadata });
      }
    }
    return map;
  }, [coverImages]);

  const createFromUploadMutation = trpc.comics.createCharacterFromUpload.useMutation({
    onSuccess: () => {
      router.push(`/comics/project/${projectId}`);
    },
  });

  const createFromModelMutation = trpc.comics.createCharacterFromModel.useMutation({
    onSuccess: () => {
      refetchProject();
    },
  });

  const utils = trpc.useUtils();

  const handleDrop = (files: File[]) => {
    const newImages = files.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }));
    setImages((prev) => [...prev, ...newImages].slice(0, 5));
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const newImages = [...prev];
      URL.revokeObjectURL(newImages[index].preview);
      newImages.splice(index, 1);
      return newImages;
    });
  };

  const handleSubmitUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (images.length < 3 || !characterName.trim()) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // TODO: In production, upload images to S3 here
      const imageUrls = images.map(
        (_, i) => `https://placeholder.civitai.com/character/${projectId}/${i}.jpg`
      );

      for (let i = 0; i <= 100; i += 20) {
        setUploadProgress(i);
        await new Promise((r) => setTimeout(r, 200));
      }

      createFromUploadMutation.mutate({
        projectId,
        name: characterName.trim(),
        referenceImages: imageUrls,
      });
    } catch (error) {
      console.error('Upload failed:', error);
      setIsUploading(false);
    }
  };

  const handleSubmitModel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedModel || !characterName.trim()) return;

    createFromModelMutation.mutate({
      projectId,
      name: characterName.trim(),
      modelId: selectedModel.id,
      modelVersionId: selectedModel.versionId,
    });
  };

  const existingCharacter = project?.characters?.[0];

  // Poll for character status when in Pending/Processing state
  useEffect(() => {
    if (
      !existingCharacter ||
      (existingCharacter.status !== 'Pending' && existingCharacter.status !== 'Processing')
    ) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const result = await utils.comics.pollCharacterStatus.fetch({
          characterId: existingCharacter.id,
        });
        if (result.status === 'Ready' || result.status === 'Failed') {
          refetchProject();
        }
      } catch {
        // Silently ignore poll errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [existingCharacter?.id, existingCharacter?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // If character already exists, show status
  if (existingCharacter && existingCharacter.status !== 'Failed') {
    const isExistingModel = existingCharacter.sourceType === 'ExistingModel';
    const generatedRefs = existingCharacter.generatedReferenceImages as
      | { url: string; width: number; height: number; view: string }[]
      | null;

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
                <div className="w-24 h-24 bg-gray-800 rounded-full flex items-center justify-center">
                  <IconPhoto size={40} className="text-gray-500" />
                </div>

                <div className="text-center">
                  <Text fw={500} size="lg">
                    {existingCharacter.name}
                  </Text>
                  <Text c="dimmed" size="sm">
                    {existingCharacter.status === 'Ready'
                      ? 'Ready to use'
                      : existingCharacter.status === 'Processing'
                        ? isExistingModel
                          ? 'Generating reference images...'
                          : 'Training your character...'
                        : 'Queued for processing'}
                  </Text>
                </div>

                {existingCharacter.status === 'Processing' && (
                  <Stack gap="xs" w="100%" maw={300}>
                    <Progress value={55} animated />
                    <Text size="xs" c="dimmed" ta="center">
                      {isExistingModel
                        ? 'Generating front, side, and back reference views'
                        : 'Training usually takes 5-10 minutes'}
                    </Text>
                  </Stack>
                )}

                {/* Display generated reference images when ready */}
                {existingCharacter.status === 'Ready' && generatedRefs && generatedRefs.length > 0 && (
                  <Stack gap="sm" w="100%">
                    <Text fw={500} size="sm" ta="center">
                      Generated Reference Images
                    </Text>
                    <Group justify="center" gap="md">
                      {generatedRefs.map((ref, i) => (
                        <Stack key={i} gap={4} align="center">
                          <div
                            className="rounded-lg overflow-hidden"
                            style={{
                              width: 120,
                              height: 160,
                              background: 'var(--mantine-color-dark-7)',
                            }}
                          >
                            <Image
                              src={ref.url}
                              alt={`${ref.view} view`}
                              w={120}
                              h={160}
                              fit="cover"
                            />
                          </div>
                          <Badge size="xs" variant="light">
                            {ref.view}
                          </Badge>
                        </Stack>
                      ))}
                    </Group>
                  </Stack>
                )}

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

          <SegmentedControl
            value={sourceType}
            onChange={(v) => setSourceType(v as CharacterSource)}
            data={[
              { label: 'Use Existing LoRA', value: 'existing' },
              { label: 'Upload & Train', value: 'upload' },
            ]}
            fullWidth
          />

          {sourceType === 'existing' ? (
            <form onSubmit={handleSubmitModel}>
              <Stack gap="lg">
                <Card withBorder>
                  <Stack gap="md">
                    <Text fw={500}>Select a Character LoRA</Text>
                    <Text size="sm" c="dimmed">
                      Choose from your existing LoRA models. Reference images will be auto-generated.
                    </Text>

                    <TextInput
                      placeholder="Search your models..."
                      leftSection={<IconSearch size={16} />}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />

                    <div
                      className="max-h-[420px] overflow-y-auto pr-1"
                      style={{
                        scrollbarWidth: 'thin',
                        scrollbarColor: '#495057 #25262b',
                      }}
                    >
                      {isLoadingModels ? (
                        <div className="py-8 text-center">
                          <Text c="dimmed" size="sm">Loading models...</Text>
                        </div>
                      ) : myModels?.length === 0 ? (
                        <div className="py-8 text-center">
                          <Stack align="center" gap="xs">
                            <IconPhoto size={32} className="text-gray-600" />
                            <Text c="dimmed" size="sm">
                              No LoRA models found. Create one first or upload images to train a new character.
                            </Text>
                          </Stack>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          {myModels?.map((model) => {
                            const coverImage = coverImageMap.get(model.id);
                            const isSelected = selectedModel?.id === model.id;
                            return (
                              <div
                                key={model.id}
                                onClick={() => setSelectedModel({
                                  id: model.id,
                                  name: model.name,
                                  versionId: model.versionId!,
                                })}
                                className="cursor-pointer rounded-xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5"
                                style={{
                                  background: 'var(--mantine-color-dark-6)',
                                  border: isSelected
                                    ? '2px solid var(--mantine-color-blue-6)'
                                    : '2px solid var(--mantine-color-dark-4)',
                                  boxShadow: isSelected
                                    ? '0 0 0 3px rgba(34,139,230,0.2), 0 8px 16px rgba(0,0,0,0.5)'
                                    : '0 2px 8px rgba(0,0,0,0.3)',
                                }}
                              >
                                {/* Image */}
                                <div
                                  className="relative overflow-hidden"
                                  style={{
                                    aspectRatio: '1',
                                    background: 'var(--mantine-color-dark-7)',
                                  }}
                                >
                                  {coverImage ? (
                                    <EdgeMedia2
                                      src={coverImage.url}
                                      type={coverImage.type as any}
                                      metadata={coverImage.metadata}
                                      name={model.name}
                                      alt={model.name}
                                      width={300}
                                      style={{
                                        maxWidth: '100%',
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'cover',
                                        objectPosition: 'top center',
                                        display: 'block',
                                      }}
                                      loading="lazy"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                      <IconPhoto size={28} style={{ color: 'var(--mantine-color-dark-3)' }} />
                                    </div>
                                  )}

                                  {/* Selection badge */}
                                  <div
                                    className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-200"
                                    style={{
                                      background: 'var(--mantine-color-blue-6)',
                                      border: '3px solid var(--mantine-color-dark-6)',
                                      opacity: isSelected ? 1 : 0,
                                      transform: isSelected ? 'scale(1)' : 'scale(0.6)',
                                    }}
                                  >
                                    <IconCheck size={14} color="white" />
                                  </div>
                                </div>

                                {/* Info */}
                                <div className="px-3 py-2.5">
                                  <Text size="sm" fw={600} c="white" truncate>
                                    {model.name}
                                  </Text>
                                  {model.versionName && (
                                    <Text size="xs" c="dimmed" mt={2}>
                                      {model.versionName}
                                    </Text>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </Stack>
                </Card>

                <TextInput
                  label="Character name"
                  placeholder="Maya"
                  value={characterName}
                  onChange={(e) => setCharacterName(e.target.value)}
                />

                <Group justify="space-between">
                  <Text c="dimmed" size="sm">
                    Cost: 50 Buzz (reference image generation)
                  </Text>
                  <Group>
                    <Button
                      variant="default"
                      component={Link}
                      href={`/comics/project/${projectId}`}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      disabled={!selectedModel || !characterName.trim()}
                      loading={createFromModelMutation.isPending}
                    >
                      Add Character
                    </Button>
                  </Group>
                </Group>
              </Stack>
            </form>
          ) : (
            <form onSubmit={handleSubmitUpload}>
              <Stack gap="lg">
                <Card withBorder>
                  <Stack gap="md">
                    <div>
                      <Text fw={500}>Upload Reference Images</Text>
                      <Text size="sm" c="dimmed">
                        Upload 3-5 images of your character. We&apos;ll train a LoRA model automatically.
                      </Text>
                    </div>

                    <Dropzone
                      onDrop={handleDrop}
                      accept={IMAGE_MIME_TYPE}
                      maxFiles={5 - images.length}
                      disabled={images.length >= 5 || isUploading}
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
                            Upload 3-5 reference images
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

                    <Text size="sm" c={images.length >= 3 ? 'green' : 'dimmed'}>
                      {images.length}/5 images ({images.length >= 3 ? 'ready' : 'need at least 3'})
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

                <Group justify="space-between">
                  <Text c="dimmed" size="sm">
                    Cost: 50 Buzz (training)
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
                      disabled={images.length < 3 || !characterName.trim()}
                      loading={isUploading || createFromUploadMutation.isPending}
                    >
                      Train Character
                    </Button>
                  </Group>
                </Group>
              </Stack>
            </form>
          )}
        </Stack>
      </Container>
    </>
  );
}

export default Page(CharacterUpload, { withScrollArea: false });
