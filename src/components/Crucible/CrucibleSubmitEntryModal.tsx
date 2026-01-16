import {
  Badge,
  Button,
  Center,
  CloseButton,
  Group,
  Loader,
  Modal,
  Progress,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconBolt,
  IconCheck,
  IconCloudUpload,
  IconEye,
  IconPhoto,
  IconSend,
  IconX,
} from '@tabler/icons-react';
import React, { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Currency, MediaType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { Flags } from '~/shared/utils/flags';
import clsx from 'clsx';

/**
 * Props for the CrucibleSubmitEntryModal
 */
export interface CrucibleSubmitEntryModalProps {
  crucibleId: number;
  crucibleName: string;
  entryFee: number;
  entryLimit: number;
  nsfwLevel: number;
  currentEntryCount: number;
  onSuccess?: () => void;
}

/**
 * Check if an image's NSFW level is compatible with the crucible
 */
function isNsfwLevelCompatible(imageNsfwLevel: number, crucibleNsfwLevel: number): boolean {
  return Flags.intersects(imageNsfwLevel, crucibleNsfwLevel);
}

/**
 * Get NSFW level badge text
 */
function getNsfwLabel(level: number): string {
  if (level <= 1) return 'SFW';
  if (level <= 2) return 'PG-13';
  if (level <= 4) return 'R';
  if (level <= 8) return 'X';
  return 'XXX';
}

/**
 * Image card with selection and validation status
 */
function ImageCard({
  image,
  isSelected,
  isValid,
  validationMessage,
  onClick,
  isAlreadySubmitted,
}: {
  image: {
    id: number;
    url: string;
    nsfwLevel: number;
    type: MediaType;
    meta: unknown;
    createdAt: Date;
  };
  isSelected: boolean;
  isValid: boolean;
  validationMessage?: string;
  onClick: () => void;
  isAlreadySubmitted: boolean;
}) {
  const disabled = !isValid || isAlreadySubmitted;

  return (
    <div
      className={clsx(
        'group relative aspect-square cursor-pointer overflow-hidden rounded-lg border-2 transition-all',
        isSelected
          ? 'border-green-500 shadow-[0_0_10px_rgba(81,207,102,0.4)]'
          : isValid
            ? 'border-[#373a40] hover:border-[#535458]'
            : 'border-red-500/50',
        disabled && 'cursor-not-allowed opacity-60'
      )}
      onClick={disabled ? undefined : onClick}
    >
      <EdgeMedia
        src={image.url}
        type={image.type}
        width={200}
        className="h-full w-full object-cover"
      />

      {/* Status Badge */}
      <Tooltip
        label={
          isAlreadySubmitted
            ? 'Already submitted to this crucible'
            : validationMessage || (isValid ? 'Valid entry' : 'Invalid entry')
        }
        withArrow
        position="top"
      >
        <div
          className={clsx(
            'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-white shadow-md',
            isAlreadySubmitted ? 'bg-gray-500' : isValid ? 'bg-green-500' : 'bg-red-500'
          )}
        >
          {isAlreadySubmitted ? (
            <IconCheck size={14} />
          ) : isValid ? (
            <IconCheck size={14} />
          ) : (
            <IconX size={14} />
          )}
        </div>
      </Tooltip>

      {/* Selection Indicator */}
      {isSelected && !disabled && (
        <div className="absolute inset-0 flex items-center justify-center bg-green-500/20">
          <div className="rounded-full bg-green-500 p-2">
            <IconCheck size={24} className="text-white" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CrucibleSubmitEntryModal - Modal for selecting and submitting images to a crucible
 */
export default function CrucibleSubmitEntryModal({
  crucibleId,
  crucibleName,
  entryFee,
  entryLimit,
  nsfwLevel,
  currentEntryCount,
  onSuccess,
}: CrucibleSubmitEntryModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();

  const [selectedImages, setSelectedImages] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch user's images
  const {
    data: imagesData,
    isLoading: isLoadingImages,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = trpc.image.getMyImages.useInfiniteQuery(
    { mediaTypes: [MediaType.image], limit: 40 },
    {
      enabled: !!currentUser,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  // Get images that are already submitted to this crucible
  const { data: crucibleData } = trpc.crucible.getById.useQuery(
    { id: crucibleId },
    { enabled: !!currentUser }
  );

  const submittedImageIds = useMemo(() => {
    if (!crucibleData?.entries || !currentUser) return new Set<number>();
    return new Set(
      crucibleData.entries.filter((e) => e.userId === currentUser.id).map((e) => e.imageId)
    );
  }, [crucibleData, currentUser]);

  // Flatten images from pages
  const images = useMemo(() => {
    return imagesData?.pages.flatMap((page) => page.items) ?? [];
  }, [imagesData]);

  // Calculate how many more entries the user can submit
  const remainingEntries = entryLimit - currentEntryCount;
  const canSubmitMore = remainingEntries > 0;

  // Validate image and check if it's selectable
  const validateImage = (image: (typeof images)[0]) => {
    const isCompatibleNsfw = isNsfwLevelCompatible(image.nsfwLevel ?? 1, nsfwLevel);
    const isAlreadySubmitted = submittedImageIds.has(image.id);

    return {
      isValid: isCompatibleNsfw && !isAlreadySubmitted,
      isAlreadySubmitted,
      message: isAlreadySubmitted
        ? 'Already submitted'
        : !isCompatibleNsfw
          ? `Content level mismatch (${getNsfwLabel(image.nsfwLevel ?? 1)} image, requires ${getNsfwLabel(nsfwLevel)})`
          : undefined,
    };
  };

  // Count valid selected images
  const validSelectedCount = selectedImages.filter((id) => {
    const img = images.find((i) => i.id === id);
    if (!img) return false;
    const { isValid } = validateImage(img);
    return isValid;
  }).length;

  // Total cost for selected images
  const totalCost = validSelectedCount * entryFee;

  // Can't select more than remaining entries
  const canSelectMore = selectedImages.length < remainingEntries;

  // Toggle image selection
  const toggleImage = (imageId: number) => {
    setSelectedImages((prev) => {
      if (prev.includes(imageId)) {
        return prev.filter((id) => id !== imageId);
      }
      if (!canSelectMore) {
        showErrorNotification({
          title: 'Entry limit reached',
          error: new Error(`You can only submit ${remainingEntries} more entries to this crucible`),
        });
        return prev;
      }
      return [...prev, imageId];
    });
  };

  // Submit entries mutation
  const submitEntryMutation = trpc.crucible.submitEntry.useMutation({
    onSuccess: () => {
      queryUtils.crucible.getById.invalidate({ id: crucibleId });
    },
  });

  // Handle submit
  const handleSubmit = async () => {
    if (validSelectedCount === 0) return;

    setIsSubmitting(true);

    try {
      // Submit each selected image
      const validImageIds = selectedImages.filter((id) => {
        const img = images.find((i) => i.id === id);
        if (!img) return false;
        const { isValid } = validateImage(img);
        return isValid;
      });

      for (const imageId of validImageIds) {
        await submitEntryMutation.mutateAsync({
          crucibleId,
          imageId,
        });
      }

      showSuccessNotification({
        title: 'Entries submitted!',
        message: `Successfully submitted ${validImageIds.length} ${validImageIds.length === 1 ? 'entry' : 'entries'} to ${crucibleName}`,
      });

      onSuccess?.();
      dialog.onClose();
    } catch (error) {
      showErrorNotification({
        title: 'Failed to submit entries',
        error: error instanceof Error ? error : new Error('An unknown error occurred'),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    dialog.onClose();
  };

  // Entry progress
  const entryProgress = ((currentEntryCount + validSelectedCount) / entryLimit) * 100;

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size={600}
      withCloseButton={false}
      padding={0}
      classNames={{
        content: 'bg-[#25262b] border border-[#373a40]',
      }}
    >
      <div className="flex max-h-[90vh] flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#373a40] p-5">
          <div className="flex-1">
            <Text fw={700} size="lg" c="white">
              Submit Entry
            </Text>
            <Text size="sm" c="dimmed">
              {crucibleName}
            </Text>
          </div>

          {/* Entry Progress */}
          <div className="w-44">
            <div className="mb-1 flex justify-between text-xs">
              <Text c="white" fw={600}>
                {currentEntryCount + validSelectedCount} of {entryLimit}
              </Text>
              <Text c="dimmed">entries</Text>
            </div>
            <Progress
              value={entryProgress}
              size={6}
              radius="xl"
              styles={{
                root: { backgroundColor: '#373a40' },
                section: {
                  background: 'linear-gradient(90deg, #228be6, #40c057)',
                },
              }}
            />
          </div>

          <CloseButton onClick={handleClose} c="dimmed" />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Entry Requirements */}
          <div className="mb-4 rounded-lg border border-[#373a40] bg-[#2c2e33] p-3">
            <Text size="xs" fw={600} tt="uppercase" className="mb-2 tracking-wide" c="dimmed">
              Entry Requirements
            </Text>
            <div className="flex flex-wrap gap-2">
              <Badge
                variant="light"
                color="blue"
                leftSection={<IconPhoto size={12} />}
                radius="sm"
                size="sm"
              >
                Images only
              </Badge>
              <Badge
                variant="light"
                color="blue"
                leftSection={<IconEye size={12} />}
                radius="sm"
                size="sm"
              >
                {getNsfwLabel(nsfwLevel)} content
              </Badge>
            </div>
          </div>

          {/* Images Grid */}
          {isLoadingImages ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : images.length === 0 ? (
            <div className="rounded-lg border-2 border-dashed border-[#373a40] bg-[#2c2e33] p-8 text-center">
              <IconCloudUpload size={48} className="mx-auto mb-3 text-blue-500" />
              <Text c="white" fw={600} mb={4}>
                No images found
              </Text>
              <Text size="sm" c="dimmed">
                You don&apos;t have any images to submit. Generate or upload images first.
              </Text>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                {images.map((image) => {
                  const { isValid, isAlreadySubmitted, message } = validateImage(image);
                  const isSelected = selectedImages.includes(image.id);

                  return (
                    <ImageCard
                      key={image.id}
                      image={{
                        id: image.id,
                        url: image.url,
                        nsfwLevel: image.nsfwLevel ?? 1,
                        type: image.type,
                        meta: image.meta,
                        createdAt: image.createdAt,
                      }}
                      isSelected={isSelected}
                      isValid={isValid}
                      validationMessage={message}
                      onClick={() => toggleImage(image.id)}
                      isAlreadySubmitted={isAlreadySubmitted}
                    />
                  );
                })}
              </div>

              {/* Load More */}
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isLoadingImages && !isFetchingNextPage}
                >
                  <Center py="md">
                    <Loader size="sm" />
                  </Center>
                </InViewLoader>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-[#373a40] p-5">
          <div className="flex gap-3">
            {/* Cancel Button */}
            <Button variant="default" onClick={handleClose} className="flex-shrink-0">
              Cancel
            </Button>

            {/* Submit Button with Buzz Cost */}
            <Button
              className="flex-1"
              disabled={validSelectedCount === 0 || isSubmitting || !canSubmitMore}
              onClick={handleSubmit}
              loading={isSubmitting}
              styles={{
                root: {
                  padding: 0,
                  display: 'flex',
                  overflow: 'hidden',
                },
                inner: {
                  display: 'flex',
                  width: '100%',
                },
              }}
            >
              <Group gap={0} className="w-full">
                <div
                  className="flex flex-1 items-center justify-center gap-2 py-2"
                  style={{ backgroundColor: '#fab005' }}
                >
                  <IconSend size={16} className="text-[#1a1b1e]" />
                  <Text fw={700} c="#1a1b1e">
                    Submit {validSelectedCount} {validSelectedCount === 1 ? 'Entry' : 'Entries'}
                  </Text>
                </div>
                <div
                  className="flex items-center gap-1 border-l border-[#373a40] px-3 py-2"
                  style={{ backgroundColor: '#1a1b1e' }}
                >
                  <IconBolt size={16} fill="#fab005" className="text-[#fab005]" />
                  <Text fw={700} c="#fab005">
                    {totalCost}
                  </Text>
                </div>
              </Group>
            </Button>
          </div>

          {/* Per Entry Cost */}
          <Text size="xs" c="dimmed" ta="center">
            {entryFee} Buzz per entry
          </Text>
        </div>
      </div>
    </Modal>
  );
}

