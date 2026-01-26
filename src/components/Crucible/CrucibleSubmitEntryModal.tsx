import {
  Button,
  Center,
  CloseButton,
  Group,
  HoverCard,
  Loader,
  Modal,
  Progress,
  Text,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import {
  IconAlertCircle,
  IconBolt,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCloudUpload,
  IconCube,
  IconEyeOff,
  IconPhoto,
  IconRefresh,
  IconSend,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import React, { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { MediaType } from '~/shared/utils/prisma/enums';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
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
  /** Optional array of allowed resource names to display in requirements */
  allowedResourceNames?: string[];
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
 * Validation criteria type for hover card display
 */
type ValidationCriterion = {
  label: string;
  passes: boolean;
  passText?: string;
  failReason?: string;
  /** Whether this criterion is pending server-side validation */
  pending?: boolean;
};

/**
 * Image card with selection and validation status
 * Shows detailed validation hover card matching mockup design
 */
function ImageCard({
  image,
  isSelected,
  isValid,
  validationCriteria,
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
  validationCriteria: ValidationCriterion[];
  onClick: () => void;
  isAlreadySubmitted: boolean;
}) {
  const disabled = !isValid || isAlreadySubmitted;

  return (
    <div
      className={clsx(
        'group relative aspect-square cursor-pointer overflow-visible rounded-lg border-2 transition-all',
        isSelected
          ? 'border-green-500 shadow-[0_0_10px_rgba(81,207,102,0.4)]'
          : isValid
          ? 'border-[#373a40] hover:border-[#535458]'
          : 'border-red-500/50',
        disabled && 'cursor-not-allowed opacity-60'
      )}
      onClick={disabled ? undefined : onClick}
    >
      <div className="size-full overflow-hidden rounded-md">
        <EdgeMedia
          src={image.url}
          type={image.type}
          width={200}
          className="size-full object-cover"
        />
      </div>

      {/* Status Badge with Hover Card */}
      <HoverCard
        width={220}
        shadow="lg"
        position="top"
        withArrow
        arrowSize={8}
        openDelay={100}
        closeDelay={50}
      >
        <HoverCard.Target>
          <div
            className={clsx(
              'absolute right-1.5 top-1.5 z-10 flex size-6 cursor-pointer items-center justify-center rounded-full text-white shadow-md transition-transform hover:scale-110',
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
        </HoverCard.Target>

        <HoverCard.Dropdown
          className="border border-[#373a40] bg-[#2c2e33] p-3"
          style={{ pointerEvents: 'auto' }}
        >
          {/* Hover Card Title */}
          <div
            className={clsx(
              'mb-2 flex items-center gap-1.5 text-xs font-semibold',
              isAlreadySubmitted ? 'text-gray-400' : isValid ? 'text-green-400' : 'text-red-400'
            )}
          >
            {isAlreadySubmitted ? (
              <>
                <IconCheck size={14} />
                Already Submitted
              </>
            ) : isValid ? (
              <>
                <IconCircleCheck size={14} />
                Valid Entry
              </>
            ) : (
              <>
                <IconCircleX size={14} />
                Invalid Entry
              </>
            )}
          </div>

          {/* Validation Criteria List */}
          {!isAlreadySubmitted && (
            <div className="flex flex-col gap-1">
              {validationCriteria.map((criterion, idx) => (
                <div key={idx} className="flex items-center gap-2 text-[0.7rem]">
                  {/* Criterion Icon */}
                  <div
                    className={clsx(
                      'flex size-3.5 shrink-0 items-center justify-center rounded-full',
                      criterion.pending
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : criterion.passes
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-red-500/20 text-red-400'
                    )}
                  >
                    {criterion.pending ? (
                      <IconAlertCircle size={10} />
                    ) : criterion.passes ? (
                      <IconCheck size={10} />
                    ) : (
                      <IconX size={10} />
                    )}
                  </div>
                  {/* Criterion Text */}
                  <span
                    className={clsx(
                      criterion.pending
                        ? 'text-yellow-400'
                        : criterion.passes
                        ? 'text-[#c1c2c5]'
                        : 'text-red-400'
                    )}
                  >
                    {criterion.pending
                      ? criterion.failReason || criterion.label
                      : criterion.passes
                      ? criterion.passText || criterion.label
                      : criterion.failReason || criterion.label}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Already submitted message */}
          {isAlreadySubmitted && (
            <Text size="xs" c="dimmed">
              This image is already submitted to this crucible.
            </Text>
          )}
        </HoverCard.Dropdown>
      </HoverCard>

      {/* Selection Indicator */}
      {isSelected && !disabled && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-green-500/20">
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
  allowedResourceNames,
  onSuccess,
}: CrucibleSubmitEntryModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const [selectedImages, setSelectedImages] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);

  // Image upload handling
  const {
    upload: uploadImages,
    files: uploadingFiles,
    progress: uploadProgress,
    canAdd: canUpload,
    loading: isUploading,
  } = useMediaUpload({
    count: uploadedCount,
    onComplete: (props) => {
      if (props.status === 'added') {
        // Refresh the image list when an upload completes
        queryUtils.image.getMyImages.invalidate();
        setUploadedCount((prev) => prev + 1);
        showSuccessNotification({
          title: 'Image uploaded',
          message: 'Your image is now available for selection',
        });
      } else if (props.status === 'error') {
        showErrorNotification({
          title: 'Upload failed',
          error: new Error('Failed to upload image. Please try again.'),
        });
      } else if (props.status === 'blocked') {
        showErrorNotification({
          title: 'Image blocked',
          error: new Error(`Image was blocked: ${props.blockedFor || 'Content policy violation'}`),
        });
      }
    },
  });

  const handleDrop = (files: File[]) => {
    if (!canUpload || currentUser?.muted) return;
    uploadImages(files.map((file) => ({ file })));
  };

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
  // Returns detailed validation criteria for hover card display
  const validateImage = (image: (typeof images)[0]) => {
    const isCompatibleNsfw = isNsfwLevelCompatible(image.nsfwLevel ?? 1, nsfwLevel);
    const isAlreadySubmitted = submittedImageIds.has(image.id);
    const imageNsfwLabel = getNsfwLabel(image.nsfwLevel ?? 1);
    const requiredNsfwLabel = getNsfwLabel(nsfwLevel);

    // Build detailed validation criteria
    // Only include model requirement if there are restrictions (allowedResourceNames specified)
    const hasModelRestrictions = allowedResourceNames && allowedResourceNames.length > 0;
    const criteria: ValidationCriterion[] = [
      // Only show model criterion when there are restrictions
      // Since we can't validate client-side, mark as pending validation
      ...(hasModelRestrictions
        ? [
            {
              label: `Uses ${allowedResourceNames[0] ?? 'required model'}`,
              passes: true, // Treat as passing for selection, server validates on submit
              pending: true, // Show as pending to indicate server-side validation
              failReason: 'Validated on submit',
            },
          ]
        : []),
      {
        label: 'Image type',
        passes: image.type === MediaType.image,
        passText: 'Valid image format',
        failReason: 'Must be an image file',
      },
      {
        label: 'Content level',
        passes: isCompatibleNsfw,
        passText: `${imageNsfwLabel} content`,
        failReason: `${imageNsfwLabel} content (requires ${requiredNsfwLabel})`,
      },
    ];

    return {
      isValid: isCompatibleNsfw && !isAlreadySubmitted,
      isAlreadySubmitted,
      criteria,
      message: isAlreadySubmitted
        ? 'Already submitted'
        : !isCompatibleNsfw
        ? `Content level mismatch (${imageNsfwLabel} image, requires ${requiredNsfwLabel})`
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

  // Track last error for retry functionality
  const [lastError, setLastError] = useState<Error | null>(null);

  // Handle submit
  const handleSubmit = async () => {
    if (validSelectedCount === 0) return;

    setIsSubmitting(true);
    setLastError(null);

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
        message: `Successfully submitted ${validImageIds.length} ${
          validImageIds.length === 1 ? 'entry' : 'entries'
        } to ${crucibleName}`,
      });

      onSuccess?.();
      dialog.onClose();
    } catch (error) {
      const err = error instanceof Error ? error : new Error('An unknown error occurred');
      setLastError(err);

      // Check if it's a network error or a validation error
      const isNetworkError =
        err.message.includes('fetch') ||
        err.message.includes('network') ||
        err.message.includes('Failed to fetch') ||
        err.message.includes('NetworkError') ||
        err.message.includes('timeout');

      if (isNetworkError) {
        showErrorNotification({
          title: 'Network Error',
          error: {
            message: 'Unable to connect to server. Please check your connection and try again.',
          },
          autoClose: 5000,
        });
      } else {
        showErrorNotification({
          title: 'Failed to submit entries',
          error: err,
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Retry handler for network errors
  const handleRetry = () => {
    if (lastError) {
      handleSubmit();
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
          <div className="mb-4 rounded-lg border border-[#373a40] bg-[#2c2e33] px-4 py-3">
            <Text
              size="xs"
              fw={600}
              tt="uppercase"
              className="mb-2 tracking-wide"
              c="dimmed"
              style={{ fontSize: '0.7rem', letterSpacing: '0.5px' }}
            >
              Entry Requirements
            </Text>
            <div className="flex flex-wrap gap-2">
              {/* Model Requirements Badge */}
              <div
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5"
                style={{
                  background: 'rgba(34, 139, 230, 0.1)',
                  border: '1px solid rgba(34, 139, 230, 0.3)',
                  color: '#74c0fc',
                  fontSize: '0.75rem',
                }}
              >
                <IconCube size={14} />
                <span>
                  {allowedResourceNames && allowedResourceNames.length > 0
                    ? allowedResourceNames.length === 1
                      ? allowedResourceNames[0]
                      : `${allowedResourceNames.length} models`
                    : 'Any model'}
                </span>
              </div>

              {/* Image Type Badge */}
              <div
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5"
                style={{
                  background: 'rgba(34, 139, 230, 0.1)',
                  border: '1px solid rgba(34, 139, 230, 0.3)',
                  color: '#74c0fc',
                  fontSize: '0.75rem',
                }}
              >
                <IconPhoto size={14} />
                <span>Images only</span>
              </div>

              {/* Content Level Badge */}
              <div
                className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5"
                style={{
                  background: 'rgba(34, 139, 230, 0.1)',
                  border: '1px solid rgba(34, 139, 230, 0.3)',
                  color: '#74c0fc',
                  fontSize: '0.75rem',
                }}
              >
                <IconEyeOff size={14} />
                <span>{getNsfwLabel(nsfwLevel)} only</span>
              </div>
            </div>
          </div>

          {/* Drop Zone */}
          <Dropzone
            onDrop={handleDrop}
            accept={IMAGE_MIME_TYPE}
            disabled={!canUpload || isUploading || currentUser?.muted}
            loading={isUploading}
            className={clsx(
              'mb-6 rounded-xl border-2 border-dashed bg-[#2c2e33] p-8 text-center transition-all',
              isUploading || !canUpload
                ? 'cursor-not-allowed border-[#373a40] opacity-60'
                : 'cursor-pointer border-[#373a40] hover:border-blue-500 hover:bg-[rgba(34,139,230,0.05)]'
            )}
          >
            <div className="pointer-events-none flex flex-col items-center justify-center gap-2">
              <Dropzone.Accept>
                <IconUpload size={48} className="text-blue-500" stroke={1.5} />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={48} className="text-red-500" stroke={1.5} />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconCloudUpload size={48} className="text-blue-500" stroke={1.5} />
              </Dropzone.Idle>
              <Text c="white" fw={600}>
                Drag images here to add entries
              </Text>
              <Text size="sm" c="dimmed">
                or{' '}
                <Text component="span" c="blue" className="cursor-pointer underline">
                  click to browse
                </Text>
              </Text>
            </div>
          </Dropzone>

          {/* Upload Progress */}
          {uploadingFiles.length > 0 && (
            <div className="mb-4">
              <Progress
                value={uploadProgress}
                size="sm"
                radius="xl"
                animated
                styles={{
                  root: { backgroundColor: '#373a40' },
                  section: { background: 'linear-gradient(90deg, #228be6, #40c057)' },
                }}
              />
              <Text size="xs" c="dimmed" ta="center" mt={4}>
                Uploading {uploadingFiles.length} {uploadingFiles.length === 1 ? 'image' : 'images'}
                ...
              </Text>
            </div>
          )}

          {/* Images Grid */}
          {isLoadingImages ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : images.length === 0 ? (
            <div className="rounded-lg border border-[#373a40] bg-[#2c2e33] p-8 text-center">
              <Text c="white" fw={600} mb={4}>
                No images found
              </Text>
              <Text size="sm" c="dimmed">
                Upload images above or generate images to get started.
              </Text>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                {images.map((image) => {
                  const { isValid, isAlreadySubmitted, criteria } = validateImage(image);
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
                      validationCriteria={criteria}
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
          {/* Error with Retry */}
          {lastError && !isSubmitting && (
            <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 p-3">
              <Text size="sm" c="red.4">
                Something went wrong. Please try again.
              </Text>
              <Button
                size="xs"
                variant="light"
                color="red"
                leftSection={<IconRefresh size={14} />}
                onClick={handleRetry}
              >
                Retry
              </Button>
            </div>
          )}

          <div className="flex gap-3">
            {/* Cancel Button */}
            <Button variant="default" onClick={handleClose} className="shrink-0">
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
