import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Tabs,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconInfoCircle, IconPhoto, IconSparkles, IconUpload, IconX } from '@tabler/icons-react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { ChallengeSelectableImageCardMemoized } from '~/components/Challenge/ChallengeSelectableImageCard';
import type { TextToImageSteps } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import {
  addSimpleImagePostInput,
  bulkSaveCollectionItemsInput,
} from '~/server/schema/collection.schema';
import type { ChallengeDetail } from '~/server/schema/challenge.schema';
import type { ImageGetInfinite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { downloadGeneratorImages } from '~/utils/generator-import';
import { trpc } from '~/utils/trpc';
import { useCollection } from '~/components/Collections/collection.utils';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { isDefined } from '~/utils/type-guards';
import { hideNotification, showNotification } from '@mantine/notifications';
import type { NormalizedGeneratedImage } from '~/server/services/orchestrator';
import clsx from 'clsx';

// ---------------------------------------------------------------------------
// Selection store (same pattern as AddUserContentModal)
// ---------------------------------------------------------------------------
type StoreState = {
  selected: Record<number, boolean>;
  toggleSelected: (value: number) => void;
  deselectAll: () => void;
};

const useStore = create<StoreState>()(
  immer((set) => ({
    selected: {},
    toggleSelected: (value) => {
      set((state) => {
        if (state.selected[value]) delete state.selected[value];
        else state.selected[value] = true;
      });
    },
    deselectAll: () => {
      set((state) => {
        state.selected = {};
      });
    },
  }))
);

// ---------------------------------------------------------------------------
// Generator selection store (separate since these aren't image IDs)
// ---------------------------------------------------------------------------
type GeneratorImage = {
  url: string;
  label: string;
  type: 'image' | 'video';
  meta?: Record<string, unknown>;
  resources?: TextToImageSteps[number]['resources'];
};

type GeneratorStoreState = {
  selected: GeneratorImage[];
  toggleSelected: (img: GeneratorImage) => void;
  deselectAll: () => void;
};

const useGeneratorStore = create<GeneratorStoreState>()(
  immer((set) => ({
    selected: [],
    toggleSelected: (img) => {
      set((state) => {
        const idx = state.selected.findIndex((s) => s.url === img.url);
        if (idx >= 0) state.selected.splice(idx, 1);
        else state.selected.push({ ...img });
      });
    },
    deselectAll: () => {
      set((state) => {
        state.selected = [];
      });
    },
  }))
);

// ---------------------------------------------------------------------------
// Main Modal
// ---------------------------------------------------------------------------
type Props = {
  challengeId: number;
  collectionId: number;
};

export function ChallengeSubmitModal({ challengeId, collectionId }: Props) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const { collection } = useCollection(collectionId);
  const [activeTab, setActiveTab] = useState<string | null>('library');
  const [error, setError] = useState('');
  const [tagId, setTagId] = useState<number | null>(null);

  // Selection state
  const selectedImageIds = useStore((state) => Object.keys(state.selected).map(Number));
  const deselectAll = useStore((state) => state.deselectAll);
  const generatorSelected = useGeneratorStore((state) => state.selected);
  const deselectAllGenerator = useGeneratorStore((state) => state.deselectAll);

  // Upload state
  const { files: uploadedFiles, uploadToCF, resetFiles, removeImage } = useCFImageUpload();

  // Challenge data
  const { data: challenge } = trpc.challenge.getById.useQuery({ id: challengeId });
  const { data: userEntryData } = trpc.challenge.getUserEntryCount.useQuery(
    { challengeId },
    { enabled: !!currentUser }
  );
  const userEntryCount = userEntryData?.count ?? 0;
  const maxEntries = challenge?.maxEntriesPerUser ?? 20;
  const remainingEntries = Math.max(0, maxEntries - userEntryCount);

  // Eligibility check for selected library images
  const { data: eligibilityData } = trpc.challenge.checkEntryEligibility.useQuery(
    { challengeId, imageIds: selectedImageIds },
    { enabled: selectedImageIds.length > 0 }
  );
  const eligibilityMap = useMemo(() => {
    if (!eligibilityData) return new Map<number, { eligible: boolean; reasons: string[] }>();
    return new Map(eligibilityData.map((e) => [e.imageId, e]));
  }, [eligibilityData]);

  // Pre-filter to only eligible library images (used by submit + button label)
  const eligibleImageIds = useMemo(
    () =>
      selectedImageIds.filter((id) => {
        const e = eligibilityMap.get(id);
        return !e || e.eligible;
      }),
    [selectedImageIds, eligibilityMap]
  );

  const availableTags = (collection?.tags ?? []).filter((t) => !t.filterableOnly);

  // ---- Mutations ----
  const addSimpleImagePostMutation = trpc.collection.addSimpleImagePost.useMutation();
  const bulkSaveItemsMutation = trpc.collection.bulkSaveItems.useMutation();

  const handleClose = () => {
    resetFiles();
    deselectAll();
    deselectAllGenerator();
    setError('');
    dialog.onClose();
  };

  const handleSuccess = async () => {
    handleClose();
    showSuccessNotification({
      message: 'Your entries have been submitted to the challenge.',
    });
    await queryUtils.image.getInfinite.invalidate();
    await queryUtils.collection.getById.invalidate({ id: collectionId });
    await queryUtils.challenge.getUserEntryCount.invalidate({ challengeId });
    await queryUtils.challenge.getById.invalidate({ id: challengeId });
  };

  const handleMutationError = (error: { message: string }) => {
    showErrorNotification({
      title: 'Unable to submit entries',
      error: new Error(error.message),
    });
  };

  /** Returns true if count is valid; sets error and returns false otherwise. */
  const validateEntryCount = (count: number): boolean => {
    if (count === 0) {
      setError('You must select at least one image.');
      return false;
    }
    if (count > remainingEntries) {
      setError(
        `You can only submit ${remainingEntries} more ${
          remainingEntries === 1 ? 'entry' : 'entries'
        }.`
      );
      return false;
    }
    return true;
  };

  // Submit library images (bulk save existing image IDs)
  const handleSubmitLibrary = () => {
    setError('');
    if (!validateEntryCount(eligibleImageIds.length)) return;

    const data = { collectionId, imageIds: eligibleImageIds, tagId };
    const results = bulkSaveCollectionItemsInput.safeParse(data);
    if (!results.success) {
      setError('You must select at least one image.');
      return;
    }

    bulkSaveItemsMutation.mutate(data, {
      onSuccess: handleSuccess,
      onError: handleMutationError,
    });
  };

  // Submit generator images (download + upload + create post)
  const handleSubmitGenerator = async () => {
    setError('');
    if (!validateEntryCount(generatorSelected.length)) return;

    const importNotifId = `challenge-import-${Date.now()}`;
    showNotification({
      id: importNotifId,
      loading: true,
      autoClose: false,
      withCloseButton: false,
      message: `Importing ${generatorSelected.length} image${
        generatorSelected.length !== 1 ? 's' : ''
      } from generator...`,
    });

    try {
      const downloadedFiles = await downloadGeneratorImages(generatorSelected);

      if (downloadedFiles.length === 0) {
        hideNotification(importNotifId);
        setError('Failed to download generator images. Please try again.');
        return;
      }

      // Upload to CF and collect image data for the mutation
      const uploaded = await Promise.all(
        downloadedFiles.map(async ({ file, meta }) => {
          try {
            const result = await uploadToCF(file);
            return { ...result, meta };
          } catch {
            return null;
          }
        })
      );

      hideNotification(importNotifId);

      // The CF image ID (uuid) is what imageSchema expects as `url`
      const images = uploaded.filter(isDefined).map((u) => ({
        url: u.id,
        type: u.type,
        meta: u.meta,
      }));

      if (images.length === 0) {
        setError('Upload failed. Please try again.');
        return;
      }

      addSimpleImagePostMutation.mutate(
        { collectionId, images },
        {
          onSuccess: handleSuccess,
          onError: handleMutationError,
        }
      );
    } catch (e) {
      hideNotification(importNotifId);
      setError('An error occurred during import.');
    }
  };

  // Submit uploaded files
  const handleSubmitUploads = () => {
    setError('');
    const successFiles = uploadedFiles.filter((f) => f.status === 'success');
    if (!validateEntryCount(successFiles.length)) return;

    const images = successFiles.map((f) => ({
      url: f.url,
      type: f.type,
      hash: f.hash,
      width: f.width,
      height: f.height,
      mimeType: f.mimeType,
    }));

    const data = { collectionId, images };
    const results = addSimpleImagePostInput.safeParse(data);
    if (!results.success) {
      setError('You must upload at least one image.');
      return;
    }

    addSimpleImagePostMutation.mutate(data, {
      onSuccess: handleSuccess,
      onError: handleMutationError,
    });
  };

  // Route submit to correct handler based on active tab
  const handleSubmit = () => {
    if (activeTab === 'library') handleSubmitLibrary();
    else if (activeTab === 'generator') handleSubmitGenerator();
    else if (activeTab === 'upload') handleSubmitUploads();
  };

  const uploading = uploadedFiles.some((f) => f.status === 'uploading');
  const loading =
    uploading || addSimpleImagePostMutation.isPending || bulkSaveItemsMutation.isPending;

  // Count for submit button
  const submitCount =
    activeTab === 'library'
      ? eligibleImageIds.length
      : activeTab === 'generator'
      ? generatorSelected.length
      : uploadedFiles.filter((f) => f.status === 'success').length;

  return (
    <Modal
      {...dialog}
      title={
        <Stack gap={2}>
          <Text fw={600}>Submit Challenge Entry</Text>
          <Text size="sm" c="dimmed">
            Your Entries: {userEntryCount} / {maxEntries}
          </Text>
        </Stack>
      }
      size="80%"
      onClose={handleClose}
      centered
    >
      <Stack gap="md">
        {error && (
          <AlertWithIcon color="red" iconColor="red" size="sm" icon={<IconInfoCircle size={16} />}>
            {error}
          </AlertWithIcon>
        )}

        {remainingEntries === 0 && (
          <AlertWithIcon color="yellow" size="sm" icon={<IconInfoCircle size={16} />}>
            You have reached the maximum number of entries for this challenge.
          </AlertWithIcon>
        )}

        <Tabs value={activeTab} onChange={setActiveTab} classNames={{ panel: 'pt-4' }}>
          <Tabs.List>
            <Tabs.Tab value="library" leftSection={<IconPhoto size={16} />}>
              My Images
            </Tabs.Tab>
            <Tabs.Tab value="generator" leftSection={<IconSparkles size={16} />}>
              From Generator
            </Tabs.Tab>
            <Tabs.Tab value="upload" leftSection={<IconUpload size={16} />}>
              Upload New
            </Tabs.Tab>
          </Tabs.List>

          {/* My Images Tab */}
          <Tabs.Panel value="library">
            {challenge && (
              <ChallengeContext.Provider value={challenge}>
                <ChallengeEligibilityContext.Provider value={eligibilityMap}>
                  <ScrollArea
                    scrollRestore={{ enabled: false, key: 'challenge-submit-library' }}
                    style={{ maxHeight: 440, overflowY: 'auto' }}
                  >
                    <MasonryProvider
                      columnWidth={constants.cardSizes.image}
                      maxColumnCount={4}
                      maxSingleColumnWidth={450}
                    >
                      <MasonryContainer m={0} p={0} px={0}>
                        <ImagesInfinite
                          filters={{
                            collectionId: undefined,
                            userId: currentUser?.id,
                            period: 'AllTime',
                            sort: ImageSort.Newest,
                            hidden: undefined,
                            types: undefined,
                            withMeta: undefined,
                            followed: undefined,
                            fromPlatform: undefined,
                            hideAutoResources: undefined,
                            hideManualResources: undefined,
                          }}
                          renderItem={LibraryImageCard}
                          disableStoreFilters
                        />
                      </MasonryContainer>
                    </MasonryProvider>
                  </ScrollArea>
                </ChallengeEligibilityContext.Provider>
              </ChallengeContext.Provider>
            )}
          </Tabs.Panel>

          {/* From Generator Tab */}
          <Tabs.Panel value="generator">
            <GeneratorTab challenge={challenge ?? undefined} />
          </Tabs.Panel>

          {/* Upload New Tab */}
          <Tabs.Panel value="upload">
            <Stack gap="md" py="md">
              <MediaDropzone
                onDrop={(args) => {
                  args.forEach(({ file }) => uploadToCF(file));
                }}
                accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
                disabled={remainingEntries === 0}
                className="rounded-lg"
              />
              {uploadedFiles.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                  {uploadedFiles.map((f) => (
                    <div key={f.url} className="relative overflow-hidden rounded-lg">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={f.objectUrl}
                        alt={f.file.name}
                        className="h-[140px] w-full object-cover"
                      />
                      {f.status === 'uploading' && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                          <Loader size="sm" color="white" />
                        </div>
                      )}
                      {f.status === 'error' && (
                        <Badge
                          color="red"
                          variant="filled"
                          size="xs"
                          className="absolute bottom-1 left-1"
                        >
                          Failed
                        </Badge>
                      )}
                      <ActionIcon
                        size="sm"
                        color="dark"
                        variant="filled"
                        radius="xl"
                        className="absolute right-1 top-1"
                        onClick={() => removeImage(f.url)}
                      >
                        <IconX size={12} />
                      </ActionIcon>
                    </div>
                  ))}
                </div>
              )}
            </Stack>
          </Tabs.Panel>
        </Tabs>

        {/* Category tag dropdown */}
        {(availableTags?.length ?? 0) > 0 && (
          <Select
            label="Category"
            withAsterisk={!collection?.metadata?.disableTagRequired}
            placeholder="Select a category for your submission"
            data={(availableTags ?? []).map((tag) => ({
              value: tag.id.toString(),
              label: tag.name,
            }))}
            onChange={(value) => setTagId(value ? Number(value) : null)}
            value={tagId?.toString() ?? null}
            clearable
          />
        )}

        {/* Footer */}
        <Group
          gap="xs"
          justify="flex-end"
          mx="-lg"
          px="lg"
          pt="lg"
          style={{
            borderTop: `1px solid ${
              colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
            }`,
          }}
        >
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={loading}
            disabled={submitCount === 0 || remainingEntries === 0}
          >
            {submitCount > 0
              ? `Submit ${submitCount} ${submitCount === 1 ? 'Entry' : 'Entries'}`
              : 'Submit'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Library image card wrapper (passes challenge context to selectable card)
// ---------------------------------------------------------------------------
function LibraryImageCard({ data: image }: { data: ImageGetInfinite[number] }) {
  const toggleSelected = useStore((state) => state.toggleSelected);
  const selected = useStore(useCallback((state) => !!state.selected[image.id], [image.id]));

  // We access challenge data from the nearest ChallengeSubmitModal context.
  // Since ImagesInfinite doesn't support passing extra props, we use a simple
  // approach: store the challenge data in a module-level ref.
  const challenge = useChallengeContext();
  const eligibility = useChallengeEligibility(image.id);

  if (!challenge) return null;

  return (
    <ChallengeSelectableImageCardMemoized
      image={image}
      challenge={challenge}
      selected={selected}
      onToggle={toggleSelected}
      serverEligibility={eligibility}
    />
  );
}

// ---------------------------------------------------------------------------
// Simple context for passing challenge data to library cards
// ---------------------------------------------------------------------------
const ChallengeContext = createContext<Pick<
  ChallengeDetail,
  'allowedNsfwLevel' | 'startsAt'
> | null>(null);

const ChallengeEligibilityContext = createContext<
  Map<number, { eligible: boolean; reasons: string[] }>
>(new Map());

function useChallengeContext() {
  return useContext(ChallengeContext);
}

function useChallengeEligibility(imageId: number) {
  const map = useContext(ChallengeEligibilityContext);
  return map.get(imageId);
}

// ---------------------------------------------------------------------------
// Generator Tab
// ---------------------------------------------------------------------------
type GennedMedia = NormalizedGeneratedImage & {
  params: TextToImageSteps[number]['params'];
  resources: TextToImageSteps[number]['resources'];
  completed?: Date;
};

function GeneratorTab({ challenge }: { challenge?: ChallengeDetail }) {
  const currentUser = useCurrentUser();

  const { steps, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useGetTextToImageRequests({ tags: [WORKFLOW_TAGS.IMAGE] }, { enabled: !!currentUser });

  const generatedMedia = useMemo(
    () =>
      steps.flatMap((step) =>
        step.images
          .filter((x) => x.status === 'succeeded' && x.available && !x.blockedReason)
          .map((asset) => ({
            ...asset,
            params: {
              ...step.params,
              seed: asset.seed,
              completed: step.completedAt ? new Date(step.completedAt) : undefined,
              stepName: step.name,
            },
            resources: step.resources,
          }))
      ),
    [steps]
  );

  if (isFetching && !isFetchingNextPage) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (generatedMedia.length === 0) {
    return <NoContent message="No generated images found. Create some images first!" />;
  }

  return (
    <Box mah={440} style={{ overflowY: 'auto' }}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 p-2">
        {generatedMedia.map((img) => (
          <GeneratorImageCard
            key={`${img.workflowId}_${img.stepName}_${img.id}`}
            image={img}
            challenge={challenge}
          />
        ))}
      </div>
      {hasNextPage && (
        <InViewLoader
          loadFn={fetchNextPage}
          loadCondition={!isFetching && !isFetchingNextPage && hasNextPage}
        >
          <Center p="xl" style={{ height: 36 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Generator Image Card
// ---------------------------------------------------------------------------
function GeneratorImageCard({
  image,
  challenge,
}: {
  image: GennedMedia;
  challenge?: ChallengeDetail;
}) {
  const toggleSelected = useGeneratorStore((state) => state.toggleSelected);
  const isSelected = useGeneratorStore(
    useCallback((state) => state.selected.some((s) => s.url === image.url), [image.url])
  );

  // Check model version eligibility client-side for generator images
  const eligibility = useMemo(() => {
    if (!challenge || challenge.modelVersionIds.length === 0) {
      return { eligible: true, reasons: [] as string[] };
    }

    const imageResourceIds = (image.resources ?? [])
      .map((r) => ('id' in r && typeof r.id === 'number' ? r.id : null))
      .filter(isDefined);

    const hasEligibleModel = imageResourceIds.some((vid) =>
      challenge.modelVersionIds.includes(vid)
    );

    if (!hasEligibleModel) {
      return { eligible: false, reasons: ['Wrong model'] };
    }
    return { eligible: true, reasons: [] as string[] };
  }, [challenge, image.resources]);

  const handleClick = () => {
    if (!eligibility.eligible) return;

    const meta = getStepMeta({
      params: image.params,
      resources: image.resources,
      metadata: {},
    } as any);

    toggleSelected({
      url: image.url,
      label: 'prompt' in image.params ? (image.params.prompt as string) : '',
      type: image.type === 'video' ? 'video' : 'image',
      meta,
      resources: image.resources,
    });
  };

  return (
    <div
      className={clsx(
        'relative cursor-pointer overflow-hidden rounded-lg',
        isSelected && 'ring-2 ring-blue-5',
        !eligibility.eligible && 'cursor-not-allowed opacity-40 grayscale'
      )}
      onClick={handleClick}
    >
      <EdgeMedia
        alt="Generated image"
        src={image.url}
        type={image.type}
        className="h-[180px] w-full object-cover"
        anim
      />
      <div className="absolute left-2 top-2">
        {eligibility.eligible ? (
          <Checkbox checked={isSelected} readOnly size="sm" />
        ) : (
          <Badge color="red" variant="filled" size="xs">
            {eligibility.reasons[0]}
          </Badge>
        )}
      </div>
    </div>
  );
}
