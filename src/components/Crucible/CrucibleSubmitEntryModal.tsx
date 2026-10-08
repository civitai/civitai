import {
  Alert,
  Badge,
  Button,
  Center,
  CloseButton,
  HoverCard,
  Loader,
  Modal,
  Progress,
  Tabs,
  Text,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import {
  IconAlertCircle,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCloudUpload,
  IconCube,
  IconPhoto,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconUpload,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { CrucibleContentLevelBadges } from '~/components/Crucible/CrucibleContentLevelBadges';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { GeneratorMediaCandidate } from '~/components/EntrySubmit/GeneratorMediaPicker';
import {
  GeneratorMediaPicker,
  useGeneratorSelectionStore,
} from '~/components/EntrySubmit/GeneratorMediaPicker';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import {
  clipLengthAllowed,
  CRUCIBLE_ENTRIES_CLOSED_MESSAGE,
  CRUCIBLE_ENTRY_WARNING_PERCENT,
} from '~/shared/constants/crucible.constants';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { formatDuration, numberWithCommas } from '~/utils/number-helpers';
import { Currency, ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { addPostImageSchema } from '~/server/schema/post.schema';
import { downloadGeneratorImages } from '~/utils/generator-import';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { getMimeTypesFromMediaTypes } from '~/shared/constants/mime-types';
import { trpc } from '~/utils/trpc';
import {
  getCrucibleEntriesCost,
  getCrucibleRatingLabel,
  getFreeEntriesLabel,
  areCrucibleEntriesClosed,
  getCrucibleEntriesCloseAt,
  isCrucibleFinalStretch,
} from '~/utils/crucible-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { Flags } from '~/shared/utils/flags';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import clsx from 'clsx';
import { formatDate } from '~/utils/date-helpers';

/**
 * Props for the CrucibleSubmitEntryModal
 */
export interface CrucibleSubmitEntryModalProps {
  crucibleId: number;
  crucibleName: string;
  entryFee: number;
  buzzType?: BuzzSpendType;
  entryLimit: number;
  /** Each person's first entries that skip the fee. */
  freeEntriesPerUser?: number;
  nsfwLevel: number;
  contentType: MediaType;
  currentEntryCount: number;
  /** Every entry made so far, withdrawn ones included, for the free-entry math. */
  entriesSoFar?: number;
  /** Longest clip this crucible accepts, in seconds. Null or absent means no limit. */
  maxClipSeconds?: number | null;
  /** Whether entries must be made with one of the crucible's required models. */
  requiresResources?: boolean;
  /** Entries must be made with a checkpoint of one of these base models. */
  allowedBaseModels?: string[];
  startAt?: Date | null;
  endAt?: Date | null;
  /** Share of the run, counted back from the end, in which entrants are warned. */
  entryWarningPercent?: number;
  /** Share of the run, counted back from the end, in which entries are closed. */
  entryCutoffPercent?: number;
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

const requirementBadgeProps = {
  variant: 'light',
  color: 'blue',
  size: 'sm',
  radius: 'sm',
  tt: 'none',
} as const;

function TabCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge size="sm" variant="filled" circle>
      {count}
    </Badge>
  );
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
  isChecking,
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
  isChecking: boolean;
}) {
  const disabled = !isValid || isAlreadySubmitted;

  return (
    <div
      className={clsx(
        'group relative aspect-square cursor-pointer overflow-visible rounded-lg border-2 transition-all',
        isSelected
          ? 'border-green-500 shadow-[0_0_10px_rgba(81,207,102,0.4)]'
          : isChecking
          ? 'border-yellow-500/50'
          : isValid
          ? 'border-[#373a40] hover:border-[#535458]'
          : 'border-red-500/50',
        disabled && (isChecking ? 'cursor-wait' : 'cursor-not-allowed opacity-60')
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
        withinPortal
        zIndex={1000}
      >
        <HoverCard.Target>
          <div
            className={clsx(
              'absolute right-1.5 top-1.5 z-10 flex size-6 cursor-pointer items-center justify-center rounded-full text-white shadow-md transition-transform hover:scale-110',
              isAlreadySubmitted
                ? 'bg-gray-500'
                : isChecking
                ? 'bg-yellow-500'
                : isValid
                ? 'bg-green-500'
                : 'bg-red-500'
            )}
          >
            {isChecking ? (
              <Loader size={12} color="white" />
            ) : isAlreadySubmitted ? (
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
              isAlreadySubmitted
                ? 'text-gray-400'
                : isChecking
                ? 'text-yellow-400'
                : isValid
                ? 'text-green-400'
                : 'text-red-400'
            )}
          >
            {isChecking ? (
              <>
                <IconAlertCircle size={14} />
                Checking…
              </>
            ) : isAlreadySubmitted ? (
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
              This entry is already submitted to this crucible.
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
 * CrucibleSubmitEntryModal - Modal for selecting and submitting entries to a crucible
 */
export default function CrucibleSubmitEntryModal({
  crucibleId,
  crucibleName,
  entryFee,
  buzzType,
  entryLimit,
  freeEntriesPerUser = 0,
  nsfwLevel,
  contentType,
  currentEntryCount,
  entriesSoFar = currentEntryCount,
  maxClipSeconds,
  requiresResources = false,
  allowedBaseModels = [],
  allowedResourceNames,
  startAt = null,
  endAt = null,
  entryWarningPercent = CRUCIBLE_ENTRY_WARNING_PERCENT.default,
  entryCutoffPercent = 0,
  onSuccess,
}: CrucibleSubmitEntryModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const isVideo = contentType === MediaType.video;
  const noun = isVideo ? 'video' : 'image';
  const nounPlural = `${noun}s`;

  const [selectedImages, setSelectedImages] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [activeTab, setActiveTab] = useState<string | null>('library');
  const [isImporting, setIsImporting] = useState(false);
  // Media added from this modal is selected for the user once its scan settles.
  const [awaitingScan, setAwaitingScan] = useState<number[]>([]);
  // A generator submit enters its media as soon as every scan has settled.
  const [autoSubmit, setAutoSubmit] = useState<{
    expected: number;
    valid: number[];
    failed: number;
  } | null>(null);
  const countAutoSubmitFailure = () =>
    setAutoSubmit((prev) => prev && { ...prev, failed: prev.failed + 1 });

  const generatorSelected = useGeneratorSelectionStore((state) => state.selected);
  const deselectAllGenerator = useGeneratorSelectionStore((state) => state.deselectAll);

  const createEntryPostMutation = trpc.crucible.createEntryPost.useMutation();
  const addImageMutation = trpc.post.addImage.useMutation({
    onSuccess: (image) => {
      setAwaitingScan((prev) => [...prev, image.id]);
      queryUtils.image.getMyImages.invalidate();
    },
    onError: (error) => {
      countAutoSubmitFailure();
      showErrorNotification({ title: `Failed to add ${noun}`, error: new Error(error.message) });
    },
  });

  // Image upload handling
  const {
    upload: uploadImages,
    files: uploadingFiles,
    progress: uploadProgress,
    canAdd: canUpload,
    loading: isUploading,
  } = useMediaUpload<{ postId: number }>({
    count: uploadedCount,
    onComplete: (props, context) => {
      if (props.status === 'added') {
        if (!context?.postId) return;
        setUploadedCount((prev) => prev + 1);
        addImageMutation.mutate(
          addPostImageSchema.parse({
            ...props,
            postId: context.postId,
            width: props.metadata.width,
            height: props.metadata.height,
            hash: props.metadata.hash,
            generationWorkflowId: props.generationWorkflowId,
          })
        );
      } else if (props.status === 'error') {
        countAutoSubmitFailure();
        showErrorNotification({
          title: 'Upload failed',
          error: new Error(`Failed to upload ${noun}. Please try again.`),
        });
      } else if (props.status === 'blocked') {
        countAutoSubmitFailure();
        showErrorNotification({
          title: `${isVideo ? 'Video' : 'Image'} blocked`,
          error: new Error(
            `${isVideo ? 'Video' : 'Image'} was blocked: ${
              props.blockedFor || 'Content policy violation'
            }`
          ),
        });
      }
    },
  });

  /** Resolves to how many files started uploading. */
  const addToLibrary = async (
    fileData: { file: File; meta?: Record<string, unknown>; generationWorkflowId?: string }[]
  ) => {
    if (!fileData.length || currentUser?.muted) return 0;
    const postIds: number[] = [];
    try {
      // A post per file, so entering one image schedules only that image.
      for (const file of fileData) {
        const post = await createEntryPostMutation.mutateAsync({ crucibleId });
        postIds.push(post.id);
        uploadImages([file], { postId: post.id });
      }
    } catch (error) {
      showErrorNotification({
        title: `Unable to add ${nounPlural}`,
        error: error instanceof Error ? error : new Error('Unknown error'),
      });
    }
    if (postIds.length) {
      setActiveTab('library');
    }
    return postIds.length;
  };

  const handleDrop = (files: File[]) => {
    if (!canUpload) return;
    addToLibrary(files.map((file) => ({ file })));
  };

  const handleGeneratorSubmit = async () => {
    setIsImporting(true);
    try {
      const files = await downloadGeneratorImages(generatorSelected.slice(0, remainingEntries));
      if (!files.length) throw new Error('Failed to download generator media. Please try again.');
      deselectAllGenerator();
      setAutoSubmit({ expected: files.length, valid: [], failed: 0 });
      const started = await addToLibrary(files);
      setAutoSubmit((prev) => (started && prev ? { ...prev, expected: started } : null));
    } catch (error) {
      showErrorNotification({
        title: 'Import failed',
        error: error instanceof Error ? error : new Error('Unknown error'),
      });
    } finally {
      setIsImporting(false);
    }
  };

  const getGeneratorEligibility = useCallback(
    ({ type, nsfwLevel: level }: GeneratorMediaCandidate) => {
      const reasons: string[] = [];
      if (type !== contentType) reasons.push(`${isVideo ? 'Videos' : 'Images'} only`);
      if (level !== null && level !== 0 && !isNsfwLevelCompatible(level, nsfwLevel))
        reasons.push(`${getCrucibleRatingLabel(nsfwLevel)} only`);
      return { eligible: reasons.length === 0, reasons };
    },
    [contentType, isVideo, nsfwLevel]
  );

  // Fetch user's images
  const {
    data: imagesData,
    isLoading: isLoadingImages,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = trpc.image.getMyImages.useInfiniteQuery(
    {
      mediaTypes: [contentType],
      limit: 40,
      publishedOnly: true,
      // Media added here sits in an unpublished post until it is entered.
      includeEntryDrafts: true,
    },
    {
      enabled: !!currentUser,
      placeholderData: (previous) => previous,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) =>
          page.items.some((item) => item.ingestion === ImageIngestionStatus.Pending)
        )
          ? 5000
          : false,
    }
  );

  const entryWindow = { startAt, endAt, entryCutoffPercent };
  const entriesClosed = areCrucibleEntriesClosed(entryWindow);
  const entriesCloseAt = entryCutoffPercent ? getCrucibleEntriesCloseAt(entryWindow) : null;
  const inFinalStretch =
    !entriesClosed && isCrucibleFinalStretch({ startAt, endAt, percent: entryWarningPercent });
  const { data: minVotesToPlace } = trpc.crucible.getMinVotesToPlace.useQuery(
    { id: crucibleId },
    { enabled: !!currentUser && inFinalStretch }
  );
  const minVotes = inFinalStretch ? minVotesToPlace?.minVotes ?? 0 : 0;

  // Get images that are already submitted to this crucible
  const { data: crucibleData } = trpc.crucible.getById.useQuery(
    { id: crucibleId },
    { enabled: !!currentUser }
  );

  const submittedImageIds = useMemo(() => {
    return new Set(crucibleData?.viewerEntries.map((e) => e.imageId) ?? []);
  }, [crucibleData]);

  // Flatten images from pages
  const images = useMemo(() => {
    return imagesData?.pages.flatMap((page) => page.items) ?? [];
  }, [imagesData]);

  // Answered with submission's own rule — don't re-derive recency from the listing's `createdAt`.
  const imageIds = useMemo(() => images.map((image) => image.id), [images]);
  const { data: eligibility } = trpc.crucible.checkEntryEligibility.useQuery(
    { crucibleId, imageIds },
    { enabled: !!currentUser && imageIds.length > 0, placeholderData: (previous) => previous }
  );
  const ineligibleReasonsById = useMemo(
    () => new Map(eligibility?.map(({ imageId, reasons }) => [imageId, reasons])),
    [eligibility]
  );

  // Calculate how many more entries the user can submit
  const remainingEntries = entryLimit - currentEntryCount;
  const canSubmitMore = remainingEntries > 0 && !entriesClosed;

  // Validate image and check if it's selectable
  // Returns detailed validation criteria for hover card display
  const validateImage = (image: (typeof images)[0]) => {
    if (image.ingestion === ImageIngestionStatus.Pending) {
      return {
        isValid: false,
        isAlreadySubmitted: false,
        isChecking: true,
        criteria: [
          {
            label: 'Content scan',
            passes: false,
            pending: true,
            failReason: 'Selectable once the content scan finishes',
          },
        ],
        message: 'Scanning',
      };
    }

    const isCompatibleNsfw = isNsfwLevelCompatible(image.nsfwLevel ?? 1, nsfwLevel);
    const matchesContentType = image.type === contentType;
    const isAlreadySubmitted = submittedImageIds.has(image.id);
    const clipSeconds = (image.metadata as VideoMetadata | null)?.duration ?? null;
    const isShortEnough = clipLengthAllowed(clipSeconds, maxClipSeconds ?? null);
    const imageNsfwLabel = getCrucibleRatingLabel(image.nsfwLevel ?? 1);
    const requiredNsfwLabel = getCrucibleRatingLabel(nsfwLevel);

    const ineligibleReasons = ineligibleReasonsById.get(image.id);
    const eligibilityPending = ineligibleReasons === undefined;
    const isRecentEnough = !ineligibleReasons?.includes('created-before-start');
    const levelAllowedByModels = !ineligibleReasons?.includes('required-model-level');
    const hasNoResources = !!ineligibleReasons?.includes('no-resources');
    const usesRequiredModel =
      !hasNoResources && !ineligibleReasons?.includes('missing-required-resource');
    const usesAllowedBaseModel =
      !hasNoResources && !ineligibleReasons?.includes('wrong-base-model');
    const requiresBaseModel = allowedBaseModels.length > 0;
    const requiredModelLabel = allowedResourceNames?.length
      ? `Uses ${allowedResourceNames.join(' or ')}`
      : 'Uses a required model';

    const criteria: ValidationCriterion[] = [
      ...(requiresResources
        ? [
            {
              label: requiredModelLabel,
              passes: usesRequiredModel,
              pending: eligibilityPending,
              failReason: eligibilityPending
                ? 'Checking the models used…'
                : hasNoResources
                ? 'No models detected on this image'
                : 'Does not use a required model',
            },
          ]
        : []),
      ...(requiresBaseModel
        ? [
            {
              label: `Made with a ${allowedBaseModels.join(' or ')} checkpoint`,
              passes: usesAllowedBaseModel,
              pending: eligibilityPending,
              failReason: eligibilityPending
                ? 'Checking the models used…'
                : hasNoResources
                ? 'No models detected on this image'
                : 'Not made with an allowed base model',
            },
          ]
        : []),
      {
        label: 'Created after the crucible started',
        passes: isRecentEnough,
        pending: eligibilityPending,
        failReason: eligibilityPending
          ? 'Checking when it was created…'
          : 'Created before it started',
      },
      {
        label: 'Media type',
        passes: matchesContentType,
        passText: `Valid ${noun} format`,
        failReason: `Must be a ${noun} file`,
      },
      {
        label: 'Content level',
        passes: isCompatibleNsfw && levelAllowedByModels,
        passText: `${imageNsfwLabel} content`,
        failReason: !isCompatibleNsfw
          ? `${imageNsfwLabel} content (requires ${requiredNsfwLabel})`
          : `${imageNsfwLabel} content (a required model allows only PG and PG-13)`,
      },
      ...(maxClipSeconds
        ? [
            {
              label: 'Clip length',
              passes: isShortEnough,
              passText: clipSeconds ? formatDuration(clipSeconds) : 'Within the limit',
              failReason: `${formatDuration(Math.ceil(clipSeconds ?? 0))} (max ${formatDuration(
                maxClipSeconds
              )})`,
            },
          ]
        : []),
    ];

    return {
      isValid:
        isCompatibleNsfw &&
        matchesContentType &&
        isShortEnough &&
        !isAlreadySubmitted &&
        !eligibilityPending &&
        ineligibleReasons.length === 0 &&
        isRecentEnough &&
        (!requiresResources || usesRequiredModel) &&
        (!requiresBaseModel || usesAllowedBaseModel),
      isAlreadySubmitted,
      isChecking:
        eligibilityPending &&
        !isAlreadySubmitted &&
        isCompatibleNsfw &&
        matchesContentType &&
        isShortEnough,
      criteria,
      message: isAlreadySubmitted
        ? 'Already submitted'
        : !matchesContentType
        ? `This crucible only accepts ${nounPlural}`
        : !isCompatibleNsfw
        ? `Content level mismatch (${imageNsfwLabel} ${noun}, requires ${requiredNsfwLabel})`
        : !isShortEnough
        ? // Ceiling, so a 120.01s clip against a 120s limit does not render both as "2:00".
          `Too long (${formatDuration(Math.ceil(clipSeconds ?? 0))}, max ${formatDuration(
            maxClipSeconds as number
          )})`
        : !levelAllowedByModels
        ? 'A required model allows only PG and PG-13'
        : !isRecentEnough
        ? 'Created before this crucible started'
        : requiresResources && !usesRequiredModel
        ? 'Does not use a required model'
        : requiresBaseModel && !usesAllowedBaseModel
        ? 'Not made with an allowed base model'
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

  const totalCost = getCrucibleEntriesCost({
    entriesSoFar,
    count: validSelectedCount,
    freeEntriesPerUser,
    entryFee,
  });
  const freeEntriesLabel = getFreeEntriesLabel({ freeEntriesPerUser, entryLimit });
  const entriesLabel = (count: number) => `Submit ${count} ${count === 1 ? 'Entry' : 'Entries'}`;
  const submitLabel = entriesLabel(validSelectedCount);
  const generatorEntryCount = Math.max(0, Math.min(generatorSelected.length, remainingEntries));
  const generatorCost = getCrucibleEntriesCost({
    entriesSoFar,
    count: generatorEntryCount,
    freeEntriesPerUser,
    entryFee,
  });

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

  // A scan that sends an upload to review or blocks it drops it from the list instead of settling
  // it, so an upload seen and then gone counts as failed rather than holding the batch forever.
  const seenAwaitingScan = useRef(new Set<number>());
  useEffect(() => {
    if (!awaitingScan.length) return;
    const listedIds = new Set(images.map((image) => image.id));
    for (const id of awaitingScan) if (listedIds.has(id)) seenAwaitingScan.current.add(id);
    const vanished = awaitingScan.filter(
      (id) => seenAwaitingScan.current.has(id) && !listedIds.has(id)
    );
    const settled = images.filter(
      (image) =>
        awaitingScan.includes(image.id) &&
        !validateImage(image).isChecking &&
        ineligibleReasonsById.has(image.id)
    );
    if (!settled.length && !vanished.length) return;
    setAwaitingScan((prev) =>
      prev.filter((id) => !vanished.includes(id) && !settled.some((image) => image.id === id))
    );
    const settledValid = settled.filter((image) => validateImage(image).isValid);
    setAutoSubmit(
      (prev) =>
        prev && {
          ...prev,
          valid: [...prev.valid, ...settledValid.map((image) => image.id)],
          failed: prev.failed + vanished.length + settled.length - settledValid.length,
        }
    );
    setSelectedImages((prev) => {
      const next = [...prev];
      for (const image of settled) {
        if (next.length >= remainingEntries) break;
        if (!next.includes(image.id) && validateImage(image).isValid) next.push(image.id);
      }
      return next;
    });
    // validateImage is recreated each render; the deps below are what change its outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, awaitingScan, remainingEntries, ineligibleReasonsById]);

  // A refused submit means the page's entry count disagrees with the server's, so resync on failure too.
  const submitEntryMutation = trpc.crucible.submitEntry.useMutation({
    onSettled: () => {
      queryUtils.crucible.getById.invalidate({ id: crucibleId });
      queryUtils.crucible.getEntries.invalidate({ crucibleId });
    },
  });

  // Track last error for retry functionality
  const [lastError, setLastError] = useState<Error | null>(null);

  const submitImages = async (validImageIds: number[]) => {
    setIsSubmitting(true);
    setLastError(null);

    try {
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

  const handleSubmit = () => {
    const validImageIds = selectedImages.filter((id) => {
      const img = images.find((i) => i.id === id);
      return !!img && validateImage(img).isValid;
    });
    if (validImageIds.length) return submitImages(validImageIds);
  };

  useEffect(() => {
    if (!autoSubmit || isSubmitting) return;
    if (autoSubmit.valid.length + autoSubmit.failed < autoSubmit.expected) return;
    setAutoSubmit(null);
    if (autoSubmit.failed)
      showErrorNotification({
        title: `${autoSubmit.failed} couldn't be entered`,
        error: new Error(
          `They weren't published. Hover them in My ${isVideo ? 'Videos' : 'Images'} to see why.`
        ),
      });
    if (autoSubmit.valid.length) submitImages(autoSubmit.valid);
    // submitImages is recreated each render; autoSubmit is what decides to call it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, isSubmitting]);

  // Retry handler for network errors
  const handleRetry = () => {
    if (lastError) {
      handleSubmit();
    }
  };

  const handleClose = () => {
    deselectAllGenerator();
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
      // Mantine scrolls the content itself; only the body below should, so its height flows down.
      classNames={{
        content: 'bg-[#25262b] border border-[#373a40] flex flex-col overflow-hidden',
        body: 'flex min-h-0 flex-1 flex-col',
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5">
          <div className="flex-1">
            <Text fw={700} size="lg" c="white">
              Submit Entry
            </Text>
            <Text size="sm" c="dimmed">
              {crucibleName}
            </Text>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge {...requirementBadgeProps} leftSection={<IconCube size={12} />}>
                {allowedResourceNames && allowedResourceNames.length > 0
                  ? allowedResourceNames.length === 1
                    ? allowedResourceNames[0]
                    : `${allowedResourceNames.length} models`
                  : requiresResources
                  ? 'Required models only'
                  : 'Any model'}
              </Badge>
              <Badge
                {...requirementBadgeProps}
                leftSection={isVideo ? <IconVideo size={12} /> : <IconPhoto size={12} />}
              >
                {isVideo ? 'Videos only' : 'Images only'}
              </Badge>
              {allowedBaseModels.length > 0 && (
                <Badge {...requirementBadgeProps} leftSection={<IconCube size={12} />}>
                  {allowedBaseModels.join(' / ')}
                </Badge>
              )}
              <CrucibleContentLevelBadges nsfwLevel={nsfwLevel} className="contents" />
            </div>
          </div>

          {/* Entry Progress */}
          <div className="w-44">
            <div className="mb-1 flex justify-between text-xs">
              <Text c="dimmed">Entries</Text>
              <Text c="white" fw={600}>
                {currentEntryCount + validSelectedCount} of {entryLimit}
              </Text>
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
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {entriesClosed && (
            <Alert color="red" radius="md" mb="md" icon={<IconAlertCircle size={16} />}>
              {CRUCIBLE_ENTRIES_CLOSED_MESSAGE}
            </Alert>
          )}
          {minVotes > 0 && (
            <Alert color="yellow" radius="md" mb="md" icon={<IconAlertCircle size={16} />}>
              This crucible is close to ending. An entry needs about {numberWithCommas(minVotes)}{' '}
              {minVotes === 1 ? 'vote' : 'votes'} to place and win a prize, and a new one may not
              get there in time.
              {entriesCloseAt && (
                <> Entries close {formatDate(entriesCloseAt, 'MMM D [at] h:mm A')}.</>
              )}
            </Alert>
          )}
          <Tabs value={activeTab} onChange={setActiveTab} classNames={{ panel: 'pt-4' }}>
            <Tabs.List>
              <Tabs.Tab
                value="library"
                leftSection={isVideo ? <IconVideo size={16} /> : <IconPhoto size={16} />}
                rightSection={<TabCount count={selectedImages.length} />}
              >
                My {isVideo ? 'Videos' : 'Images'}
              </Tabs.Tab>
              <Tabs.Tab
                value="generator"
                leftSection={<IconSparkles size={16} />}
                rightSection={<TabCount count={generatorSelected.length} />}
              >
                From Generator
              </Tabs.Tab>
              <Tabs.Tab
                value="upload"
                leftSection={<IconUpload size={16} />}
                rightSection={<TabCount count={uploadingFiles.length} />}
              >
                Upload New
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="library">
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
                    Uploading {uploadingFiles.length}{' '}
                    {uploadingFiles.length === 1 ? noun : nounPlural}
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
                    No {nounPlural} found
                  </Text>
                  <Text size="sm" c="dimmed">
                    Upload {nounPlural} or pick some from the generator to get started.
                  </Text>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                    {images.map((image) => {
                      const { isValid, isAlreadySubmitted, isChecking, criteria } =
                        validateImage(image);
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
                          isChecking={isChecking}
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
            </Tabs.Panel>

            <Tabs.Panel value="generator">
              <GeneratorMediaPicker
                getEligibility={getGeneratorEligibility}
                gridClassName="grid-cols-3"
                maxHeight={420}
                workflowTag={isVideo ? WORKFLOW_TAGS.VIDEO : WORKFLOW_TAGS.IMAGE}
              />
            </Tabs.Panel>

            <Tabs.Panel value="upload">
              {/* Drop Zone */}
              <Dropzone
                onDrop={handleDrop}
                accept={getMimeTypesFromMediaTypes([contentType])}
                disabled={!canUpload || isUploading || currentUser?.muted}
                loading={isUploading}
                className={clsx(
                  'rounded-xl border-2 border-dashed bg-[#2c2e33] p-8 text-center transition-all',
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
                    Drag {nounPlural} here to add them to your library
                  </Text>
                  <Text size="sm" c="dimmed">
                    or{' '}
                    <Text component="span" c="blue" className="cursor-pointer underline">
                      click to browse
                    </Text>
                  </Text>
                </div>
              </Dropzone>
            </Tabs.Panel>
          </Tabs>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 p-5">
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

          <div className="flex flex-col gap-1.5">
            <div className="flex gap-3">
              {/* Cancel Button */}
              <Button variant="default" onClick={handleClose} className="shrink-0">
                Cancel
              </Button>

              {activeTab === 'generator' ? (
                generatorCost > 0 ? (
                  <BuzzTransactionButton
                    className="flex-1"
                    buzzAmount={generatorCost}
                    onPerformTransaction={handleGeneratorSubmit}
                    loading={isImporting || !!autoSubmit}
                    disabled={generatorEntryCount === 0}
                    label={entriesLabel(generatorEntryCount)}
                    exactAccountTypes={buzzType ? [buzzType] : undefined}
                    showPurchaseModal
                  />
                ) : (
                  <Button
                    className="flex-1"
                    onClick={handleGeneratorSubmit}
                    loading={isImporting || !!autoSubmit}
                    disabled={generatorEntryCount === 0}
                    leftSection={<IconSparkles size={16} />}
                  >
                    {entriesLabel(generatorEntryCount)}
                  </Button>
                )
              ) : totalCost > 0 ? (
                <BuzzTransactionButton
                  className="flex-1"
                  buzzAmount={totalCost}
                  onPerformTransaction={handleSubmit}
                  loading={isSubmitting}
                  disabled={validSelectedCount === 0 || !canSubmitMore}
                  label={submitLabel}
                  exactAccountTypes={buzzType ? [buzzType] : undefined}
                  showPurchaseModal
                />
              ) : (
                <Button
                  className="flex-1"
                  onClick={handleSubmit}
                  loading={isSubmitting}
                  disabled={validSelectedCount === 0 || !canSubmitMore}
                  leftSection={<IconSend size={16} />}
                >
                  {submitLabel}
                </Button>
              )}
            </div>

            {entryFee > 0 && freeEntriesPerUser < entryLimit && (
              <div className="flex items-center justify-end gap-1">
                <CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={14} />
                <Text size="xs" c="dimmed">
                  {freeEntriesLabel ? `${freeEntriesLabel}, then ` : ''}
                  {entryFee.toLocaleString()} Buzz per entry
                </Text>
              </div>
            )}
            {freeEntriesPerUser >= entryLimit && (
              <Text size="xs" c="dimmed" ta="right">
                {freeEntriesLabel}
              </Text>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
